import { bootstrapRelativeMedianDelta, median } from "../../render/lib/compare.mjs";

function metricSummary(sample, metric) {
  return sample.performance?.summaries?.find((summary) => summary.metric === metric);
}

function milliseconds(nanoseconds) {
  return Number.isFinite(nanoseconds) ? nanoseconds / 1_000_000 : null;
}

export const METRICS = [
  {
    key: "activeMs",
    label: "active operation wall",
    unit: "ms",
    direction: "lower",
    select: (sample) => milliseconds(sample.activeNanoseconds),
  },
  {
    key: "operationP50Ms",
    label: "operation p50",
    unit: "ms",
    direction: "lower",
    select: (sample) => milliseconds(sample.operationP50Nanoseconds),
  },
  {
    key: "operationP99Ms",
    label: "operation p99",
    unit: "ms",
    direction: "lower",
    select: (sample) => milliseconds(sample.operationP99Nanoseconds),
  },
  ...[
    ["truffleStateDecode", "Truffle state decode"],
    ["truffleReplicaPublication", "Truffle replica publication"],
    ["nativeFeed", "native feed"],
    ["textEngineLockWait", "text-engine wait"],
    ["textEngineLockHold", "text-engine hold"],
    ["frameDecode", "TRF1 retained apply"],
    ["accessibilityUpdate", "accessibility update"],
    ["glyphVisibility", "glyph visibility"],
    ["atlasSynchronization", "atlas synchronization"],
    ["meshBuild", "mesh build"],
    ["metalEncoding", "Metal encode/commit"],
    ["metalSubmission", "Metal submission path"],
  ].map(([key, label]) => ({
    key: `${key}TotalMs`,
    label: `${label} total`,
    unit: "ms",
    direction: "lower",
    select: (sample) => milliseconds(metricSummary(sample, key)?.totalNanoseconds),
  })),
  {
    key: "sourceBytes",
    label: "source payload",
    unit: "bytes",
    direction: "lower",
    select: (sample) => sample.sourceBytes,
  },
  {
    key: "metalGPUCompletionP99Ms",
    label: "GPU completion p99",
    unit: "ms",
    direction: "lower",
    select: (sample) => milliseconds(metricSummary(sample, "metalGPUCompletion")?.p99Nanoseconds),
  },
  {
    key: "vertexUploadBytes",
    label: "vertex upload",
    unit: "bytes",
    direction: "lower",
    select: (sample) => sample.renderer?.vertexUploadBytes,
  },
  {
    key: "bufferAllocations",
    label: "Metal buffer allocations",
    unit: "count",
    direction: "lower",
    select: (sample) => sample.renderer?.bufferAllocations,
  },
  {
    key: "drawCalls",
    label: "draw calls",
    unit: "count",
    direction: "lower",
    select: (sample) => sample.renderer?.drawCalls,
  },
  {
    key: "residentAtlasBytes",
    label: "resident atlas bytes",
    unit: "bytes",
    direction: "lower",
    select: (sample) => sample.renderer?.residentAtlasBytes,
  },
  {
    key: "footprintAfterBytes",
    label: "process footprint",
    unit: "bytes",
    direction: "lower",
    select: (sample) => sample.footprintAfterBytes,
  },
];

function comparableConfiguration(report, options = {}) {
  const configuration = structuredClone(report.config);
  if (options.allowGeometryReuseDifference) delete configuration?.encodedGeometryReuseEnabled;
  if (options.allowStateCodecDifference) delete configuration?.truffleStateCodec;
  return {
    suite: report.suite,
    configuration,
    device: {
      model: report.device?.model,
      systemVersion: report.device?.systemVersion,
      maximumFramesPerSecond: report.device?.maximumFramesPerSecond,
      physicalMemoryBytes: report.device?.physicalMemoryBytes,
      processorCount: report.device?.processorCount,
    },
    framePacingNanoseconds: report.framePacingNanoseconds,
    xcode: report.runner?.xcode,
  };
}

const invariantKeys = [
  "operations",
  "surfaceCount",
  "sourceBytes",
  "trf1Bytes",
  "pixelHash",
  "nonBackgroundPixelCount",
];

export function validateComparableReports(baseline, candidate, options = {}) {
  const issues = [];
  if (
    JSON.stringify(comparableConfiguration(baseline, options)) !==
    JSON.stringify(comparableConfiguration(candidate, options))
  ) {
    issues.push("device, toolchain, suite, or workload configuration differs");
  }
  for (const [label, report] of [
    ["baseline", baseline],
    ["candidate", candidate],
  ]) {
    if (report.runner?.gitDirty) issues.push(`${label} was captured from a dirty worktree`);
    const accepted = new Set(report.runner?.acceptedUntrackedFiles ?? []);
    const unexpected = (report.runner?.gitUntrackedFiles ?? []).filter((path) => !accepted.has(path));
    if (unexpected.length > 0) {
      issues.push(`${label} contained unaccepted untracked files: ${unexpected.join(", ")}`);
    }
    if (report.device?.lowPowerModeEnabled) issues.push(`${label} used Low Power Mode`);
    if ((report.failures ?? []).length > 0) issues.push(`${label} contains failed benchmark samples`);
    for (const [caseName, result] of Object.entries(report.results?.cases ?? {})) {
      if (result.samples?.length !== report.config?.measuredIterations) {
        issues.push(`${label}/${caseName} has an incomplete repetition count`);
      }
      for (const sample of result.samples ?? []) {
        if (sample.thermalStateBefore !== "nominal" || sample.thermalStateAfter !== "nominal") {
          issues.push(`${label}/${caseName} was not thermally nominal`);
        }
      }
    }
  }

  const baselineCases = baseline.results?.cases ?? {};
  const candidateCases = candidate.results?.cases ?? {};
  for (const [caseName, baselineCase] of Object.entries(baselineCases)) {
    const candidateCase = candidateCases[caseName];
    if (!candidateCase) {
      issues.push(`candidate is missing case ${caseName}`);
      continue;
    }
    const comparableInvariantKeys = options.allowStateCodecDifference
      ? invariantKeys.filter((key) => key !== "sourceBytes")
      : invariantKeys;
    for (const key of comparableInvariantKeys) {
      const left = baselineCase.samples.map((sample) => sample[key]);
      const right = candidateCase.samples.map((sample) => sample[key]);
      if (JSON.stringify(left) !== JSON.stringify(right)) {
        issues.push(`${caseName} changed the ${key} correctness invariant`);
      }
    }
    for (const key of ["acceptedFrames", "renderedFrames", "staleFrames", "fullRefreshRequests"]) {
      const left = baselineCase.samples.map((sample) => sample.renderer?.[key]);
      const right = candidateCase.samples.map((sample) => sample.renderer?.[key]);
      if (JSON.stringify(left) !== JSON.stringify(right)) {
        issues.push(`${caseName} changed the renderer ${key} invariant`);
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
      if (baselineValues.length === 0 && candidateValues.length === 0) continue;
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
