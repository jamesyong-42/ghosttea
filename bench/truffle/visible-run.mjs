#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { cpus, hostname, platform, arch, release, tmpdir } from "node:os";
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { DOOM_FIRE_SOURCE, doomFirePayload, payloadCatalog } from "../lib/payloads.mjs";
import { median, percentile, sum } from "../render/lib/compare.mjs";

const require = createRequire(import.meta.url);
const root = resolve(import.meta.dirname, "../..");

function parseArgs(argv) {
  const options = {
    output: resolve(root, "bench/truffle/results-visible.json"),
    cases: ["sparse-remote-1", "dense-remote-1", "doom-fire-remote-1"],
    iterations: 3,
    warmup: 1,
    scale: 1,
    width: 800,
    height: 600,
    cooldownMs: 500,
    quietMs: 350,
    discoveryTimeoutMs: 90_000,
    workloadTimeoutMs: 120_000,
    build: true,
    verifyPixels: false,
    allowDirty: false,
    allowUntracked: [],
    hostStateDir: undefined,
    viewerStateDir: undefined,
  };
  for (const argument of argv) {
    if (argument.startsWith("--output=")) options.output = resolve(root, argument.slice(9));
    else if (argument.startsWith("--cases=")) options.cases = argument.slice(8).split(",").filter(Boolean);
    else if (argument.startsWith("--iterations=")) options.iterations = Number(argument.slice(13));
    else if (argument.startsWith("--warmup=")) options.warmup = Number(argument.slice(9));
    else if (argument.startsWith("--scale=")) options.scale = Number(argument.slice(8));
    else if (argument.startsWith("--width=")) options.width = Number(argument.slice(8));
    else if (argument.startsWith("--height=")) options.height = Number(argument.slice(9));
    else if (argument.startsWith("--cooldown-ms=")) options.cooldownMs = Number(argument.slice(14));
    else if (argument.startsWith("--quiet-ms=")) options.quietMs = Number(argument.slice(11));
    else if (argument.startsWith("--discovery-timeout-ms=")) options.discoveryTimeoutMs = Number(argument.slice(23));
    else if (argument.startsWith("--workload-timeout-ms=")) options.workloadTimeoutMs = Number(argument.slice(22));
    else if (argument.startsWith("--host-state-dir=")) options.hostStateDir = resolve(argument.slice(17));
    else if (argument.startsWith("--viewer-state-dir=")) options.viewerStateDir = resolve(argument.slice(19));
    else if (argument.startsWith("--allow-untracked=")) {
      options.allowUntracked = argument.slice(18).split(",").filter(Boolean);
    } else if (argument === "--verify-pixels") options.verifyPixels = true;
    else if (argument === "--no-build") options.build = false;
    else if (argument === "--allow-dirty") options.allowDirty = true;
    else if (argument === "--help" || argument === "-h") options.help = true;
    else throw new Error(`Unknown argument ${argument}`);
  }
  return options;
}

function capture(command, args, { inherit = false } = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    stdio: inherit ? "inherit" : ["ignore", "pipe", "pipe"],
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = inherit ? "" : `\n${result.stderr || result.stdout}`;
    throw new Error(`${command} ${args.join(" ")} exited with ${result.status}${detail}`);
  }
  return inherit ? "" : result.stdout.trim();
}

function validate(options) {
  const knownCases = new Set(["sparse-remote-1", "dense-remote-1", "doom-fire-remote-1"]);
  const unknown = options.cases.filter((name) => !knownCases.has(name));
  if (unknown.length > 0) throw new Error(`Unknown replicated rendering cases: ${unknown.join(", ")}`);
  for (const [name, value] of [
    ["iterations", options.iterations],
    ["scale", options.scale],
    ["width", options.width],
    ["height", options.height],
    ["discovery-timeout-ms", options.discoveryTimeoutMs],
    ["workload-timeout-ms", options.workloadTimeoutMs],
  ]) {
    if (!Number.isFinite(value) || value <= 0) throw new Error(`--${name} must be positive`);
  }
  if (Boolean(options.hostStateDir) !== Boolean(options.viewerStateDir)) {
    throw new Error("--host-state-dir and --viewer-state-dir must be provided together");
  }
  for (const stateDir of [options.hostStateDir, options.viewerStateDir].filter(Boolean)) {
    if (!existsSync(stateDir)) throw new Error(`Truffle state directory not found: ${stateDir}`);
  }
  if (
    options.hostStateDir &&
    options.viewerStateDir &&
    realpathSync(options.hostStateDir) === realpathSync(options.viewerStateDir)
  ) {
    throw new Error("Host and viewer Truffle state directories must use distinct device identities");
  }
  for (const [name, value] of [
    ["iterations", options.iterations],
    ["warmup", options.warmup],
    ["cooldown-ms", options.cooldownMs],
    ["quiet-ms", options.quietMs],
  ]) {
    if (!Number.isInteger(value) || value < (name === "iterations" ? 1 : 0)) {
      throw new Error(`--${name} must be a ${name === "iterations" ? "positive" : "non-negative"} integer`);
    }
  }
}

