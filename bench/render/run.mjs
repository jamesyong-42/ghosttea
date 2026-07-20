#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { cpus, hostname, platform, arch, release, tmpdir } from "node:os";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DOOM_FIRE_SOURCE, doomFirePayload, payloadCatalog, scrollRegionPayload } from "../lib/payloads.mjs";
import { median, percentile, sum } from "./lib/compare.mjs";

const require = createRequire(import.meta.url);
const root = resolve(import.meta.dirname, "../..");

function parseArgs(argv) {
  const options = {
    output: resolve(root, "bench/render/results.json"),
    iterations: 5,
    warmup: 1,
    scale: 1,
    width: 1200,
    height: 800,
    cooldownMs: 750,
    quietMs: 300,
    build: true,
    allowUntracked: [],
    verifyPixels: false,
    forceFullRendering: false,
    cases: [
      "idle-4",
      "typing-1",
      "sparse-1",
      "scroll-1",
      "dense-1",
      "doom-fire-1",
      "unicode-1",
      "redraw-1",
      "scroll-4",
      "resize-1",
      "resize-jitter-1",
    ],
  };
  for (const argument of argv) {
    if (argument.startsWith("--output=")) options.output = resolve(root, argument.slice(9));
    else if (argument.startsWith("--iterations=")) options.iterations = Number(argument.slice(13));
    else if (argument.startsWith("--warmup=")) options.warmup = Number(argument.slice(9));
    else if (argument.startsWith("--scale=")) options.scale = Number(argument.slice(8));
    else if (argument.startsWith("--width=")) options.width = Number(argument.slice(8));
    else if (argument.startsWith("--height=")) options.height = Number(argument.slice(9));
    else if (argument.startsWith("--cooldown-ms=")) options.cooldownMs = Number(argument.slice(14));
    else if (argument.startsWith("--quiet-ms=")) options.quietMs = Number(argument.slice(11));
    else if (argument.startsWith("--cases=")) options.cases = argument.slice(8).split(",").filter(Boolean);
    else if (argument.startsWith("--allow-untracked=")) {
      options.allowUntracked = argument.slice("--allow-untracked=".length).split(",").filter(Boolean);
    } else if (argument === "--no-build") options.build = false;
    else if (argument === "--verify-pixels") options.verifyPixels = true;
    else if (argument === "--force-full-rendering") options.forceFullRendering = true;
    else if (argument === "--help" || argument === "-h") options.help = true;
  }
  return options;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit", ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} exited with ${result.status}`);
}

function capture(command, args) {
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : "unknown";
}

function succeeds(command, args) {
  return spawnSync(command, args, { cwd: root, stdio: "ignore" }).status === 0;
}

function validate(options) {
  for (const [name, value] of [
    ["iterations", options.iterations],
    ["scale", options.scale],
    ["width", options.width],
    ["height", options.height],
  ]) {
    if (!Number.isFinite(value) || value <= 0) throw new Error(`--${name} must be positive`);
  }
  if (!Number.isInteger(options.iterations) || !Number.isInteger(options.warmup) || options.warmup < 0) {
    throw new Error("--iterations must be a positive integer and --warmup a non-negative integer");
  }
}

