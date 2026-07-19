import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const developerDirectory = process.env.DEVELOPER_DIR ?? "/Applications/Xcode.app/Contents/Developer";
const project = join(root, "apple/GhostteaApp/GhostteaApp.xcodeproj");
const derivedData = join(root, "native/build/ios-app/signed");
const app = join(derivedData, "Build/Products/Debug-iphoneos/Ghosttea.app");
const appExecutable = join(app, "Ghosttea");
const appLogicBinary = join(app, "Ghosttea.debug.dylib");
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
      env: options.environment ?? environment,
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

function executeStreamingUntilMarker(program, args, marker, options = {}) {
  return new Promise((resolveExecution, rejectExecution) => {
    const child = spawn(program, args, {
      cwd: root,
      env: options.environment ?? environment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let matched = false;
    const receive = (chunk, destination) => {
      output += chunk;
      destination.write(chunk);
      if (!matched && output.includes(marker)) {
        matched = true;
        options.onMarker?.();
      }
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => receive(chunk, process.stdout));
    child.stderr.on("data", (chunk) => receive(chunk, process.stderr));
    const timer = setTimeout(() => {
      options.onTimeout?.();
      child.kill("SIGTERM");
    }, options.timeout ?? 180_000);
    child.once("error", (error) => {
      clearTimeout(timer);
      rejectExecution(error);
    });
    child.once("close", (status, signal) => {
      clearTimeout(timer);
      if (!matched) {
        rejectExecution(
          new Error(
            `${program} ${args.join(" ")} exited before marker ${marker} with status ${status ?? `signal ${signal}`}`,
          ),
        );
        return;
      }
      resolveExecution({ status, output });
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
  try {
    const response = withDeviceJSON((output) =>
      execute(
        "xcrun",
        ["devicectl", "device", "info", "lockState", "--device", device.identifier, "--json-output", output, "--quiet"],
        { capture: true, allowFailure: true },
      ),
    );
    return !response.result.passcodeRequired;
  } catch {
    return false;
  }
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

function launchArguments(device) {
  return [
    "devicectl",
    "device",
    "process",
    "launch",
    "--device",
    device.identifier,
    "--terminate-existing",
    "--console",
    bundleIdentifier,
  ];
}

function terminateApp(device) {
  const processes = withDeviceJSON((output) =>
    execute("xcrun", [
      "devicectl",
      "device",
      "info",
      "processes",
      "--device",
      device.identifier,
      "--json-output",
      output,
      "--quiet",
    ]),
  ).result.runningProcesses;
  for (const process of processes) {
    if (!process.executable?.includes("/Ghosttea.app/Ghosttea")) continue;
    execute(
      "xcrun",
      [
        "devicectl",
        "device",
        "process",
        "terminate",
        "--device",
        device.identifier,
        "--pid",
        String(process.processIdentifier),
      ],
      { allowFailure: true },
    );
  }
}

function tryTerminateApp(device) {
  try {
    terminateApp(device);
  } catch {
    // A disconnected device has no reachable process to clean up.
  }
}

async function runProcessRestoration(device) {
  const runID = randomBytes(16).toString("hex");
  const baseEnvironment = cleanLifecycleAutomationEnvironment();
  const prepareEnvironment = {
    ...baseEnvironment,
    DEVICECTL_CHILD_GHOSTTEA_AUTORUN_PROCESS_RESTORATION_PREPARE: "1",
    DEVICECTL_CHILD_GHOSTTEA_PROCESS_RESTORATION_RUN_ID: runID,
  };
  const verifyEnvironment = {
    ...baseEnvironment,
    DEVICECTL_CHILD_GHOSTTEA_AUTORUN_PROCESS_RESTORATION_VERIFY: "1",
    DEVICECTL_CHILD_GHOSTTEA_PROCESS_RESTORATION_RUN_ID: runID,
  };

  try {
    await executeStreamingUntilMarker("xcrun", launchArguments(device), "GHOSTTEA_PROCESS_RESTORATION_PREPARED", {
      environment: prepareEnvironment,
      onMarker: () => tryTerminateApp(device),
      onTimeout: () => tryTerminateApp(device),
    });
    await delay(500);
    const verified = await executeStreaming("xcrun", launchArguments(device), {
      environment: verifyEnvironment,
      timeout: 180_000,
    });
    if (!`${verified.stdout}${verified.stderr}`.includes("GHOSTTEA_PROCESS_RESTORATION_PASS")) {
      throw new Error("Signed iOS app exited without the process-restoration pass marker.");
    }
  } finally {
    tryTerminateApp(device);
  }
}

async function runMemoryRecovery(device) {
  const runID = randomBytes(16).toString("hex");
  const launchEnvironment = {
    ...cleanLifecycleAutomationEnvironment(),
    DEVICECTL_CHILD_GHOSTTEA_AUTORUN_MEMORY_RECOVERY: "1",
    DEVICECTL_CHILD_GHOSTTEA_MEMORY_RECOVERY_RUN_ID: runID,
  };

  try {
    const execution = await executeStreaming("xcrun", launchArguments(device), {
      environment: launchEnvironment,
      timeout: 180_000,
    });
    const output = `${execution.stdout}${execution.stderr}`;
    const match = output.match(
      /GHOSTTEA_MEMORY_RECOVERY_PASS before=(\d+) after=(\d+) evicted=(\d+) tier=(compact|standard)/,
    );
    if (!match) throw new Error("Signed iOS app exited without the memory-recovery pass marker.");

    const [, beforeText, afterText, evictedText, tier] = match;
    const beforeBytes = Number(beforeText);
    const afterBytes = Number(afterText);
    const evictedCount = Number(evictedText);
    const mebibyte = 1_048_576;
    const softBytes = (tier === "compact" ? 96 : 160) * mebibyte;
    const hardBytes = (tier === "compact" ? 128 : 224) * mebibyte;
    if (
      !Number.isSafeInteger(beforeBytes) ||
      !Number.isSafeInteger(afterBytes) ||
      !Number.isSafeInteger(evictedCount) ||
      beforeBytes <= softBytes ||
      beforeBytes >= hardBytes ||
      afterBytes > softBytes ||
      afterBytes >= beforeBytes ||
      evictedCount < 1 ||
      evictedCount > 4
    ) {
      throw new Error("Memory-recovery marker did not satisfy the host-side tier contract.");
    }

    const gitRevision = execute("git", ["rev-parse", "HEAD"], { capture: true }).stdout.trim();
    const gitStatus = execute("git", ["status", "--porcelain"], { capture: true }).stdout.trim();
    const evidenceDirectory = join(root, "native/build/ios-memory-recovery");
    mkdirSync(evidenceDirectory, { recursive: true });
    writeFileSync(
      join(evidenceDirectory, "evidence.json"),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          status: "passed",
          sourceRevision: gitRevision,
          sourceClean: gitStatus === "",
          appExecutableSha256: createHash("sha256").update(readFileSync(appExecutable)).digest("hex"),
          appLogicSha256: createHash("sha256").update(readFileSync(appLogicBinary)).digest("hex"),
          device: {
            modelIdentifier: device.hardwareProperties.productType,
            systemVersion: device.deviceProperties.osVersionNumber,
          },
          policy: { tier, softBytes, hardBytes },
          result: { beforeBytes, afterBytes, evictedCount },
          assertions: {
            productionMemoryWarningPath: true,
            hiddenLRUOrder: true,
            selectedSessionProtected: true,
            workspacePreserved: true,
            sessionsDemandPaused: true,
            protectedSecretFreePersistence: true,
          },
        },
        null,
        2,
      )}\n`,
    );
    console.log(
      `Verified signed iOS memory recovery: ${formatMiB(beforeBytes)} -> ${formatMiB(afterBytes)}, ${evictedCount} hidden session(s) evicted.`,
    );
  } finally {
    tryTerminateApp(device);
  }
}

function cleanLifecycleAutomationEnvironment() {
  const result = { ...environment };
  for (const name of [
    "DEVICECTL_CHILD_GHOSTTEA_AUTORUN_PROCESS_RESTORATION_PREPARE",
    "DEVICECTL_CHILD_GHOSTTEA_AUTORUN_PROCESS_RESTORATION_VERIFY",
    "DEVICECTL_CHILD_GHOSTTEA_PROCESS_RESTORATION_RUN_ID",
    "DEVICECTL_CHILD_GHOSTTEA_AUTORUN_MEMORY_RECOVERY",
    "DEVICECTL_CHILD_GHOSTTEA_MEMORY_RECOVERY_RUN_ID",
  ]) {
    delete result[name];
  }
  return result;
}

function formatMiB(bytes) {
  return `${(bytes / 1_048_576).toFixed(1)} MiB`;
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
  if (process.argv.includes("--process-restoration")) {
    await runProcessRestoration(device);
    console.log("Verified abrupt process-death workspace restoration on the signed iOS app.");
    return;
  }
  if (process.argv.includes("--memory-recovery")) {
    await runMemoryRecovery(device);
    return;
  }
  const expectedMarker = process.env.GHOSTTEA_IOS_EXPECT_MARKER;
  const ordinaryLaunchArguments = [
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
    ? await executeStreaming("xcrun", ordinaryLaunchArguments, { timeout: 180_000 })
    : execute("xcrun", ordinaryLaunchArguments);
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