function gitState(options) {
  const status = capture("git", ["status", "--porcelain=v1", "--untracked-files=all"]).split("\n").filter(Boolean);
  const untracked = status.filter((line) => line.startsWith("?? ")).map((line) => line.slice(3));
  const trackedDirty = status.some((line) => !line.startsWith("?? "));
  const accepted = new Set(options.allowUntracked);
  const unexpected = untracked.filter((path) => !accepted.has(path));
  if (!options.allowDirty && (trackedDirty || unexpected.length > 0)) {
    const reasons = [];
    if (trackedDirty) reasons.push("tracked files are modified");
    if (unexpected.length > 0) reasons.push(`unaccepted untracked files: ${unexpected.join(", ")}`);
    throw new Error(
      `Refusing an evidence run because ${reasons.join("; ")}. Commit changes or use --allow-dirty for a smoke run.`,
    );
  }
  return {
    gitRevision: capture("git", ["rev-parse", "HEAD"]),
    gitBranch: capture("git", ["branch", "--show-current"]),
    gitDirty: trackedDirty || options.allowDirty,
    gitUntrackedFiles: untracked,
    acceptedUntrackedFiles: options.allowUntracked,
  };
}

function dotenvValue(name) {
  const path = resolve(root, ".env");
  if (!existsSync(path)) return undefined;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match || match[1] !== name) continue;
    const value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      return value.slice(1, -1);
    }
    return value;
  }
  return undefined;
}

function childExit(child, label) {
  return new Promise((resolveExit, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      resolveExit({ label, code: code ?? (signal ? 1 : 0), signal });
    });
  });
}

function captureChildOutput(child, label, logPath) {
  let tail = "";
  const capture = (stream, destination) => {
    stream?.on("data", (chunk) => {
      const message = String(chunk);
      tail = `${tail}${message}`.slice(-12_000);
      appendFileSync(logPath, `[${label}] ${message}`);
      destination.write(`[${label}] ${message}`);
    });
  };
  capture(child.stdout, process.stdout);
  capture(child.stderr, process.stderr);
  return () => tail;
}

async function runVisiblePeers(
  electron,
  application,
  temporary,
  hostConfig,
  viewerConfig,
  environment,
  stateDirectories,
  logPath,
  timeoutMs,
) {
  const launch = (role, config) =>
    spawn(electron, [application, `--user-data-dir=${join(temporary, `${role}-user-data`)}`], {
      cwd: root,
      env: {
        ...environment,
        GHOSTTEA_PROFILE: `visible-${role}`,
        ...(stateDirectories ? { GHOSTTEA_TRUFFLE_BENCHMARK_STATE_DIR: stateDirectories[role] } : {}),
        GHOSTTEA_RENDER_BENCH_CONFIG: JSON.stringify(config),
        ...(role === "viewer" ? { GHOSTTEA_RENDER_BENCH_OUTPUT: viewerConfig.runner.output } : {}),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

  const host = launch("host", hostConfig);
  const hostLog = captureChildOutput(host, "host", logPath);
  const hostExit = childExit(host, "host");
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
  const viewer = launch("viewer", viewerConfig);
  const viewerLog = captureChildOutput(viewer, "viewer", logPath);
  const viewerExit = childExit(viewer, "viewer");
  let timeout;
  try {
    const outcome = await Promise.race([
      viewerExit,
      hostExit.then((result) => {
        throw new Error(
          `Replicated benchmark host exited early (${result.code ?? result.signal ?? "unknown"})\n${hostLog()}`,
        );
      }),
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error("Visible replicated benchmark timed out")), timeoutMs);
      }),
    ]);
    if (outcome.code !== 0) {
      throw new Error(`Replicated benchmark viewer exited with ${outcome.code}\n${viewerLog()}`);
    }
  } finally {
    if (timeout) clearTimeout(timeout);
    if (viewer.exitCode === null && viewer.signalCode === null) viewer.kill("SIGTERM");
    if (host.exitCode === null && host.signalCode === null) host.kill("SIGTERM");
    await Promise.allSettled([viewerExit, hostExit]);
  }
}

