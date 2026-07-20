export function percentile(sorted, value) {
  if (sorted.length === 0) return null;
  if (sorted.length === 1) return sorted[0];
  const rank = (value / 100) * (sorted.length - 1);
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  const fraction = rank - lower;
  return sorted[lower] * (1 - fraction) + sorted[upper] * fraction;
}

export function median(values) {
  return percentile(
    [...values].sort((left, right) => left - right),
    50,
  );
}

export function sum(values) {
  return values.reduce((total, value) => total + value, 0);
}

export function mean(values) {
  return values.length === 0 ? null : sum(values) / values.length;
}

function processValue(iteration, selector) {
  const samples = iteration.electron?.samples ?? [];
  const values = samples.map((sample) => selector(sample.processes ?? []));
  return values.length === 0 ? null : values;
}

export const METRICS = [
  { key: "endToIdleMs", label: "end-to-idle", unit: "ms", select: (iteration) => iteration.endToIdleMs },
  {
    key: "renderCpuMs",
    label: "worker render CPU",
    unit: "ms",
    select: (iteration) => sum(iteration.worker.samples.renderCpuMs),
  },
  {
    key: "frameApplyCpuMs",
    label: "worker frame apply CPU",
    unit: "ms",
    select: (iteration) => sum(iteration.worker.samples.frameApplyMs),
  },
  {
    key: "arrivalToRenderP99Ms",
    label: "frame arrival→render p99",
    unit: "ms",
    select: (iteration) =>
      percentile(
        [...iteration.worker.samples.frameArrivalToRenderMs].sort((a, b) => a - b),
        99,
      ),
  },
  {
    key: "vertexUploadBytes",
    label: "vertex upload",
    unit: "bytes",
    select: (iteration) => iteration.worker.renderer.vertexUploadBytes,
  },
  {
    key: "renderCalls",
    label: "render calls",
    unit: "count",
    select: (iteration) => iteration.worker.scheduling.renderCalls,
  },
  {
    key: "canvasPixelFrames",
    label: "canvas pixel-frames",
    unit: "pixels",
    select: (iteration) => iteration.worker.renderer.canvasPixelFrames,
  },
  {
    key: "gpuQueueDrainMs",
    label: "GPU queue drain",
    unit: "ms",
    select: (iteration) => iteration.worker.gpuQueueDrainMs,
  },
  {
    key: "totalCpuPercent",
    label: "Electron total CPU",
    unit: "%",
    select: (iteration) => {
      const values = processValue(iteration, (processes) => sum(processes.map((process) => process.cpuPercent ?? 0)));
      return values ? mean(values) : null;
    },
  },
  {
    key: "workingSetBytes",
    label: "Electron working set peak",
    unit: "bytes",
    select: (iteration) => {
      const values = processValue(iteration, (processes) =>
        sum(processes.map((process) => process.workingSetBytes ?? 0)),
      );
      return values ? Math.max(...values) : null;
    },
  },
];

