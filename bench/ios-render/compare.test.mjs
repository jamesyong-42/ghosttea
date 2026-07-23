import assert from "node:assert/strict";
import test from "node:test";
import { compareReports, validateComparableReports } from "./lib/compare.mjs";

function sample(value = 100) {
  return {
    operations: 10,
    surfaceCount: 1,
    sourceBytes: 1000,
    trf1Bytes: 2000,
    pixelHash: 1234,
    nonBackgroundPixelCount: 90,
    activeNanoseconds: value * 1_000_000,
    operationP50Nanoseconds: value * 100_000,
    operationP99Nanoseconds: value * 200_000,
    footprintAfterBytes: 50_000_000,
    thermalStateBefore: "nominal",
    thermalStateAfter: "nominal",
    failures: [],
    renderer: {
      acceptedFrames: 10,
      renderedFrames: 10,
      staleFrames: 0,
      fullRefreshRequests: 0,
      vertexUploadBytes: value * 1000,
      bufferAllocations: 60,
      drawCalls: 60,
      residentAtlasBytes: 20 * 1024 * 1024,
    },
    performance: {
      summaries: [
        { metric: "meshBuild", totalNanoseconds: value * 500_000 },
        { metric: "metalSubmission", totalNanoseconds: value * 800_000 },
      ],
    },
  };
}

function report(values = [100, 101, 99, 102, 100]) {
  return {
    suite: "ghosttea-ios-render-v1",
    config: {
      schemaVersion: 1,
      warmupIterations: 1,
      measuredIterations: 5,
      cooldownMilliseconds: 250,
      scale: 1,
      cases: ["typing-1"],
      encodedGeometryReuseEnabled: true,
      inPlaceRetainedStateCommitEnabled: true,
      instancedSubmissionEnabled: true,
      rowGeometryReuseEnabled: true,
      lazyColorAtlasEnabled: true,
      truffleStateCodec: "json",
    },
    runner: {
      gitDirty: false,
      gitUntrackedFiles: [],
      xcode: "Xcode 26.6",
    },
    device: {
      model: "iPhone15,2",
      systemVersion: "26.5.2",
      maximumFramesPerSecond: 120,
      physicalMemoryBytes: 6_000_000_000,
      processorCount: 6,
      lowPowerModeEnabled: false,
    },
    framePacingNanoseconds: 9_333_333,
    results: { cases: { "typing-1": { name: "typing-1", samples: values.map(sample) } } },
    failures: [],
  };
}

test("equivalent clean device reports are comparable", () => {
  assert.deepEqual(validateComparableReports(report(), report()), []);
});

test("comparison rejects correctness and environment drift", () => {
  const baseline = report();
  const changedPixels = structuredClone(baseline);
  changedPixels.results.cases["typing-1"].samples[0].pixelHash = 99;
  assert.ok(
    validateComparableReports(baseline, changedPixels).includes("typing-1 changed the pixelHash correctness invariant"),
  );

  const changedRefresh = structuredClone(baseline);
  changedRefresh.device.maximumFramesPerSecond = 60;
  assert.ok(
    validateComparableReports(baseline, changedRefresh).includes(
      "device, toolchain, suite, or workload configuration differs",
    ),
  );
});

test("comparison allows only an explicit encoded-geometry A/B difference", () => {
  const enabled = report();
  const disabled = structuredClone(enabled);
  disabled.config.encodedGeometryReuseEnabled = false;

  assert.ok(
    validateComparableReports(disabled, enabled).includes(
      "device, toolchain, suite, or workload configuration differs",
    ),
  );
  assert.deepEqual(validateComparableReports(disabled, enabled, { allowGeometryReuseDifference: true }), []);
});

test("comparison allows only codec and source-byte differences for an explicit codec A/B", () => {
  const json = report();
  const compact = structuredClone(json);
  compact.config.truffleStateCodec = "compact-json-v1";
  for (const sample of compact.results.cases["typing-1"].samples) sample.sourceBytes = 400;

  assert.ok(
    validateComparableReports(json, compact).includes("device, toolchain, suite, or workload configuration differs"),
  );
  assert.ok(
    validateComparableReports(json, compact).includes("typing-1 changed the sourceBytes correctness invariant"),
  );
  assert.deepEqual(validateComparableReports(json, compact, { allowStateCodecDifference: true }), []);

  compact.results.cases["typing-1"].samples[0].trf1Bytes += 1;
  assert.ok(
    validateComparableReports(json, compact, { allowStateCodecDifference: true }).includes(
      "typing-1 changed the trf1Bytes correctness invariant",
    ),
  );
});

test("comparison allows only an explicit retained-state commit A/B difference", () => {
  const inPlace = report();
  const copied = structuredClone(inPlace);
  copied.config.inPlaceRetainedStateCommitEnabled = false;

  assert.ok(
    validateComparableReports(copied, inPlace).includes("device, toolchain, suite, or workload configuration differs"),
  );
  assert.deepEqual(
    validateComparableReports(copied, inPlace, {
      allowRetainedStateCommitDifference: true,
    }),
    [],
  );
});

test("comparison allows only an explicit instanced-submission A/B difference", () => {
  const instanced = report();
  const expanded = structuredClone(instanced);
  expanded.config.instancedSubmissionEnabled = false;

  assert.ok(
    validateComparableReports(expanded, instanced).includes(
      "device, toolchain, suite, or workload configuration differs",
    ),
  );
  assert.deepEqual(
    validateComparableReports(expanded, instanced, {
      allowInstancedSubmissionDifference: true,
    }),
    [],
  );
});

test("comparison allows only an explicit row-geometry reuse A/B difference", () => {
  const cached = report();
  const direct = structuredClone(cached);
  direct.config.rowGeometryReuseEnabled = false;

  assert.ok(
    validateComparableReports(direct, cached).includes("device, toolchain, suite, or workload configuration differs"),
  );
  assert.deepEqual(
    validateComparableReports(direct, cached, {
      allowRowGeometryReuseDifference: true,
    }),
    [],
  );
});

test("comparison allows only an explicit lazy color-atlas A/B difference", () => {
  const lazy = report();
  const eager = structuredClone(lazy);
  eager.config.lazyColorAtlasEnabled = false;

  assert.ok(
    validateComparableReports(eager, lazy).includes("device, toolchain, suite, or workload configuration differs"),
  );
  assert.deepEqual(
    validateComparableReports(eager, lazy, {
      allowLazyColorAtlasDifference: true,
    }),
    [],
  );
});

test("comparison classifies a practical statistically stable improvement", () => {
  const comparisons = compareReports(report(), report([70, 71, 69, 72, 70]));
  assert.equal(comparisons.find((value) => value.metric === "activeMs")?.assessment, "improved");
});