function printSummary(report) {
  console.log("\nVisible replicated rendering medians");
  for (const [name, samples] of Object.entries(report.results.cases)) {
    const wall = median(samples.map((sample) => sample.endToIdleMs));
    const producer = median(samples.map((sample) => sample.producer.durationMs));
    const renderCpu = median(samples.map((sample) => sum(sample.worker.samples.renderCpuMs)));
    const applyCpu = median(samples.map((sample) => sum(sample.worker.samples.frameApplyMs)));
    const arrival = percentile(
      samples.flatMap((sample) => sample.worker.samples.frameArrivalToRenderMs).sort((a, b) => a - b),
      99,
    );
    const frames = median(samples.map((sample) => sample.worker.frames.received));
    console.log(
      `${name.padEnd(22)} end→idle ${wall.toFixed(1).padStart(8)} ms  producer ${producer.toFixed(1).padStart(8)}  apply ${applyCpu.toFixed(1).padStart(8)}  render ${renderCpu.toFixed(1).padStart(8)}  arrival p99 ${String(arrival?.toFixed(2) ?? "n/a").padStart(7)} ms  frames ${frames}`,
    );
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(`Usage: node bench/truffle/visible-run.mjs [options]

  --output=path          Raw JSON output (default bench/truffle/results-visible.json)
  --cases=list           sparse-remote-1,dense-remote-1,doom-fire-remote-1
  --iterations=3         Measured repetitions per case
  --warmup=1             Unmeasured repetitions per case
  --scale=1              Payload multiplier
  --width=800            Width of each visible Electron window
  --height=600           Height of each visible Electron window
  --cooldown-ms=500      Delay between sessions
  --quiet-ms=350         Required remote renderer quiet period
  --discovery-timeout-ms=90000  Remote host discovery timeout
  --workload-timeout-ms=120000  Per-workload completion timeout
  --verify-pixels        Compare partial output with a forced full redraw
  --host-state-dir=path  Reuse an authenticated host Truffle profile
  --viewer-state-dir=path  Reuse an authenticated viewer Truffle profile
  --allow-untracked=list Explicit untracked-file exceptions
  --allow-dirty          Permit a non-evidence smoke run
  --no-build             Reuse release ghosttead and the built experiment app
`);
    return;
  }
  validate(options);
  if (platform() !== "darwin" && platform() !== "linux") {
    throw new Error("The visible replicated benchmark currently requires macOS or Linux");
  }
  const git = gitState(options);
  const authKey = process.env.TRUFFLE_TEST_AUTHKEY ?? dotenvValue("TRUFFLE_TEST_AUTHKEY");
  if (!authKey && !options.hostStateDir) {
    throw new Error(
      "TRUFFLE_TEST_AUTHKEY is required for ephemeral nodes; alternatively provide authenticated --host-state-dir and --viewer-state-dir profiles",
    );
  }
  const defaultSidecar = resolve(root, "../p008/truffle/packages/sidecar-slim/sidecar-slim");
  const sidecarPath = process.env.TRUFFLE_SIDECAR_PATH ?? dotenvValue("TRUFFLE_SIDECAR_PATH") ?? defaultSidecar;
  if (!existsSync(sidecarPath)) throw new Error(`Truffle sidecar not found: ${sidecarPath}`);

  if (options.build) {
    capture("cargo", ["build", "--release", "--package", "ghosttead"], { inherit: true });
    capture("npm", ["run", "build:sdk"], { inherit: true });
    capture("npm", ["run", "build", "--workspace", "ghosttea-desktop-experiment"], { inherit: true });
  }
  const terminald = resolve(root, `target/release/${platform() === "win32" ? "ghosttead.exe" : "ghosttead"}`);
  const application = resolve(root, "apps/desktop-experiment");
  if (!existsSync(terminald)) throw new Error(`Missing release terminal daemon: ${terminald}`);
  if (!existsSync(resolve(application, "out/main/index.js"))) {
    throw new Error("Desktop experiment is not built; rerun without --no-build");
  }

  const temporary = mkdtempSync(join(tmpdir(), "ghosttea-visible-truffle-bench-"));
  try {
    const completionDirectory = join(temporary, "complete");
    const payloadDirectory = join(temporary, "payloads");
    mkdirSync(completionDirectory, { recursive: true });
    mkdirSync(payloadDirectory, { recursive: true });
    const payloads = payloadCatalog(options.scale);
    const doomFire = doomFirePayload({
      frames: Math.max(60, Math.round(180 * options.scale)),
      rows: 39,
      cols: 120,
    });
    const definitions = {
      "sparse-remote-1": { payload: payloads.sparse, chunkBytes: 107, intervalMs: 8 },
      "dense-remote-1": { payload: payloads.dense, chunkBytes: 8192, intervalMs: 8 },
      "doom-fire-remote-1": {
        payload: doomFire.payload,
        chunkBytesSequence: doomFire.frameByteLengths,
        intervalMs: 16,
        operations: doomFire.frameByteLengths.length,
        seed: doomFire.seed,
        source: DOOM_FIRE_SOURCE,
      },
    };
    const cases = options.cases.map((name) => {
      const definition = definitions[name];
      const payloadPath = join(payloadDirectory, `${name}.bin`);
      writeFileSync(payloadPath, definition.payload);
      return {
        name,
        panes: 1,
        kind: "payload",
        payloadPath,
        payloadBytes: definition.payload.byteLength,
        chunkBytes: definition.chunkBytes,
        chunkBytesSequence: definition.chunkBytesSequence,
        intervalMs: definition.intervalMs,
        operations: definition.operations,
        seed: definition.seed,
        source: definition.source,
      };
    });
    const runId = randomBytes(6).toString("hex");
    const baseConfig = {
      schemaVersion: 1,
      suite: "ghosttea-visible-replicated-render-v1",
      width: options.width,
      height: options.height,
      cols: 120,
      rows: 40,
      warmupIterations: options.warmup,
      measuredIterations: options.iterations,
      cooldownMs: options.cooldownMs,
      quietMs: options.quietMs,
      workloadExecutable: process.execPath,
      workloadScript: resolve(root, "bench/render/workload.mjs"),
      verifyPixels: options.verifyPixels,
      cases,
      runner: {
        generatedAt: new Date().toISOString(),
        host: hostname(),
        platform: `${platform()}/${arch()} ${release()}`,
        cpu: cpus()[0]?.model ?? "unknown",
        logicalCpuCount: cpus().length,
        node: process.version,
        gitRevision: git.gitRevision,
        gitBranch: git.gitBranch,
        gitDirty: git.gitDirty,
        gitUntrackedFiles: git.gitUntrackedFiles,
        acceptedUntrackedFiles: git.acceptedUntrackedFiles,
        scale: options.scale,
        truffleIdentityMode: options.hostStateDir ? "reused-profiles" : "ephemeral-auth-key",
        output: options.output,
      },
    };
    const replication = {
      completionDirectory,
      discoveryTimeoutMs: options.discoveryTimeoutMs,
      workloadTimeoutMs: options.workloadTimeoutMs,
    };
    const hostConfig = { ...baseConfig, replication: { ...replication, role: "host" } };
    const viewerConfig = { ...baseConfig, replication: { ...replication, role: "viewer" } };
    const electron = require("electron");
    const stateDirectories = options.hostStateDir
      ? {
          host: join(temporary, "host-truffle-state"),
          viewer: join(temporary, "viewer-truffle-state"),
        }
      : undefined;
    if (stateDirectories) {
      cpSync(options.hostStateDir, stateDirectories.host, { recursive: true });
      cpSync(options.viewerStateDir, stateDirectories.viewer, { recursive: true });
      // The tailnet identity is the reusable seed. Replication store slices
      // belong to the source app run and must not leak into a measurement.
      rmSync(join(stateDirectories.host, "synced-store"), { recursive: true, force: true });
      rmSync(join(stateDirectories.viewer, "synced-store"), { recursive: true, force: true });
    }
    const environment = {
      ...process.env,
      ...(authKey && !options.hostStateDir ? { TRUFFLE_TEST_AUTHKEY: authKey } : {}),
      TRUFFLE_SIDECAR_PATH: sidecarPath,
      GHOSTTEAD_BIN: terminald,
      GHOSTTEA_TRUFFLE_ENABLED: "1",
      GHOSTTEA_TRUFFLE_ALLOW_WRITE: "1",
      GHOSTTEA_TRUFFLE_EPHEMERAL: options.hostStateDir ? "0" : "1",
      GHOSTTEA_TRUFFLE_APP_ID: `ghosttea-visible-${runId}`,
      GHOSTTEA_TRUFFLE_SERVICE: `terminal.visible.${runId}`,
    };
    delete environment.ELECTRON_RENDERER_URL;
    // An explicit empty value prevents ghosttead's dotenv fallback from
    // injecting an unrelated auth key into durable-profile runs.
    if (options.hostStateDir) environment.TRUFFLE_TEST_AUTHKEY = "";
    mkdirSync(resolve(options.output, ".."), { recursive: true });
    const logPath = `${options.output}.log`;
    writeFileSync(logPath, "");
    await runVisiblePeers(
      electron,
      application,
      temporary,
      hostConfig,
      viewerConfig,
      environment,
      stateDirectories,
      logPath,
      Math.max(5 * 60_000, options.workloadTimeoutMs * options.cases.length * (options.iterations + options.warmup)),
    );
    if (!existsSync(options.output)) throw new Error(`Viewer exited without writing ${options.output}`);
    const report = JSON.parse(readFileSync(options.output, "utf8"));
    printSummary(report);
    console.log(`\nRaw report: ${options.output}`);
    console.log(`Process log: ${logPath}`);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

await main();
