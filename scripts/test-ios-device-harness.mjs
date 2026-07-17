import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const developerDirectory = process.env.DEVELOPER_DIR ?? "/Applications/Xcode.app/Contents/Developer";
const environment = {
  ...process.env,
  DEVELOPER_DIR: developerDirectory,
  CLANG_MODULE_CACHE_PATH: join(root, "native/build/ios-harness/device-module-cache"),
};
const fixtureScript = join(root, "scripts/ssh-fixture.mjs");
const project = join(root, "apple/GhostteaHarness/GhostteaHarness.xcodeproj");
const derivedData = join(root, "native/build/ios-harness/signed-automated");
const app = join(derivedData, "Build/Products/Debug-iphoneos/GhostteaHarness.app");
const bundleIdentifier = "com.vibecook.GhostteaHarness";
let fixtureStarted = false;

function execute(program, args, options = {}) {
  const result = spawnSync(program, args, {
    cwd: root,
    env: { ...environment, ...options.environment },
    encoding: "utf8",
    stdio: options.capture ? "pipe" : "inherit",
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

function capture(program, args) {
  return execute(program, args, { capture: true }).stdout.trim();
}

function findDevice() {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "ghosttea-ios-device-"));
  const output = join(temporaryDirectory, "devices.json");
  try {
    execute("xcrun", ["devicectl", "list", "devices", "--json-output", output, "--quiet"]);
    const devices = JSON.parse(readFileSync(output, "utf8")).result.devices.filter(
      (device) =>
        device.hardwareProperties?.platform === "iOS" &&
        device.hardwareProperties?.reality === "physical" &&
        device.connectionProperties?.pairingState === "paired" &&
        device.connectionProperties?.tunnelState === "connected",
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
      throw new Error(
        `Expected one connected physical iOS device, found ${devices.length}. Set GHOSTTEA_IOS_DEVICE_ID.`,
      );
    }
    return devices[0];
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

function deviceIsUnlocked(device) {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "ghosttea-ios-lock-"));
  const output = join(temporaryDirectory, "lock-state.json");
  try {
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
    ]);
    const lockState = JSON.parse(readFileSync(output, "utf8")).result;
    return !lockState.passcodeRequired;
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

async function waitForUnlockedDevice(device, failImmediately = false) {
  if (deviceIsUnlocked(device)) return;
  if (failImmediately) {
    throw new Error(`Unlock ${device.hardwareProperties.marketingName} before running the device harness.`);
  }
  console.log(`\nUnlock ${device.hardwareProperties.marketingName}; launch will continue automatically…`);
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    await delay(1_000);
    if (deviceIsUnlocked(device)) return;
  }
  throw new Error(`Timed out waiting for ${device.hardwareProperties.marketingName} to be unlocked.`);
}

function stopFixture() {
  if (!fixtureStarted) return;
  console.log("Stopping disposable SSH fixture…");
  execute(process.execPath, [fixtureScript, "down"], { allowFailure: true });
  fixtureStarted = false;
}

async function waitForCleanupRequest() {
  console.log("\nThe fixture remains active only while this command is running.");
  console.log("Use the in-app Automated lifecycle probes, then press Return or Ctrl-C here to clean up.");
  await new Promise((resolveWait) => {
    const finish = () => {
      process.off("SIGINT", finish);
      process.off("SIGTERM", finish);
      process.stdin.off("data", finish);
      process.stdin.pause();
      resolveWait();
    };
    process.once("SIGINT", finish);
    process.once("SIGTERM", finish);
    process.stdin.once("data", finish);
    process.stdin.resume();
  });
}

async function main() {
  const team = process.env.GHOSTTEA_IOS_DEVELOPMENT_TEAM;
  if (!team) {
    throw new Error(
      "Set GHOSTTEA_IOS_DEVELOPMENT_TEAM to the Apple development-team identifier used to sign the harness.",
    );
  }

  const device = findDevice();
  await waitForUnlockedDevice(device, true);
  const host = process.env.GHOSTTEA_IOS_FIXTURE_HOST ?? capture("ipconfig", ["getifaddr", "en0"]);
  if (!host) throw new Error("Could not determine the Mac Wi-Fi address; set GHOSTTEA_IOS_FIXTURE_HOST.");

  try {
    execute("xcrun", ["swift", "test", "--package-path", join(root, "apple/GhostteaKit")]);
    execute("npm", ["run", "test:ios:harness"]);
    execute("xcodebuild", [
      "-project",
      project,
      "-scheme",
      "GhostteaHarness",
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
    execute(process.execPath, [fixtureScript, "down"], { allowFailure: true });
    execute(process.execPath, [fixtureScript, "device-up"]);
    fixtureStarted = true;
    execute("xcrun", ["devicectl", "device", "install", "app", "--device", device.identifier, app]);
    await waitForUnlockedDevice(device);
    execute("xcrun", [
      "devicectl",
      "device",
      "process",
      "launch",
      "--device",
      device.identifier,
      "--terminate-existing",
      "--environment-variables",
      JSON.stringify({ GHOSTTEA_FIXTURE_HOST: host }),
      bundleIdentifier,
    ]);

    console.log(`\nLaunched on ${device.hardwareProperties.marketingName} with disposable fixture ${host}:22022.`);
    await waitForCleanupRequest();
  } finally {
    stopFixture();
  }
}

try {
  await main();
} catch (error) {
  console.error(`iOS device harness failed: ${error.message}`);
  process.exitCode = 1;
}
