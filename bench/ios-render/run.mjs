#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { median } from "../render/lib/compare.mjs";

const root = resolve(import.meta.dirname, "../..");
const developerDirectory = process.env.DEVELOPER_DIR ?? "/Applications/Xcode.app/Contents/Developer";
const baseEnvironment = {
  ...process.env,
  DEVELOPER_DIR: developerDirectory,
  CLANG_MODULE_CACHE_PATH: join(root, "native/build/ios-render-benchmark/module-cache"),
  SWIFTPM_MODULECACHE_OVERRIDE: join(root, "native/build/ios-render-benchmark/module-cache"),
};
const defaults = [
  "repaint-1",
  "cursor-1",
  "typing-1",
  "sparse-1",
  "scroll-1",
  "dense-1",
  "truecolor-1",
  "doom-fire-1",
  "unicode-1",
  "scroll-4",
  "scroll-8",
  "resize-jitter-1",
];

function parseArgs(argv) {
  const options = {
    output: resolve(root, "bench/ios-render/results.json"),
    iterations: 5,
    warmup: 1,
    cooldownMs: 250,
    scale: 1,
    cases: defaults,
    build: true,
    allowUntracked: [],
    geometryReuse: true,
    inPlaceRetainedStateCommit: true,
    incrementalAccessibility: true,
    stateCodec: "json",
  };
  for (const argument of argv) {
    if (argument.startsWith("--output=")) options.output = resolve(root, argument.slice(9));
    else if (argument.startsWith("--iterations=")) options.iterations = Number(argument.slice(13));
    else if (argument.startsWith("--warmup=")) options.warmup = Number(argument.slice(9));
    else if (argument.startsWith("--cooldown-ms=")) options.cooldownMs = Number(argument.slice(14));
    else if (argument.startsWith("--scale=")) options.scale = Number(argument.slice(8));
    else if (argument.startsWith("--cases=")) options.cases = argument.slice(8).split(",").filter(Boolean);
    else if (argument.startsWith("--allow-untracked=")) {
      options.allowUntracked = argument.slice(18).split(",").filter(Boolean);
    } else if (argument.startsWith("--geometry-reuse=")) {
      const value = argument.slice(17);
      if (value !== "on" && value !== "off") throw new Error("--geometry-reuse must be on or off");
      options.geometryReuse = value === "on";
    } else if (argument.startsWith("--state-codec=")) {
      options.stateCodec = argument.slice(14);
      if (!["json", "compact-json-v1"].includes(options.stateCodec)) {
        throw new Error("--state-codec must be json or compact-json-v1");
      }
    } else if (argument.startsWith("--retained-state-commit=")) {
      const value = argument.slice(24);
      if (value !== "in-place" && value !== "copy") {
        throw new Error("--retained-state-commit must be in-place or copy");
      }
      options.inPlaceRetainedStateCommit = value === "in-place";
    } else if (argument.startsWith("--incremental-accessibility=")) {
      const value = argument.slice(28);
      if (value !== "on" && value !== "off") {
        throw new Error("--incremental-accessibility must be on or off");
      }
      options.incrementalAccessibility = value === "on";
    } else if (argument === "--no-build") options.build = false;
    else if (argument === "--help" || argument === "-h") options.help = true;
  }
  return options;
}

