import { formatMBps, formatMs, formatMbps } from "./stats.mjs";

export function printHeader(meta) {
  console.log("=== Electron Ghostty terminal benchmark ===");
  console.log(`host: ${meta.host}`);
  console.log(`node: ${meta.node}`);
  console.log(`platform: ${meta.platform}`);
  console.log(`scale: ${meta.scale}`);
  console.log(`targets: ${meta.targets.join(", ")}`);
  console.log("");
}

export function printCase(name, rows) {
  console.log(`## ${name}`);
  const width = Math.max(12, ...rows.map((row) => row.target.length));
  console.log(
    `${"target".padEnd(width)}  ${"time".padStart(12)}  ${"throughput".padStart(14)}  ${"extra".padStart(28)}`,
  );
  for (const row of rows) {
    console.log(
      `${row.target.padEnd(width)}  ${String(row.time).padStart(12)}  ${String(row.throughput).padStart(14)}  ${String(row.extra ?? "").padStart(28)}`,
    );
  }
  console.log("");
}

export function metricRow({ target, ms, bytes, extra }) {
  return {
    target,
    time: formatMs(ms),
    throughput: bytes != null ? formatMBps(bytes, ms) : "—",
    extra: extra ?? "",
  };
}

export function controlRow({ target, summary, extra }) {
  return {
    target,
    time: `p50 ${formatMs(summary.p50)} / p99 ${formatMs(summary.p99)}`,
    throughput: "—",
    extra: extra ?? `n=${summary.count}`,
  };
}

export function toJsonReport(results, meta) {
  return {
    generatedAt: new Date().toISOString(),
    meta,
    results,
  };
}

export { formatMBps, formatMs, formatMbps };
