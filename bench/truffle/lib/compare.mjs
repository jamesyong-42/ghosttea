import { bootstrapRelativeMedianDelta, median } from "../../render/lib/compare.mjs";

export const METRICS = [
  { key: "wallMs", label: "wall", unit: "ms", direction: "lower", select: (sample) => sample.wallMs },
  {
    key: "producerEncodeMs",
    label: "producer encode work",
    unit: "ms",
    direction: "lower",
    select: (sample) => sample.producerEncodeMs,
  },
  {
    key: "producerWriteMs",
    label: "producer write wait",
    unit: "ms",
    direction: "lower",
    select: (sample) => sample.producerWriteMs,
  },
  {
    key: "receiverDecodeMs",
    label: "receiver decode work",
    unit: "ms",
    direction: "lower",
    select: (sample) => sample.receiverDecodeMs,
  },
  {
    key: "replicaApplyMs",
    label: "replica apply work/wait",
    unit: "ms",
    direction: "lower",
    select: (sample) => sample.replicaApplyMs,
  },
  {
    key: "latencyP50Ms",
    label: "enqueue→apply p50",
    unit: "ms",
    direction: "lower",
    select: (sample) => sample.latency.p50Ms,
  },
  {
    key: "latencyP95Ms",
    label: "enqueue→apply p95",
    unit: "ms",
    direction: "lower",
    select: (sample) => sample.latency.p95Ms,
  },
  {
    key: "latencyP99Ms",
    label: "enqueue→apply p99",
    unit: "ms",
    direction: "lower",
    select: (sample) => sample.latency.p99Ms,
  },
  {
    key: "throughputMibPerSecond",
    label: "wire throughput",
    unit: "MiB/s",
    direction: "higher",
    select: (sample) => sample.throughputMibPerSecond,
  },
  {
    key: "userCpuMs",
    label: "process user CPU",
    unit: "ms",
    direction: "lower",
    select: (sample) => sample.userCpuMs,
  },
  {
    key: "systemCpuMs",
    label: "process system CPU",
    unit: "ms",
    direction: "lower",
    select: (sample) => sample.systemCpuMs,
  },
  {
    key: "peakRssBytes",
    label: "process peak RSS",
    unit: "bytes",
    direction: "lower",
    select: (sample) => sample.peakRssBytes,
  },
];

function comparableConfiguration(report) {
  return {
    suite: report.suite,
    transport: report.transport,
    cols: report.config?.cols,
    rows: report.config?.rows,
    iterations: report.config?.iterations,
    warmup: report.config?.warmup,
    scale: report.config?.scale,
    duplexBytes: report.config?.duplexBytes,
    configuredTransport: report.config?.transport,
    cases: report.config?.cases,
    host: report.runner?.host,
    platform: report.runner?.platform,
    cpu: report.runner?.cpu,
    logicalCpuCount: report.runner?.logicalCpuCount,
    rustc: report.runner?.rustc,
  };
}

function invariantValues(result, key) {
  return result.samples.map((sample) => sample[key]);
}

export function validateComparableReports(baseline, candidate) {
  const issues = [];
  if (JSON.stringify(comparableConfiguration(baseline)) !== JSON.stringify(comparableConfiguration(candidate))) {
    issues.push("machine, runtime, suite, or workload configuration differs");
  }
  for (const [label, report] of [
    ["baseline", baseline],
    ["candidate", candidate],
  ]) {
    if (report.runner?.gitDirty) issues.push(`${label} was captured from a dirty worktree`);
    const accepted = new Set(report.runner?.acceptedUntrackedFiles ?? []);
    const unexpected = (report.runner?.gitUntrackedFiles ?? []).filter((path) => !accepted.has(path));
    if (unexpected.length > 0) issues.push(`${label} contained unaccepted untracked files: ${unexpected.join(", ")}`);
  }
  const baselineCases = baseline.results?.cases ?? {};
  const candidateCases = candidate.results?.cases ?? {};
  for (const caseName of Object.keys(baselineCases)) {
    if (!candidateCases[caseName]) {
      issues.push(`candidate is missing case ${caseName}`);
      continue;
    }
    for (const key of ["sourceWireBytes", "trf1Bytes", "messagesReceived", "checksum"]) {
      const left = invariantValues(baselineCases[caseName], key);
      const right = invariantValues(candidateCases[caseName], key);
      if (JSON.stringify(left) !== JSON.stringify(right)) {
        issues.push(`${caseName} changed the ${key} correctness invariant`);
      }
    }
  }
  for (const caseName of Object.keys(candidateCases)) {
    if (!baselineCases[caseName]) issues.push(`baseline is missing case ${caseName}`);
  }
  return [...new Set(issues)];
}

export function compareReports(baseline, candidate, noiseThresholdPercent = 3) {
  const comparisons = [];
  for (const [caseName, baselineResult] of Object.entries(baseline.results?.cases ?? {})) {
    const candidateResult = candidate.results?.cases?.[caseName];
    if (!candidateResult) continue;
    for (const metric of METRICS) {
      const baselineValues = baselineResult.samples.map(metric.select).filter(Number.isFinite);
      const candidateValues = candidateResult.samples.map(metric.select).filter(Number.isFinite);
      const delta = bootstrapRelativeMedianDelta(baselineValues, candidateValues);
      let assessment = "inconclusive";
      if (delta.median != null && delta.low != null && delta.high != null) {
        const improved =
          metric.direction === "lower"
            ? delta.median <= -noiseThresholdPercent && delta.high < 0
            : delta.median >= noiseThresholdPercent && delta.low > 0;
        const regressed =
          metric.direction === "lower"
            ? delta.median >= noiseThresholdPercent && delta.low > 0
            : delta.median <= -noiseThresholdPercent && delta.high < 0;
        if (improved) assessment = "improved";
        else if (regressed) assessment = "regressed";
      }
      comparisons.push({
        caseName,
        metric: metric.key,
        label: metric.label,
        unit: metric.unit,
        direction: metric.direction,
        samples: { baseline: baselineValues.length, candidate: candidateValues.length },
        baselineMedian: median(baselineValues),
        candidateMedian: median(candidateValues),
        deltaPercent: delta.median,
        confidenceInterval95: [delta.low, delta.high],
        assessment,
      });
    }
  }
  return comparisons;
}
