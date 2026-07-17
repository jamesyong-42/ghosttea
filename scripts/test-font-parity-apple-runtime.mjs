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

function jsonOutput(program, args) {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "ghosttea-font-runtime-"));
  const output = join(temporaryDirectory, "output.json");
  try {
    execute(program, [...args, "--json-output", output, "--quiet"]);
    return JSON.parse(readFileSync(output, "utf8"));
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

function requirePass(result, platform) {
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  if (result.status !== 0 || !output.includes("GHOSTTEA_FONT_PARITY_PASS")) {
    throw new Error(`${platform} font parity runtime failed:\n${output}`);
  }
  console.log(`${platform} bundled-font runtime parity passed.`);
}

function runMacOS() {
  execute("xcrun", [
    "swift",
    "test",
    "--disable-sandbox",
    "--package-path",
    join(root, "apple/GhostteaKit"),
    "--filter",
    "GhostteaFontProofTests",
  ]);
  console.log("macOS bundled-font runtime parity passed.");
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
      environment: { SIMCTL_CHILD_GHOSTTEA_FONT_PARITY_AUTOMATION: "1" },
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
      device.connectionProperties?.pairingState === "paired" &&
      device.connectionProperties?.tunnelState === "connected",
  );
  if (devices.length !== 1) throw new Error(`Expected one connected iPhone, found ${devices.length}.`);
  return devices[0];
}

function runDevice() {
  const device = connectedDevice();
  const derivedData = join(root, "native/build/ios-harness/signed-font-parity");
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
  const lock = jsonOutput("xcrun", ["devicectl", "device", "info", "lockState", "--device", device.identifier]).result;
  if (lock.passcodeRequired) throw new Error(`Unlock ${device.hardwareProperties.marketingName}.`);
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
      JSON.stringify({ GHOSTTEA_FONT_PARITY_AUTOMATION: "1" }),
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
if (runOnDevice || deviceOnly) runDevice();