function seededRandom(seed = 0x6d2b79f5) {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

export function bootstrapRelativeMedianDelta(baseline, candidate, samples = 5_000) {
  if (baseline.length === 0 || candidate.length === 0) return { median: null, low: null, high: null };
  const random = seededRandom();
  const deltas = [];
  for (let sample = 0; sample < samples; sample += 1) {
    const sampledBaseline = Array.from(
      { length: baseline.length },
      () => baseline[Math.floor(random() * baseline.length)],
    );
    const sampledCandidate = Array.from(
      { length: candidate.length },
      () => candidate[Math.floor(random() * candidate.length)],
    );
    const baselineMedian = median(sampledBaseline);
    const candidateMedian = median(sampledCandidate);
    if (baselineMedian && candidateMedian != null) {
      deltas.push(((candidateMedian - baselineMedian) / baselineMedian) * 100);
    }
  }
  deltas.sort((left, right) => left - right);
  const baselineMedian = median(baseline);
  const candidateMedian = median(candidate);
  return {
    median:
      baselineMedian && candidateMedian != null ? ((candidateMedian - baselineMedian) / baselineMedian) * 100 : null,
    low: percentile(deltas, 2.5),
    high: percentile(deltas, 97.5),
  };
}

export function compareMetric(baseline, candidate, noiseThresholdPercent = 3) {
  const delta = bootstrapRelativeMedianDelta(baseline, candidate);
  let assessment = "inconclusive";
  if (
    delta.median != null &&
    delta.low != null &&
    delta.high != null &&
    delta.median <= -noiseThresholdPercent &&
    delta.high < 0
  ) {
    assessment = "improved";
  } else if (
    delta.median != null &&
    delta.low != null &&
    delta.high != null &&
    delta.median >= noiseThresholdPercent &&
    delta.low > 0
  ) {
    assessment = "regressed";
  }
  return {
    baselineMedian: median(baseline),
    candidateMedian: median(candidate),
    deltaPercent: delta.median,
    confidenceInterval95: [delta.low, delta.high],
    assessment,
  };
}

export function compareReports(baselineReport, candidateReport, noiseThresholdPercent = 3) {
  const comparisons = [];
  const baselineCases = baselineReport.results?.cases ?? {};
  const candidateCases = candidateReport.results?.cases ?? {};
  for (const caseName of Object.keys(baselineCases)) {
    if (!candidateCases[caseName]) continue;
    for (const metric of METRICS) {
      const baseline = baselineCases[caseName].map(metric.select).filter(Number.isFinite);
      const candidate = candidateCases[caseName].map(metric.select).filter(Number.isFinite);
      comparisons.push({
        caseName,
        metric: metric.key,
        label: metric.label,
        unit: metric.unit,
        samples: { baseline: baseline.length, candidate: candidate.length },
        ...compareMetric(baseline, candidate, noiseThresholdPercent),
      });
    }
  }
  return comparisons;
}

function comparableConfiguration(report) {
  const config = report.config ?? {};
  const display = report.electron?.display ?? {};
  return {
    suite: config.suite,
    width: config.width,
    height: config.height,
    cols: config.cols,
    rows: config.rows,
    warmupIterations: config.warmupIterations,
    measuredIterations: config.measuredIterations,
    cooldownMs: config.cooldownMs,
    quietMs: config.quietMs,
    cases: (config.cases ?? []).map(({ payloadPath: _payloadPath, ...benchmarkCase }) => benchmarkCase),
    host: config.runner?.host,
    platform: config.runner?.platform,
    cpu: config.runner?.cpu,
    electron: report.electron?.versions?.electron,
    chrome: report.electron?.versions?.chrome,
    display: {
      size: display.size,
      scaleFactor: display.scaleFactor,
      displayFrequency: display.displayFrequency,
      colorSpace: display.colorSpace,
    },
  };
}

export function validateComparableReports(baselineReport, candidateReport) {
  const issues = [];
  if (
    JSON.stringify(comparableConfiguration(baselineReport)) !== JSON.stringify(comparableConfiguration(candidateReport))
  ) {
    issues.push("machine, display, runtime, suite, or workload configuration differs");
  }
  for (const [label, report] of [
    ["baseline", baselineReport],
    ["candidate", candidateReport],
  ]) {
    if (report.config?.runner?.gitDirty) issues.push(`${label} was captured from a dirty worktree`);
    const untracked = report.config?.runner?.gitUntrackedFiles ?? [];
    const accepted = new Set(report.config?.runner?.acceptedUntrackedFiles ?? []);
    const unexpectedUntracked = untracked.filter((path) => !accepted.has(path));
    if (unexpectedUntracked.length > 0) {
      issues.push(`${label} contained unaccepted untracked files: ${unexpectedUntracked.join(", ")}`);
    }
    if (["serious", "critical"].includes(report.electron?.finalThermalState)) {
      issues.push(`${label} ended at ${report.electron.finalThermalState} thermal state`);
    }
    for (const [caseName, iterations] of Object.entries(report.results?.cases ?? {})) {
      for (const iteration of iterations) {
        if (iteration.worker?.backend !== "webgpu") issues.push(`${label}/${caseName} did not use WebGPU`);
        if (iteration.worker?.timedOutWaitingForIdle) issues.push(`${label}/${caseName} timed out waiting for idle`);
        if (iteration.electron?.samples?.some((sample) => ["serious", "critical"].includes(sample.thermalState))) {
          issues.push(`${label}/${caseName} sampled a serious or critical thermal state`);
        }
      }
    }
  }
  return [...new Set(issues)];
}
