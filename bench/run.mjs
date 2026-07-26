#!/usr/bin/env node
/**
 * Comparative terminal benchmark harness.
 *
 * Primary comparison:
 *   ghosttead (PTY→libghostty-vt→shape→TRF1)
 *     vs
 *   node-pty → xterm.js (classic Electron embed path)
 *
 * Usage:
 *   npm run bench
 *   node bench/run.mjs --scale=1 --json=bench/results.json
 */

import { writeFileSync } from "node:fs";
import { hostname, platform, arch, cpus } from "node:os";
import { resolve } from "node:path";
import { controlRow, metricRow, printCase, printHeader, toJsonReport, formatMs } from "./lib/report.mjs";
import { runGhostteadBench } from "./targets/ghosttead.mjs";
import { runXtermBench } from "./targets/xterm.mjs";

function parseArgs(argv) {
  const options = {
    targets: ["ghosttead", "xterm"],
    scale: 1,
    cols: 120,
    rows: 40,
    json: null,
    withPty: true,
  };
  for (const arg of argv) {
    if (arg.startsWith("--targets=")) {
      options.targets = arg
        .slice("--targets=".length)
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean);
    } else if (arg.startsWith("--scale=")) {
      options.scale = Number(arg.slice("--scale=".length));
    } else if (arg.startsWith("--cols=")) {
      options.cols = Number(arg.slice("--cols=".length));
    } else if (arg.startsWith("--rows=")) {
      options.rows = Number(arg.slice("--rows=".length));
    } else if (arg.startsWith("--json=")) {
      options.json = resolve(arg.slice("--json=".length));
    } else if (arg === "--no-pty") {
      options.withPty = false;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    }
  }
  return options;
}

function help() {
  console.log(`Usage: node bench/run.mjs [options]

Primary comparison is ghosttead vs full node-pty→xterm (not pure xterm.write).

Options:
  --targets=ghosttead,xterm   Comma-separated targets (default: ghosttead,xterm)
  --scale=1                   Workload scale multiplier (0.25–4 recommended)
  --cols=120 --rows=40        Terminal grid size
  --json=path                 Write full JSON report
  --no-pty                    Skip node-pty path (pure xterm parse only)
  -h, --help                  Show help

Environment:
  GHOSTTEAD_BIN               Path to a prebuilt ghosttead binary

If node-pty fails with "posix_spawnp failed":
  node scripts/fix-node-pty.mjs

Manual native Ghostty:
  time BENCH_SCALE=1 ./bench/workloads/manual-cat.sh scrolling
`);
}