function execute(program, args, options = {}) {
  const result = spawnSync(program, args, {
    cwd: root,
    env: { ...baseEnvironment, ...options.environment },
    encoding: "utf8",
    stdio: options.capture ? "pipe" : "inherit",
    timeout: options.timeout,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !options.allowFailure) {
    throw new Error(
      `${program} ${args.join(" ")} failed with status ${result.status}${options.capture ? `\n${result.stdout}${result.stderr}` : ""}`,
    );
  }
  return result;
}

function capture(program, args) {
  return execute(program, args, { capture: true }).stdout.trim();
}

function developmentTeam() {
  if (process.env.GHOSTTEA_IOS_DEVELOPMENT_TEAM) return process.env.GHOSTTEA_IOS_DEVELOPMENT_TEAM;
  const result = execute("defaults", ["read", "com.apple.dt.Xcode", "IDEProvisioningTeamByIdentifier"], {
    capture: true,
    allowFailure: true,
  });
  const teams = [...new Set([...result.stdout.matchAll(/teamID = "?([A-Z0-9]+)"?;/g)].map((match) => match[1]))];
  if (teams.length === 1) return teams[0];
  throw new Error(`Could not choose one Xcode development team (found ${teams.length}).`);
}

function findDevice() {
  const temporary = mkdtempSync(join(tmpdir(), "ghosttea-ios-render-device-"));
  const output = join(temporary, "devices.json");
  try {
    execute("xcrun", ["devicectl", "list", "devices", "--json-output", output, "--quiet"]);
    const pairedDevices = JSON.parse(readFileSync(output, "utf8")).result.devices.filter(
      (device) =>
        device.hardwareProperties?.platform === "iOS" &&
        device.hardwareProperties?.reality === "physical" &&
        device.connectionProperties?.pairingState === "paired",
    );
    // Wired devices can be usable while CoreDevice reports an initially
    // disconnected tunnel. devicectl establishes the service connection on
    // demand; only the explicit unavailable state should exclude the device.
    const devices = pairedDevices.filter(
      (device) =>
        device.deviceProperties?.bootState === "booted" && device.connectionProperties?.tunnelState !== "unavailable",
    );
    const requested = process.env.GHOSTTEA_IOS_DEVICE_ID;
    if (requested) {
      const device = devices.find(
        (candidate) => candidate.identifier === requested || candidate.hardwareProperties?.udid === requested,
      );
      if (!device) {
        const paired = pairedDevices.some(
          (candidate) => candidate.identifier === requested || candidate.hardwareProperties?.udid === requested,
        );
        throw new Error(
          paired
            ? `Paired iOS device ${requested} is unavailable; connect it before running the benchmark.`
            : `Connected iOS device ${requested} was not found.`,
        );
      }
      return device;
    }
    if (devices.length !== 1) {
      throw new Error(
        `Expected one connected physical iOS device, found ${devices.length} (${pairedDevices.length} paired).`,
      );
    }
    return devices[0];
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

function requireUnlocked(device) {
  const temporary = mkdtempSync(join(tmpdir(), "ghosttea-ios-render-lock-"));
  const output = join(temporary, "lock.json");
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
    if (JSON.parse(readFileSync(output, "utf8")).result.passcodeRequired) {
      throw new Error(`Unlock ${device.hardwareProperties.marketingName} before running the benchmark.`);
    }
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

function gitState(acceptedUntrackedFiles) {
  const lines = capture("git", ["status", "--porcelain=v1", "--untracked-files=all"]).split("\n").filter(Boolean);
  return {
    gitRevision: capture("git", ["rev-parse", "HEAD"]),
    gitDirty: lines.some((line) => !line.startsWith("?? ")),
    gitUntrackedFiles: lines.filter((line) => line.startsWith("?? ")).map((line) => line.slice(3)),
    acceptedUntrackedFiles,
  };
}

function validate(options) {
  if (!Number.isInteger(options.iterations) || options.iterations < 1 || options.iterations > 30) {
    throw new Error("--iterations must be an integer from 1 to 30");
  }
  if (!Number.isInteger(options.warmup) || options.warmup < 0 || options.warmup > 10) {
    throw new Error("--warmup must be an integer from 0 to 10");
  }
  if (!Number.isInteger(options.cooldownMs) || options.cooldownMs < 0 || options.cooldownMs > 10_000) {
    throw new Error("--cooldown-ms must be an integer from 0 to 10000");
  }
  if (!Number.isFinite(options.scale) || options.scale < 0.05 || options.scale > 10) {
    throw new Error("--scale must be from 0.05 to 10");
  }
  if (options.cases.length === 0 || new Set(options.cases).size !== options.cases.length) {
    throw new Error("--cases must contain at least one unique case");
  }
}

function summarize(report) {
  console.log("\niOS rendering benchmark medians");
  for (const [name, result] of Object.entries(report.results.cases)) {
    const active = result.samples.map((sample) => sample.activeNanoseconds / 1_000_000);
    const p99 = result.samples.map((sample) => sample.operationP99Nanoseconds / 1_000_000);
    const mesh = result.samples.map(
      (sample) =>
        (sample.performance.summaries.find((summary) => summary.metric === "meshBuild")?.totalNanoseconds ?? 0) /
        1_000_000,
    );
    const upload = result.samples.map((sample) => sample.renderer.vertexUploadBytes / 1024 / 1024);
    console.log(
      `${name.padEnd(16)} active ${median(active).toFixed(1).padStart(8)} ms  op p99 ${median(p99).toFixed(2).padStart(7)} ms  mesh ${median(mesh).toFixed(1).padStart(7)} ms  upload ${median(upload).toFixed(1).padStart(7)} MiB`,
    );
  }
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(`Usage: node bench/ios-render/run.mjs [options]

  --output=path       JSON output (default bench/ios-render/results.json)
  --iterations=5      Measured repetitions per case
  --warmup=1          Untimed repetitions per case
  --cooldown-ms=250   Cooldown between repetitions
  --scale=1           Operation-count multiplier
  --cases=list        Comma-separated benchmark cases
  --geometry-reuse=on Enable or disable encoded geometry reuse
  --retained-state-commit=in-place  Use in-place or copy retained-state commit
  --incremental-accessibility=on  Use incremental or full accessibility snapshots
  --state-codec=json  Truffle state codec: json or compact-json-v1
  --allow-untracked=  Comma-separated untracked-file exceptions
  --no-build          Reuse the existing signed Release app`);
    return;
  }
  validate(options);

  const environment = baseEnvironment;
  const device = findDevice();
  requireUnlocked(device);
  const team = developmentTeam();
  const project = join(root, "apple/GhostteaHarness/GhostteaHarness.xcodeproj");
  const derivedData = join(root, "native/build/ios-render-benchmark/derived-data");
  const app = join(derivedData, "Build/Products/Release-iphoneos/GhostteaHarness.app");

  if (options.build) {
    execute("xcrun", ["swift", "test", "--disable-sandbox", "--package-path", join(root, "apple/GhostteaKit")], {
      environment,
    });
    execute("npm", ["run", "test:ios:harness"], { environment });
    execute(
      "xcodebuild",
      [
        "-project",
        project,
        "-scheme",
        "GhostteaHarness",
        "-allowProvisioningUpdates",
        "-configuration",
        "Release",
        "-quiet",
        "-destination",
        `id=${device.hardwareProperties.udid}`,
        "-derivedDataPath",
        derivedData,
        `DEVELOPMENT_TEAM=${team}`,
        "CODE_SIGN_STYLE=Automatic",
        "build",
      ],
      { environment },
    );
  } else if (!existsSync(app)) {
    throw new Error(`--no-build requires an existing signed app at ${app}`);
  }

  requireUnlocked(device);
  execute("xcrun", ["devicectl", "device", "install", "app", "--device", device.identifier, app], {
    environment,
  });
  const configuration = {
    schemaVersion: 1,
    warmupIterations: options.warmup,
    measuredIterations: options.iterations,
    cooldownMilliseconds: options.cooldownMs,
    scale: options.scale,
    cases: options.cases,
    encodedGeometryReuseEnabled: options.geometryReuse,
    inPlaceRetainedStateCommitEnabled: options.inPlaceRetainedStateCommit,
    incrementalAccessibilityEnabled: options.incrementalAccessibility,
    truffleStateCodec: options.stateCodec,
  };
  const encodedConfiguration = Buffer.from(JSON.stringify(configuration)).toString("base64");
  const launch = execute(
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
      "--environment-variables",
      JSON.stringify({
        GHOSTTEA_AUTORUN_RENDER_BENCHMARK: "1",
        GHOSTTEA_PERFORMANCE_RECORDING: "1",
        GHOSTTEA_RENDER_BENCHMARK_CONFIG: encodedConfiguration,
      }),
      "com.vibecook.GhostteaHarness",
    ],
    { environment, capture: true, allowFailure: true, timeout: 20 * 60_000 },
  );
  const consoleOutput = `${launch.stdout ?? ""}\n${launch.stderr ?? ""}`;
  const encoded = consoleOutput.match(/GHOSTTEA_RENDER_BENCHMARK_REPORT ([A-Za-z0-9+/=]+)/)?.[1];
  process.stdout.write(
    consoleOutput.replace(
      /GHOSTTEA_RENDER_BENCHMARK_REPORT [A-Za-z0-9+/=]+/,
      `GHOSTTEA_RENDER_BENCHMARK_REPORT received (${encoded?.length ?? 0} encoded bytes)`,
    ),
  );
  if (!encoded) throw new Error("The device app did not emit a render benchmark report.");
  const deviceReport = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
  const runner = {
    ...gitState(options.allowUntracked),
    hostPlatform: `${process.platform}-${process.arch}`,
    xcode: capture("xcodebuild", ["-version"]).replaceAll("\n", " / "),
  };
  const report = {
    schemaVersion: 1,
    suite: deviceReport.suite,
    capturedAt: new Date().toISOString(),
    runner,
    config: configuration,
    device: deviceReport.device,
    framePacingNanoseconds: deviceReport.framePacingNanoseconds,
    results: {
      cases: Object.fromEntries(deviceReport.cases.map((result) => [result.name, result])),
    },
    failures: deviceReport.failures,
  };
  mkdirSync(resolve(options.output, ".."), { recursive: true });
  writeFileSync(options.output, `${JSON.stringify(report, null, 2)}\n`);
  summarize(report);
  console.log(`\nReport written to ${options.output}`);
  if (runner.gitDirty) console.warn("Warning: this report was captured from a dirty tracked worktree.");
  if (deviceReport.failures.length > 0) {
    throw new Error(`Device benchmark failed: ${deviceReport.failures.join("; ")}`);
  }
  if (launch.status !== 0) throw new Error(`Device benchmark app exited with status ${launch.status}.`);
}

try {
  main();
} catch (error) {
  console.error(`iOS render benchmark failed: ${error.message}`);
  process.exitCode = 1;
}
