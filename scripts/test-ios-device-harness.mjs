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
  SWIFTPM_MODULECACHE_OVERRIDE: join(root, "native/build/ios-harness/device-module-cache"),
};
const fixtureScript = join(root, "scripts/ssh-fixture.mjs");
const project = join(root, "apple/GhostteaHarness/GhostteaHarness.xcodeproj");
const derivedData = join(root, "native/build/ios-harness/signed-automated");
const app = join(derivedData, "Build/Products/Debug-iphoneos/GhostteaHarness.app");
const bundleIdentifier = "com.vibecook.GhostteaHarness";
let fixtureStarted = false;
const productionTmuxAutomation = process.argv.includes("--production-tmux");
const productionVimAutomation = process.argv.includes("--production-vim");
const productionZellijAutomation = process.argv.includes("--production-zellij");
const productionMonitorTuisAutomation = process.argv.includes("--production-monitor-tuis");
const productionClaudeAutomation = process.argv.includes("--production-claude");
const productionWorkspaceAutomation = process.argv.includes("--production-workspace");
const productionSessionAutomation =
  process.argv.includes("--production-session") ||
  productionWorkspaceAutomation ||
  productionTmuxAutomation ||
  productionVimAutomation ||
  productionZellijAutomation ||
  productionMonitorTuisAutomation ||
  productionClaudeAutomation;

function execute(program, args, options = {}) {
  const result = spawnSync(program, args, {
    cwd: root,
    env: { ...environment, ...options.environment },
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

function capture(program, args) {
  return execute(program, args, { capture: true }).stdout.trim();
}

function fixtureHost() {
  if (process.env.GHOSTTEA_IOS_FIXTURE_HOST) {
    return process.env.GHOSTTEA_IOS_FIXTURE_HOST;
  }
  const localHostname = capture("scutil", ["--get", "LocalHostName"]);
  if (!localHostname) {
    throw new Error("Could not determine the Mac Bonjour hostname; set GHOSTTEA_IOS_FIXTURE_HOST.");
  }
  return `${localHostname}.local.`;
}

function developmentTeam() {
  if (process.env.GHOSTTEA_IOS_DEVELOPMENT_TEAM) {
    return process.env.GHOSTTEA_IOS_DEVELOPMENT_TEAM;
  }
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

function findDevice() {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "ghosttea-ios-device-"));
  const output = join(temporaryDirectory, "devices.json");
  try {
    execute("xcrun", ["devicectl", "list", "devices", "--json-output", output, "--quiet"]);
    const devices = JSON.parse(readFileSync(output, "utf8")).result.devices.filter(
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
  const team = developmentTeam();
  const device = findDevice();
  await waitForUnlockedDevice(device, true);
  const host = fixtureHost();

  try {
    execute("xcrun", ["swift", "test", "--disable-sandbox", "--package-path", join(root, "apple/GhostteaKit")]);
    execute("npm", ["run", "test:ios:harness"]);
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
    const launchArguments = [
      "devicectl",
      "device",
      "process",
      "launch",
      "--device",
      device.identifier,
      "--terminate-existing",
    ];
    if (productionSessionAutomation) launchArguments.push("--console");
    launchArguments.push(
      "--environment-variables",
      JSON.stringify({
        ...(productionSessionAutomation
          ? {
              GHOSTTEA_AUTORUN_PRODUCTION_SESSION: "1",
              ...(productionWorkspaceAutomation ? { GHOSTTEA_AUTORUN_PRODUCTION_WORKSPACE: "1" } : {}),
              ...(productionTmuxAutomation ? { GHOSTTEA_PRODUCTION_PROFILE: "tmux" } : {}),
              ...(productionVimAutomation ? { GHOSTTEA_PRODUCTION_PROFILE: "vim" } : {}),
              ...(productionZellijAutomation ? { GHOSTTEA_PRODUCTION_PROFILE: "zellij" } : {}),
              ...(productionMonitorTuisAutomation ? { GHOSTTEA_PRODUCTION_PROFILE: "monitor-tuis" } : {}),
              ...(productionClaudeAutomation ? { GHOSTTEA_PRODUCTION_PROFILE: "claude" } : {}),
            }
          : {
              GHOSTTEA_AUTORUN_MEMORY_GATE: "1",
              GHOSTTEA_AUTORUN_ACTIVE_SSH_MEMORY_GATE: "1",
            }),
        GHOSTTEA_FIXTURE_HOST: host,
      }),
      bundleIdentifier,
    );
    execute("xcrun", launchArguments, {
      timeout: productionSessionAutomation ? 120_000 : undefined,
    });

    console.log(`\nLaunched on ${device.hardwareProperties.marketingName} with disposable fixture ${host}:22022.`);
    if (productionSessionAutomation) {
      console.log(
        productionWorkspaceAutomation
          ? "Production workspace persistence, 3-session allocation, and teardown device gate passed."
          : productionTmuxAutomation
            ? "Production tmux attach/input/resize device gate passed."
            : productionVimAutomation
              ? "Production Vim render/input/resize device gate passed."
              : productionZellijAutomation
                ? "Production Zellij attach/input/resize device gate passed."
                : productionMonitorTuisAutomation
                  ? "Production htop/btop render/input/resize device gate passed."
                  : productionClaudeAutomation
                    ? "Production Claude Code prompt/interrupt/shortcuts/resize device gate passed."
                    : "Production SSH → core → TRF1 device gate passed.",
      );
    } else {
      await waitForCleanupRequest();
    }
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
