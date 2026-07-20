#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { cpus, hostname, platform, arch, release } from "node:os";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { median } from "../render/lib/compare.mjs";

const root = resolve(import.meta.dirname, "../..");

const catalog = {
  "sparse-decode-1": { workload: "sparse", apply: "decode", updates: 20_000, fanout: 1 },
  "sparse-replica-1": { workload: "sparse", apply: "replica", updates: 180, fanout: 1 },
  "dense-decode-1": { workload: "dense", apply: "decode", updates: 1_000, fanout: 1 },
  "dense-replica-1": { workload: "dense", apply: "replica", updates: 60, fanout: 1 },
  "truecolor-decode-1": { workload: "truecolor", apply: "decode", updates: 30, fanout: 1 },
  "truecolor-replica-1": { workload: "truecolor", apply: "replica", updates: 30, fanout: 1 },
  "resync-replica-1": { workload: "resync", apply: "replica", updates: 30, fanout: 1 },
  "dense-replica-4": { workload: "dense", apply: "replica", updates: 30, fanout: 4 },
};

function parseArgs(argv) {
  const options = {
    output: resolve(root, "bench/truffle/results.json"),
    cases: Object.keys(catalog),
    iterations: 5,
    warmup: 1,
    scale: 1,
    cols: 120,
    rows: 40,
    duplexBytes: 64 * 1024,
    transport: "quic-protocol-loopback",
    build: true,
    allowDirty: false,
    allowUntracked: [],
  };
  for (const argument of argv) {
    if (argument.startsWith("--output=")) options.output = resolve(root, argument.slice(9));
    else if (argument.startsWith("--cases=")) options.cases = argument.slice(8).split(",").filter(Boolean);
    else if (argument.startsWith("--iterations=")) options.iterations = Number(argument.slice(13));
    else if (argument.startsWith("--warmup=")) options.warmup = Number(argument.slice(9));
    else if (argument.startsWith("--scale=")) options.scale = Number(argument.slice(8));
    else if (argument.startsWith("--cols=")) options.cols = Number(argument.slice(7));
    else if (argument.startsWith("--rows=")) options.rows = Number(argument.slice(7));
    else if (argument.startsWith("--duplex-bytes=")) options.duplexBytes = Number(argument.slice(15));
    else if (argument.startsWith("--transport=")) options.transport = argument.slice(12);
    else if (argument.startsWith("--allow-untracked=")) {
      options.allowUntracked = argument.slice(18).split(",").filter(Boolean);
    } else if (argument === "--no-build") options.build = false;
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
  const unknown = options.cases.filter((name) => !catalog[name]);
  if (unknown.length > 0) throw new Error(`Unknown benchmark cases: ${unknown.join(", ")}`);
  if (!["quic-protocol-loopback", "compact-loopback"].includes(options.transport)) {
    throw new Error("--transport must be quic-protocol-loopback or compact-loopback");
  }
  for (const [name, value] of [
    ["iterations", options.iterations],
    ["scale", options.scale],
    ["cols", options.cols],
    ["rows", options.rows],
    ["duplex-bytes", options.duplexBytes],
  ]) {
    if (!Number.isFinite(value) || value <= 0) throw new Error(`--${name} must be positive`);
  }
  if (!Number.isInteger(options.iterations) || !Number.isInteger(options.warmup) || options.warmup < 0) {
    throw new Error("--iterations must be a positive integer and --warmup a non-negative integer");
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

function benchmarkCase(name, definition, options, executable) {
  const updates = Math.max(1, Math.round(definition.updates * options.scale));
  const args = [
    `--transport=${options.transport}`,
    `--workload=${definition.workload}`,
    `--apply=${definition.apply}`,
    `--updates=${updates}`,
    `--fanout=${definition.fanout}`,
    `--warmup=${options.warmup}`,
    `--iterations=${options.iterations}`,
    `--cols=${options.cols}`,
    `--rows=${options.rows}`,
    `--duplex-bytes=${options.duplexBytes}`,
  ];
  process.stderr.write(`running ${name} (${updates} updates, fanout ${definition.fanout})\n`);
  const result = JSON.parse(capture(executable, args));
  if (result.samples.length !== options.iterations) throw new Error(`${name} returned the wrong sample count`);
  return result;
}

function printSummary(report) {
  console.log("\nTruffle replication benchmark medians");
  for (const [name, result] of Object.entries(report.results.cases)) {
    const samples = result.samples;
    const wall = median(samples.map((sample) => sample.wallMs));
    const encode = median(samples.map((sample) => sample.producerEncodeMs));
    const decode = median(samples.map((sample) => sample.receiverDecodeMs));
    const apply = median(samples.map((sample) => sample.replicaApplyMs));
    const p99 = median(samples.map((sample) => sample.latency.p99Ms));
    const throughput = median(samples.map((sample) => sample.throughputMibPerSecond));
    console.log(
      `${name.padEnd(21)} wall ${wall.toFixed(2).padStart(9)} ms  encode ${encode.toFixed(2).padStart(8)}  decode ${decode.toFixed(2).padStart(8)}  apply ${apply.toFixed(2).padStart(8)}  p99 ${p99.toFixed(2).padStart(8)}  ${throughput.toFixed(1).padStart(8)} MiB/s`,
    );
  }
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(`Usage: node bench/truffle/run.mjs [options]

  --output=path          Raw JSON output (default bench/truffle/results.json)
  --cases=list           ${Object.keys(catalog).join(",")}
  --iterations=5         Measured repetitions per case
  --warmup=1             Unmeasured repetitions per case
  --scale=1              Update-count multiplier
  --cols=120 --rows=40   Logical terminal dimensions
  --duplex-bytes=65536   Bounded stream capacity
  --transport=name       quic-protocol-loopback (default) or compact-loopback
  --allow-untracked=list Explicit untracked-file exceptions
  --allow-dirty          Permit a non-evidence smoke run
  --no-build             Reuse target/release/replication_bench
`);
    return;
  }
  validate(options);
  const git = gitState(options);
  if (options.build) {
    capture("cargo", ["build", "--release", "-p", "ghosttea-truffle", "--bin", "replication_bench"], {
      inherit: true,
    });
  }
  const executable = resolve(root, `target/release/replication_bench${platform() === "win32" ? ".exe" : ""}`);
  const cases = Object.fromEntries(
    options.cases.map((name) => [name, benchmarkCase(name, catalog[name], options, executable)]),
  );
  const report = {
    schemaVersion: 1,
    suite: "ghosttea-truffle-replication-v1",
    transport: options.transport,
    config: {
      iterations: options.iterations,
      warmup: options.warmup,
      scale: options.scale,
      cols: options.cols,
      rows: options.rows,
      duplexBytes: options.duplexBytes,
      transport: options.transport,
      cases: options.cases.map((name) => ({ name, ...catalog[name] })),
    },
    runner: {
      generatedAt: new Date().toISOString(),
      host: hostname(),
      platform: `${platform()}/${arch()} ${release()}`,
      cpu: cpus()[0]?.model ?? "unknown",
      logicalCpuCount: cpus().length,
      node: process.version,
      rustc: capture("rustc", ["--version"]),
      build: options.build,
      ...git,
    },
    results: { cases },
  };
  mkdirSync(resolve(options.output, ".."), { recursive: true });
  writeFileSync(options.output, `${JSON.stringify(report, null, 2)}\n`);
  printSummary(report);
  console.log(`\nRaw report: ${options.output}`);
}

main();