function compareThroughput(name, ghostteadCase, xtermCase) {
  if (!ghostteadCase || !xtermCase || xtermCase.skipped) return null;
  if (!ghostteadCase.ms || !xtermCase.ms) return null;
  const ratio = xtermCase.ms / ghostteadCase.ms;
  return {
    case: name,
    ghostteadMs: ghostteadCase.ms,
    xtermMs: xtermCase.ms,
    speedupVsXterm: ratio,
    note:
      ratio > 1
        ? `ghosttead finished ~${ratio.toFixed(2)}× faster (wall)`
        : `node-pty+xterm finished ~${(1 / ratio).toFixed(2)}× faster (wall)`,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    help();
    return;
  }

  const meta = {
    host: hostname(),
    node: process.version,
    platform: `${platform()}/${arch()}`,
    cpu: cpus()[0]?.model ?? "unknown",
    scale: options.scale,
    cols: options.cols,
    rows: options.rows,
    targets: options.targets,
  };

  printHeader(meta);

  const results = {};

  if (options.targets.includes("ghosttead")) {
    results.ghosttead = await runGhostteadBench({
      scale: options.scale,
      cols: options.cols,
      rows: options.rows,
    });
  }

  if (options.targets.includes("xterm")) {
    try {
      results.xterm = await runXtermBench({
        scale: options.scale,
        cols: options.cols,
        rows: options.rows,
        withPty: options.withPty,
      });
    } catch (error) {
      console.error(`[bench] xterm target failed: ${error instanceof Error ? error.message : error}`);
      results.xterm = {
        target: "node-pty+xterm",
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  const td = results.ghosttead?.cases;
  const xt = results.xterm?.cases;

  if (td || xt) {
    console.log("## Primary: ghosttead vs node-pty → xterm.js (full embed path)");
    console.log("Both sides open a real PTY, cat the same payload, and process output to a terminal surface.");
    console.log("ghosttead also shapes glyphs and encodes TRF1 frames; xterm parses into its JS buffer.");
    console.log("");

    printCase(
      "Dense colored cells",
      [
        td?.dense &&
          metricRow({
            target: "ghosttead",
            ms: td.dense.ms,
            bytes: td.dense.bytesIn,
            extra: `${td.dense.frames} frames`,
          }),
        xt?.ptyDense &&
          !xt.ptyDense.skipped &&
          metricRow({
            target: "node-pty→xterm",
            ms: xt.ptyDense.ms,
            bytes: xt.ptyDense.bytesIn,
            extra: `${xt.ptyDense.chunks ?? "?"} chunks`,
          }),
      ].filter(Boolean),
    );

    printCase(
      "Scrolling plain-text flood",
      [
        td?.scrolling &&
          metricRow({
            target: "ghosttead",
            ms: td.scrolling.ms,
            bytes: td.scrolling.bytesIn,
            extra: `${td.scrolling.frames} frames / gaps ${td.scrolling.sequenceGaps}`,
          }),
        xt?.ptyScrolling &&
          !xt.ptyScrolling.skipped &&
          metricRow({
            target: "node-pty→xterm",
            ms: xt.ptyScrolling.ms,
            bytes: xt.ptyScrolling.bytesIn,
            extra: `write p99 ${formatMs(xt.ptyScrolling.writeLag?.p99)}`,
          }),
      ].filter(Boolean),
    );

    printCase(
      "Unicode / wide chars",
      [
        td?.unicode &&
          metricRow({
            target: "ghosttead",
            ms: td.unicode.ms,
            bytes: td.unicode.bytesIn,
            extra: `${td.unicode.frames} frames`,
          }),
        xt?.ptyUnicode &&
          !xt.ptyUnicode.skipped &&
          metricRow({
            target: "node-pty→xterm",
            ms: xt.ptyUnicode.ms,
            bytes: xt.ptyUnicode.bytesIn,
            extra: `${xt.ptyUnicode.chunks ?? "?"} chunks`,
          }),
      ].filter(Boolean),
    );

    printCase(
      "Full-screen redraws",
      [
        td?.scrollRegion &&
          metricRow({
            target: "ghosttead",
            ms: td.scrollRegion.ms,
            bytes: td.scrollRegion.bytesIn,
            extra: `${td.scrollRegion.frames} frames`,
          }),
        xt?.ptyScrollRegion &&
          !xt.ptyScrollRegion.skipped &&
          metricRow({
            target: "node-pty→xterm",
            ms: xt.ptyScrollRegion.ms,
            bytes: xt.ptyScrollRegion.bytesIn,
            extra: `${xt.ptyScrollRegion.chunks ?? "?"} chunks`,
          }),
      ].filter(Boolean),
    );

    printCase(
      "Responsiveness under PTY flood",
      [
        td?.controlRttUnderFlood &&
          controlRow({
            target: "ghosttead control RTT",
            summary: td.controlRttUnderFlood,
            extra: "get-session during flood",
          }),
        td?.interruptUnderFlood &&
          controlRow({
            target: "ghosttead interrupt RPC",
            summary: td.interruptUnderFlood,
            extra: "interrupt while flooding",
          }),
        xt?.eventLoopUnderPtyFlood &&
          controlRow({
            target: "node-pty+xterm event-loop",
            summary: xt.eventLoopUnderPtyFlood,
            extra: "lag while PTY floods xterm",
          }),
      ].filter(Boolean),
    );

    printCase(
      "Multi-session PTY flood",
      [
        td?.multiSession &&
          metricRow({
            target: `ghosttead ×${td.multiSession.sessions}`,
            ms: td.multiSession.ms,
            bytes: td.multiSession.bytesIn,
            extra: "attached sessions",
          }),
        xt?.multiPty &&
          metricRow({
            target: `node-pty→xterm ×${xt.multiPty.sessions}`,
            ms: xt.multiPty.ms,
            bytes: xt.multiPty.bytesIn,
            extra: "N ptys + N Terminals",
          }),
      ].filter(Boolean),
    );

    if (xt?.scrollingParse || xt?.denseParse) {
      printCase(
        "Decomposition only (xterm.write, no PTY — not the product comparison)",
        [
          xt?.denseParse &&
            metricRow({
              target: "xterm write-only dense",
              ms: xt.denseParse.ms,
              bytes: xt.denseParse.bytesIn,
              extra: "no PTY",
            }),
          xt?.scrollingParse &&
            metricRow({
              target: "xterm write-only scroll",
              ms: xt.scrollingParse.ms,
              bytes: xt.scrollingParse.bytesIn,
              extra: "no PTY",
            }),
        ].filter(Boolean),
      );
    }
  }

  const comparisons = [];
  if (td && xt) {
    for (const [name, tdKey, xtKey] of [
      ["dense (PTY)", "dense", "ptyDense"],
      ["scrolling (PTY)", "scrolling", "ptyScrolling"],
      ["unicode (PTY)", "unicode", "ptyUnicode"],
      ["scrollRegion (PTY)", "scrollRegion", "ptyScrollRegion"],
      ["multi-session (PTY)", "multiSession", "multiPty"],
    ]) {
      const cmp = compareThroughput(name, td[tdKey], xt[xtKey]);
      if (cmp) comparisons.push(cmp);
    }
  }

  if (comparisons.length > 0) {
    console.log("## Head-to-head (lower wall time is better)");
    console.log("Fair fight: both paths use a real PTY and process the same payload bytes.");
    console.log("");
    for (const cmp of comparisons) {
      console.log(
        `- ${cmp.case}: ghosttead ${formatMs(cmp.ghostteadMs)} vs node-pty+xterm ${formatMs(cmp.xtermMs)} → ${cmp.note}`,
      );
    }
    console.log("");
  }

  console.log("## Native Ghostty (manual)");
  console.log("  time BENCH_SCALE=" + options.scale + " ./bench/workloads/manual-cat.sh scrolling");
  console.log("  time BENCH_SCALE=" + options.scale + " ./bench/workloads/manual-cat.sh dense");
  console.log("");
  console.log("## Notes");
  console.log("- Primary rows are node-pty→xterm, the classic Electron embed stack.");
  console.log("- Pure xterm.write rows are decomposition only (parser cost without PTY).");
  console.log("- ghosttead includes VT + native shaping + TRF1 frames (sidecar path before WebGPU).");
  console.log("- Full Electron UI + WebGPU is not timed here.");
  console.log("- If node-pty says posix_spawnp failed: node scripts/fix-node-pty.mjs");

  const report = toJsonReport({ ...results, comparisons }, meta);
  if (options.json) {
    writeFileSync(options.json, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`\nWrote JSON report to ${options.json}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
