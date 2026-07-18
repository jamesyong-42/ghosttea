import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const developerDirectory = process.env.DEVELOPER_DIR ?? "/Applications/Xcode.app/Contents/Developer";
const project = join(root, "apple/GhostteaApp/GhostteaApp.xcodeproj");
const derivedData = join(root, "native/build/ios-app/multiscene-gate");
const app = join(derivedData, "Build/Products/Debug-iphonesimulator/Ghosttea.app");
const bundleIdentifier = "com.vibecook.Ghosttea";
const expectedMarker = "GHOSTTEA_MULTISCENE_PASS";
const environment = { ...process.env, DEVELOPER_DIR: developerDirectory };

function execute(program, args, options = {}) {
  const result = spawnSync(program, args, {
    cwd: root,
    env: options.environment ?? environment,
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
    let timedOut = false;
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
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, options.timeout);
    child.once("error", (error) => {
      clearTimeout(timer);
      rejectExecution(error);
    });
    child.once("close", (status, signal) => {
      clearTimeout(timer);
      if (timedOut) {
        rejectExecution(new Error(`Timed out waiting for ${expectedMarker}.`));
        return;
      }
      if (status !== 0) {
        rejectExecution(new Error(`${program} ${args.join(" ")} failed with status ${status ?? `signal ${signal}`}`));
        return;
      }
      resolveExecution({ stdout, stderr });
    });
  });
}

function findIPad() {
  const result = execute("xcrun", ["simctl", "list", "devices", "available", "--json"], {
    capture: true,
  });
  const devices = Object.values(JSON.parse(result.stdout).devices)
    .flat()
    .filter((device) => device.isAvailable && device.name.startsWith("iPad"));
  const requested = process.env.GHOSTTEA_IOS_SIMULATOR_ID;
  if (requested) {
    const device = devices.find((candidate) => candidate.udid === requested);
    if (!device) throw new Error(`Available iPad simulator ${requested} was not found.`);
    return device;
  }
  const device =
    devices.find((candidate) => candidate.state === "Booted") ??
    devices.find((candidate) => candidate.name.includes("Pro 13-inch")) ??
    devices[0];
  if (!device) throw new Error("No available iPad simulator is installed.");
  return device;
}

async function main() {
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    throw new Error("The iPad multi-scene gate requires Apple Silicon macOS.");
  }
  const device = findIPad();
  const bootedByRunner = device.state !== "Booted";
  if (bootedByRunner) {
    execute("xcrun", ["simctl", "boot", device.udid]);
  }
  try {
    execute("xcrun", ["simctl", "bootstatus", device.udid, "-b"], { timeout: 180_000 });
    execute("xcodebuild", [
      "-project",
      project,
      "-scheme",
      "Ghosttea",
      "-configuration",
      "Debug",
      "-quiet",
      "-destination",
      "generic/platform=iOS Simulator",
      "-derivedDataPath",
      derivedData,
      "ARCHS=arm64",
      "ONLY_ACTIVE_ARCH=YES",
      "CODE_SIGNING_ALLOWED=NO",
      "build",
    ]);
    if (!existsSync(app)) throw new Error(`Missing built application ${app}.`);
    execute("xcrun", ["simctl", "uninstall", device.udid, bundleIdentifier], {
      allowFailure: true,
    });
    execute("xcrun", ["simctl", "install", device.udid, app]);
    const launched = await executeStreaming(
      "xcrun",
      ["simctl", "launch", "--console-pty", "--terminate-running-process", device.udid, bundleIdentifier],
      {
        timeout: 300_000,
        environment: {
          ...environment,
          SIMCTL_CHILD_GHOSTTEA_AUTORUN_MULTISCENE: "1",
        },
      },
    );
    const output = `${launched.stdout}${launched.stderr}`;
    if (!output.includes(expectedMarker)) {
      throw new Error(`iPad app exited without required marker ${expectedMarker}.`);
    }
    console.log(`Verified ${expectedMarker} on ${device.name}.`);
  } finally {
    if (bootedByRunner) {
      execute("xcrun", ["simctl", "shutdown", device.udid], { allowFailure: true });
    }
  }
}

await main();