function summarize(report) {
  console.log("\nRendering benchmark medians");
  for (const [caseName, iterations] of Object.entries(report.results.cases)) {
    const elapsed = iterations.map((iteration) => iteration.endToIdleMs).sort((a, b) => a - b);
    const renderCpu = iterations.map((iteration) => sum(iteration.worker.samples.renderCpuMs)).sort((a, b) => a - b);
    const latency = iterations
      .flatMap((iteration) => iteration.worker.samples.frameArrivalToRenderMs)
      .sort((a, b) => a - b);
    const uploads = iterations.map((iteration) => iteration.worker.renderer.vertexUploadBytes).sort((a, b) => a - b);
    console.log(
      `${caseName.padEnd(12)} end→idle ${median(elapsed).toFixed(1).padStart(8)} ms  render CPU ${median(renderCpu).toFixed(1).padStart(8)} ms  arrival p99 ${String(percentile(latency, 99)?.toFixed(2) ?? "n/a").padStart(7)} ms  upload ${(median(uploads) / 1024 / 1024).toFixed(1).padStart(7)} MiB`,
    );
  }
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(`Usage: node bench/render/run.mjs [options]

  --output=path       Raw JSON output (default bench/render/results.json)
  --iterations=5      Measured repetitions per case
  --warmup=1          Unmeasured repetitions per case
  --scale=1           Payload multiplier
  --cases=list        idle-4,repaint-1,typing-1,sparse-1,visual-1,scroll-1,dense-1,doom-fire-1,unicode-1,redraw-1,scroll-4,resize-1,resize-jitter-1
  --width=1200        Electron content window width
  --height=800        Electron content window height
  --cooldown-ms=750   Delay between repetitions
  --quiet-ms=300      Required worker quiet period before capture
  --allow-untracked=  Explicit comma-separated untracked-file exceptions
  --no-build          Reuse existing release daemon and built Electron app
  --verify-pixels     Compare partial output with a forced full redraw
  --force-full-rendering  Disable row-damage rendering for an A/B baseline
`);
    return;
  }
  validate(options);
  if (platform() !== "darwin" && platform() !== "linux") {
    throw new Error("The rendering harness currently requires a POSIX /bin/sh and /bin/cat");
  }

  if (options.build) {
    run("cargo", ["build", "--release", "--package", "ghosttead"]);
    run("npm", ["run", "build:sdk"]);
    run("npm", ["run", "build", "--workspace", "ghosttea-desktop-experiment"]);
  }

  const terminald = resolve(root, `target/release/${platform() === "win32" ? "ghosttead.exe" : "ghosttead"}`);
  if (!existsSync(terminald)) throw new Error(`Missing release terminal daemon: ${terminald}`);
  const experimentMain = resolve(root, "apps/desktop-experiment/out/main/index.js");
  if (!existsSync(experimentMain)) throw new Error("Desktop experiment is not built; rerun without --no-build");

  const temporary = mkdtempSync(join(tmpdir(), "ghosttea-render-bench-"));
  try {
    const payloads = payloadCatalog(options.scale);
    const redraw = scrollRegionPayload({
      frames: Math.max(30, Math.round(120 * options.scale)),
      rows: 40,
      cols: 120,
    });
    const doomFire = doomFirePayload({
      frames: Math.max(60, Math.round(180 * options.scale)),
      rows: 39,
      cols: 120,
    });
    const payloadFiles = {};
    for (const [name, payload] of Object.entries({
      scrolling: payloads.scrolling,
      sparse: payloads.sparse,
      visual: payloads.visual,
      dense: payloads.dense,
      doomFire: doomFire.payload,
      unicode: payloads.unicode,
      redraw,
    })) {
      const path = join(temporary, `${name}.bin`);
      writeFileSync(path, payload);
      payloadFiles[name] = { path, bytes: payload.byteLength };
    }
    const catalog = {
      "idle-4": { name: "idle-4", panes: 4, kind: "idle", durationMs: 2_500 },
      "repaint-1": {
        name: "repaint-1",
        panes: 1,
        kind: "repaint",
        operations: Math.max(60, Math.round(180 * options.scale)),
        intervalMs: 16,
      },
      "typing-1": {
        name: "typing-1",
        panes: 1,
        kind: "interactive",
        operations: Math.max(60, Math.round(180 * options.scale)),
        intervalMs: 16,
        inputText: "terminal-render-benchmark\n",
      },
      "sparse-1": {
        name: "sparse-1",
        panes: 1,
        kind: "payload",
        payloadPath: payloadFiles.sparse.path,
        payloadBytes: payloadFiles.sparse.bytes,
        chunkBytes: 107,
        intervalMs: 8,
      },
      "visual-1": {
        name: "visual-1",
        panes: 1,
        kind: "payload",
        payloadPath: payloadFiles.visual.path,
        payloadBytes: payloadFiles.visual.bytes,
        chunkBytes: 107,
        intervalMs: 8,
      },
      "scroll-1": {
        name: "scroll-1",
        panes: 1,
        kind: "payload",
        payloadPath: payloadFiles.scrolling.path,
        payloadBytes: payloadFiles.scrolling.bytes,
        chunkBytes: 8192,
        intervalMs: 8,
      },
      "dense-1": {
        name: "dense-1",
        panes: 1,
        kind: "payload",
        payloadPath: payloadFiles.dense.path,
        payloadBytes: payloadFiles.dense.bytes,
        chunkBytes: 8192,
        intervalMs: 8,
      },
      "doom-fire-1": {
        name: "doom-fire-1",
        panes: 1,
        kind: "payload",
        payloadPath: payloadFiles.doomFire.path,
        payloadBytes: payloadFiles.doomFire.bytes,
        chunkBytesSequence: doomFire.frameByteLengths,
        intervalMs: 16,
        operations: doomFire.frameByteLengths.length,
        seed: doomFire.seed,
        source: DOOM_FIRE_SOURCE,
      },
      "unicode-1": {
        name: "unicode-1",
        panes: 1,
        kind: "payload",
        payloadPath: payloadFiles.unicode.path,
        payloadBytes: payloadFiles.unicode.bytes,
        chunkBytes: 4096,
        intervalMs: 8,
      },
      "redraw-1": {
        name: "redraw-1",
        panes: 1,
        kind: "payload",
        payloadPath: payloadFiles.redraw.path,
        payloadBytes: payloadFiles.redraw.bytes,
        chunkBytes: 8192,
        intervalMs: 8,
      },
      "scroll-4": {
        name: "scroll-4",
        panes: 4,
        kind: "payload",
        payloadPath: payloadFiles.scrolling.path,
        payloadBytes: payloadFiles.scrolling.bytes,
        chunkBytes: 8192,
        intervalMs: 8,
      },
      "resize-1": {
        name: "resize-1",
        panes: 1,
        kind: "resize",
        operations: Math.max(60, Math.round(180 * options.scale)),
      },
      "resize-jitter-1": {
        name: "resize-jitter-1",
        panes: 1,
        kind: "resize",
        operations: Math.max(60, Math.round(180 * options.scale)),
        resizeDelta: 0.2,
      },
    };
    const unknownCases = options.cases.filter((name) => !catalog[name]);
    if (unknownCases.length > 0) throw new Error(`Unknown benchmark cases: ${unknownCases.join(", ")}`);

    const config = {
      schemaVersion: 1,
      suite: "ghosttea-per-pane-render-v1",
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
      forceFullRendering: options.forceFullRendering,
      cases: options.cases.map((name) => catalog[name]),
      runner: {
        generatedAt: new Date().toISOString(),
        host: hostname(),
        platform: `${platform()}/${arch()} ${release()}`,
        cpu: cpus()[0]?.model ?? "unknown",
        logicalCpuCount: cpus().length,
        node: process.version,
        gitRevision: capture("git", ["rev-parse", "HEAD"]),
        gitBranch: capture("git", ["branch", "--show-current"]),
        gitDirty: !succeeds("git", ["diff", "--quiet"]) || !succeeds("git", ["diff", "--cached", "--quiet"]),
        gitUntrackedFiles: capture("git", ["ls-files", "--others", "--exclude-standard"]).split("\n").filter(Boolean),
        acceptedUntrackedFiles: options.allowUntracked,
        scale: options.scale,
      },
    };

    mkdirSync(resolve(options.output, ".."), { recursive: true });
    const electron = require("electron");
    run(electron, [resolve(root, "apps/desktop-experiment"), `--user-data-dir=${join(temporary, "electron-data")}`], {
      env: {
        ...process.env,
        GHOSTTEA_PROFILE: `render-bench-${process.pid}`,
        GHOSTTEAD_BIN: terminald,
        GHOSTTEA_RENDER_BENCH_CONFIG: JSON.stringify(config),
        GHOSTTEA_RENDER_BENCH_OUTPUT: options.output,
      },
      timeout: 15 * 60_000,
    });
    if (!existsSync(options.output)) throw new Error(`Electron exited without writing ${options.output}`);
    const report = JSON.parse(readFileSync(options.output, "utf8"));
    summarize(report);
    console.log(`\nRaw report: ${options.output}`);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

main();
