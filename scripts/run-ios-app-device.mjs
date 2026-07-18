import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const developerDirectory = process.env.DEVELOPER_DIR ?? "/Applications/Xcode.app/Contents/Developer";
const project = join(root, "apple/GhostteaApp/GhostteaApp.xcodeproj");
const derivedData = join(root, "native/build/ios-app/signed");
const app = join(derivedData, "Build/Products/Debug-iphoneos/Ghosttea.app");
const bundleIdentifier = "com.vibecook.Ghosttea";
const tailscaleArtifact = resolve(root, "../p008/truffle/apple/Vendor/TailscaleKit.xcframework");
const environment = { ...process.env, DEVELOPER_DIR: developerDirectory };

function execute(program, args, options = {}) {
  const result = spawnSync(program, args, {
    cwd: root,
    env: environment,
    encoding: "utf8",
    stdio: options.capture ? "pipe" : "inherit",
    timeout: options.timeout,
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !options.allowFailure) {
    throw new Error(
      `${program} ${args.join(" ")} failed with status ${result.status}${
        options.capture ? `\n${result.stdout}${result.stderr}` : ""
      }`,
    );
  }
  return result;
}

function executeStreaming(program, args, options = {}) {
  return new Promise((resolveExecution, rejectExecution) => {
    const child = spawn(program, args, {
      cwd: root,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      process.stdout.write(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      process.stderr.write(chunk);
    });
    const timer = options.timeout ? setTimeout(() => child.kill("SIGTERM"), options.timeout) : undefined;
    child.once("error", (error) => {
      if (timer) clearTimeout(timer);
      rejectExecution(error);
    });
    child.once("close", (status, signal) => {
      if (timer) clearTimeout(timer);
      if (status !== 0) {
        rejectExecution(new Error(`${program} ${args.join(" ")} failed with status ${status ?? `signal ${signal}`}`));
        return;
      }
      resolveExecution({ status, stdout, stderr });
    });
  });
}

function developmentTeam() {
  if (process.env.GHOSTTEA_IOS_DEVELOPMENT_TEAM) return process.env.GHOSTTEA_IOS_DEVELOPMENT_TEAM;
  const result = execute("defaults", ["read", "com.apple.dt.Xcode", "IDEProvisioningTeamByIdentifier"], {
    capture: true,
    allowFailure: true,
  });
  const teams = [...new Set([...result.stdout.matchAll(/teamID = "?([A-Z0-9]+)"?;/g)].map((match) => match[1]))];
  if (teams.length === 1) return teams[0];
  throw new Error(
    `Could not choose one Xcode development team (found ${teams.length}). Set GHOSTTEA_IOS_DEVELOPMENT_TEAM.`,
  );
}

function withDeviceJSON(operation) {
  const directory = mkdtempSync(join(tmpdir(), "ghosttea-ios-app-device-"));
  const output = join(directory, "result.json");
  try {
    operation(output);
    return JSON.parse(readFileSync(output, "utf8"));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function findDevice() {
  const response = withDeviceJSON((output) =>
    execute("xcrun", ["devicectl", "list", "devices", "--json-output", output, "--quiet"]),
  );
  const devices = response.result.devices.filter(
    (device) =>
      device.hardwareProperties?.platform === "iOS" &&
      device.hardwareProperties?.reality === "physical" &&
      device.connectionProperties?.pairingState === "paired",
  );
  const requested = process.env.GHOSTTEA_IOS_DEVICE_ID;
  if (requested) {
    const device = devices.find(
      (candidate) => candidate.identifier === requested || candidate.hardwareProperties?.udid === requested,
    );
    if (!device) throw new Error(`Connected iOS device ${requested} was not found.`);
    return device;
  }
  if (devices.length !== 1) {
    throw new Error(`Expected one connected physical iOS device, found ${devices.length}.`);
  }
  return devices[0];
}

function deviceIsUnlocked(device) {
  const response = withDeviceJSON((output) =>
    execute("xcrun", [
      "devicectl",
      "device",
      "info",
      "lockState",
      "--device",
      device.identifier,
      "--json-output",
      output,
      "--quiet",
    ]),
  );
  return !response.result.passcodeRequired;
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

async function waitForUnlockedDevice(device) {
  if (deviceIsUnlocked(device)) return;
  console.log(`Unlock ${device.hardwareProperties.marketingName}; continuing automatically…`);
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    await delay(1_000);
    if (deviceIsUnlocked(device)) return;
  }
  throw new Error(`Timed out waiting for ${device.hardwareProperties.marketingName} to be unlocked.`);
}

async function main() {
  if (!existsSync(tailscaleArtifact)) {
    throw new Error(`Missing ${tailscaleArtifact}; run p008/truffle/apple/scripts/materialize-tailscalekit.sh first.`);
  }
  const team = developmentTeam();
  const device = findDevice();
  await waitForUnlockedDevice(device);

  execute("xcodebuild", [
    "-project",
    project,
    "-scheme",
    "Ghosttea",
    "-allowProvisioningUpdates",
    "-configuration",
    "Debug",
    "-quiet",
    "-destination",
    `id=${device.hardwareProperties.udid}`,
    "-derivedDataPath",
    derivedData,
    `DEVELOPMENT_TEAM=${team}`,
    "CODE_SIGN_STYLE=Automatic",
    "build",
  ]);
  await waitForUnlockedDevice(device);
  execute("xcrun", ["devicectl", "device", "install", "app", "--device", device.identifier, app]);
  await waitForUnlockedDevice(device);
  const expectedMarker = process.env.GHOSTTEA_IOS_EXPECT_MARKER;
  const launchArguments = [
    "devicectl",
    "device",
    "process",
    "launch",
    "--device",
    device.identifier,
    "--terminate-existing",
    ...(process.env.GHOSTTEA_IOS_CONSOLE === "1" ? ["--console"] : []),
    bundleIdentifier,
  ];
  const launched = expectedMarker
    ? await executeStreaming("xcrun", launchArguments, { timeout: 180_000 })
    : execute("xcrun", launchArguments);
  if (expectedMarker) {
    const output = `${launched.stdout}${launched.stderr}`;
    if (!output.includes(expectedMarker)) {
      throw new Error(`Signed iOS app exited without required marker ${expectedMarker}.`);
    }
    console.log(`Verified signed iOS app marker ${expectedMarker}.`);
  }
  console.log(
    `${process.env.GHOSTTEA_IOS_CONSOLE === "1" ? "Ghosttea exited on" : "Launched Ghosttea on"} ${device.hardwareProperties.marketingName}.`,
  );
}

await main();
