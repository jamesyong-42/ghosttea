import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const developerDir = process.env.DEVELOPER_DIR ?? "/Applications/Xcode.app/Contents/Developer";
const moduleCache = join(root, "native/build/ios-harness/runtime-module-cache");
const environment = {
  ...process.env,
  DEVELOPER_DIR: developerDir,
  CLANG_MODULE_CACHE_PATH: moduleCache,
  SWIFTPM_MODULECACHE_OVERRIDE: moduleCache,
};
const bundleIdentifier = "com.vibecook.GhostteaHarness";
const project = join(root, "apple/GhostteaHarness/GhostteaHarness.xcodeproj");
const runOnDevice = process.argv.includes("--device");
const deviceOnly = process.argv.includes("--device-only");
const skipBuild = process.argv.includes("--skip-build");
const coreMode = process.argv.includes("--core");
const marker = coreMode ? "GHOSTTEA_CORE_PASS" : "GHOSTTEA_FONT_PARITY_PASS";
const automationVariable = coreMode ? "GHOSTTEA_CORE_AUTOMATION" : "GHOSTTEA_FONT_PARITY_AUTOMATION";
const testFilter = coreMode ? "GhostteaCoreTests" : "GhostteaFontProofTests";
const checkName = coreMode ? "production core ABI" : "bundled-font runtime parity";

function execute(program, args, options = {}) {
  const result = spawnSync(program, args, {
    cwd: root,
    env: { ...environment, ...options.environment },
    encoding: "utf8",
    stdio: options.capture ? "pipe" : "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !options.allowFailure) {
    throw new Error(`${program} ${args.join(" ")} failed:\n${result.stdout ?? ""}${result.stderr ?? ""}`);
  }
  return result;
}

function jsonOutput(program, args, options = {}) {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "ghosttea-font-runtime-"));
  const output = join(temporaryDirectory, "output.json");
  try {
    const result = execute(program, [...args, "--json-output", output, "--quiet"], {
      allowFailure: options.allowFailure,
      capture: options.allowFailure,
    });
    if (result.status !== 0) return undefined;
    return JSON.parse(readFileSync(output, "utf8"));
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

function requirePass(result, platform) {
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  if (result.status !== 0 || !output.includes(marker)) {
    throw new Error(`${platform} ${checkName} failed:\n${output}`);
  }
  console.log(`${platform} ${checkName} passed.`);
}

function runMacOS() {
  execute("xcrun", [
    "swift",
    "test",
    "--disable-sandbox",
    "--package-path",
    join(root, "apple/GhostteaKit"),
    "--filter",
    testFilter,
  ]);
  console.log(`macOS ${checkName} passed.`);
}

function runSimulator() {
  const devices = JSON.parse(
    execute("xcrun", ["simctl", "list", "devices", "available", "--json"], { capture: true }).stdout,
  ).devices;
  const candidates = Object.values(devices)
    .flat()
    .filter((device) => device.isAvailable && device.name.includes("iPhone"));
  const simulator = candidates.find((device) => device.state === "Booted") ?? candidates[0];
  if (!simulator) throw new Error("No available iPhone simulator runtime was found.");
  if (simulator.state !== "Booted") execute("xcrun", ["simctl", "boot", simulator.udid]);
  execute("xcrun", ["simctl", "bootstatus", simulator.udid, "-b"]);
  const app = join(root, "native/build/ios-harness/simulator/Build/Products/Debug-iphonesimulator/GhostteaHarness.app");
  execute("xcrun", ["simctl", "install", simulator.udid, app]);
  const result = execute(
    "xcrun",
    ["simctl", "launch", "--console", "--terminate-running-process", simulator.udid, bundleIdentifier],
    {
      capture: true,
      allowFailure: true,
      environment: { [`SIMCTL_CHILD_${automationVariable}`]: "1" },
    },
  );
  requirePass(result, `${simulator.name} simulator`);
}

function developmentTeam() {
  if (process.env.GHOSTTEA_IOS_DEVELOPMENT_TEAM) return process.env.GHOSTTEA_IOS_DEVELOPMENT_TEAM;
  const result = execute("defaults", ["read", "com.apple.dt.Xcode", "IDEProvisioningTeamByIdentifier"], {
    capture: true,
    allowFailure: true,
  });
  const teams = [...new Set([...result.stdout.matchAll(/teamID = "?([A-Z0-9]+)"?;/g)].map((match) => match[1]))];
  if (teams.length === 1) return teams[0];
  throw new Error("Set GHOSTTEA_IOS_DEVELOPMENT_TEAM to the Xcode signing team ID.");
}

function connectedDevice() {
  const response = jsonOutput("xcrun", ["devicectl", "list", "devices"]);
  const devices = response.result.devices.filter(
    (device) =>
      device.hardwareProperties?.platform === "iOS" &&
      device.hardwareProperties?.reality === "physical" &&
      device.connectionProperties?.pairingState === "paired",
  );
  if (devices.length !== 1) throw new Error(`Expected one connected iPhone, found ${devices.length}.`);
  return devices[0];
}

function deviceIsUnlocked(device) {
  const response = jsonOutput(
    "xcrun",
    ["devicectl", "device", "info", "lockState", "--device", device.identifier],
    { allowFailure: true },
  );
  // CoreDevice can briefly release its tunnel/resource while the phone is
  // locking or unlocking. Treat that as unavailable and retry until the same
  // deadline instead of failing a deterministic device gate.
  return response ? !response.result.passcodeRequired : false;
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

async function waitForUnlockedDevice(device) {
  if (deviceIsUnlocked(device)) return;
  console.log(`Unlock ${device.hardwareProperties.marketingName}; launch will continue automatically…`);
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    await delay(1_000);
    if (deviceIsUnlocked(device)) return;
  }
  throw new Error(`Timed out waiting for ${device.hardwareProperties.marketingName} to be unlocked.`);
}

async function runDevice() {
  const device = connectedDevice();
  const derivedData = join(root, "native/build/ios-harness/signed-runtime-check");
  execute("xcodebuild", [
    "-project",
    project,
    "-scheme",
    "GhostteaHarness",
    "-allowProvisioningUpdates",
    "-configuration",
    "Debug",
    "-quiet",
    "-destination",
    `id=${device.hardwareProperties.udid}`,
    "-derivedDataPath",
    derivedData,
    `DEVELOPMENT_TEAM=${developmentTeam()}`,
    "CODE_SIGN_STYLE=Automatic",
    "build",
  ]);
  await waitForUnlockedDevice(device);
  const app = join(derivedData, "Build/Products/Debug-iphoneos/GhostteaHarness.app");
  execute("xcrun", ["devicectl", "device", "install", "app", "--device", device.identifier, app]);
  const result = execute(
    "xcrun",
    [
      "devicectl",
      "device",
      "process",
      "launch",
      "--device",
      device.identifier,
      "--terminate-existing",
      "--console",
      "--timeout",
      "30",
      "--environment-variables",
      JSON.stringify({ [automationVariable]: "1" }),
      bundleIdentifier,
    ],
    { capture: true, allowFailure: true },
  );
  requirePass(result, device.hardwareProperties.marketingName);
}

if (!skipBuild) execute("npm", ["run", "test:ios:harness"]);
if (!deviceOnly) {
  runMacOS();
  runSimulator();
}
if (runOnDevice || deviceOnly) await runDevice();
