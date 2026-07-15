/**
 * Lightweight stats helpers for the terminal benchmark harness.
 */

export function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  if (sorted.length === 1) return sorted[0];
  const rank = (p / 100) * (sorted.length - 1);
  const low = Math.floor(rank);
  const high = Math.ceil(rank);
  if (low === high) return sorted[low];
  const weight = rank - low;
  return sorted[low] * (1 - weight) + sorted[high] * weight;
}

export function summarize(samples) {
  if (samples.length === 0) {
    return { count: 0, min: null, max: null, mean: null, p50: null, p90: null, p99: null };
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const sum = sorted.reduce((total, value) => total + value, 0);
  return {
    count: sorted.length,
    min: sorted[0],
    max: sorted[sorted.length - 1],
    mean: sum / sorted.length,
    p50: percentile(sorted, 50),
    p90: percentile(sorted, 90),
    p99: percentile(sorted, 99),
  };
}

export function formatMs(value) {
  if (value === null || value === undefined || Number.isNaN(value)) return "n/a";
  if (value < 1) return `${value.toFixed(3)} ms`;
  if (value < 100) return `${value.toFixed(2)} ms`;
  return `${value.toFixed(1)} ms`;
}

export function formatMbps(bytes, ms) {
  if (!ms || ms <= 0) return "n/a";
  const mbps = (bytes * 8) / (ms / 1000) / 1_000_000;
  return `${mbps.toFixed(2)} Mb/s`;
}

export function formatMBps(bytes, ms) {
  if (!ms || ms <= 0) return "n/a";
  const mbps = bytes / (ms / 1000) / (1024 * 1024);
  return `${mbps.toFixed(2)} MiB/s`;
}

export function nowMs() {
  return performance.now();
}

/**
 * Measure event-loop lag by scheduling a timer and seeing how late it fires.
 */
export function measureEventLoopLag(sampleMs = 0) {
  return new Promise((resolve) => {
    const start = nowMs();
    setTimeout(() => resolve(nowMs() - start - sampleMs), sampleMs);
  });
}
