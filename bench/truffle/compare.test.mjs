import assert from "node:assert/strict";
import test from "node:test";
import { compareReports, formatMetricValue, validateComparableReports } from "./lib/compare.mjs";

function report(values, overrides = {}) {
  const samples = values.map((wallMs) => ({
    wallMs,
    producerEncodeMs: wallMs / 10,
    producerWriteMs: wallMs / 20,
    receiverDecodeMs: wallMs / 8,
    replicaApplyMs: wallMs / 2,
    textEngineWaitMs: wallMs / 20,
    textEngineHoldMs: wallMs / 3,
    replicaOtherMs: wallMs / 8,
    replicaRowPrepareMs: wallMs / 20,
    trf1EncodeMs: wallMs / 12,
    latency: { p50Ms: wallMs / 4, p95Ms: wallMs / 3, p99Ms: wallMs / 2 },
    throughputMibPerSecond: 1_000 / wallMs,
    userCpuMs: wallMs / 2,
    systemCpuMs: wallMs / 10,
    peakRssBytes: 10_000,
    sourceWireBytes: 1_024,
    trf1Bytes: 2_048,
    messagesReceived: 10,
    checksum: 42,
  }));
  return {
    suite: "ghosttea-truffle-replication-v1",
    transport: "quic-protocol-loopback",
    config: {
      cols: 120,
      rows: 40,
      iterations: values.length,
      warmup: 1,
      cooldownMs: 250,
      scale: 1,
      duplexBytes: 65_536,
      transport: "quic-protocol-loopback",
      cases: [{ name: "sparse", workload: "sparse", apply: "replica", updates: 9, fanout: 1 }],
    },
    runner: {
      host: "bench-host",
      platform: "darwin/arm64",
      cpu: "Example CPU",
      logicalCpuCount: 8,
      rustc: "rustc example",
      gitDirty: false,
      gitUntrackedFiles: [],
      acceptedUntrackedFiles: [],
    },
    results: { cases: { sparse: { samples } } },
    ...overrides,
  };
}

test("comparison classifies lower latency and higher throughput as improvements", () => {
  const comparisons = compareReports(report([100, 101, 99, 102, 98]), report([70, 71, 69, 72, 68]));
  assert.equal(comparisons.find((metric) => metric.metric === "wallMs").assessment, "improved");
  assert.equal(comparisons.find((metric) => metric.metric === "throughputMibPerSecond").assessment, "improved");
});

test("comparison measures wire-size changes but rejects rendered-output changes", () => {
  const candidate = report([100, 101, 99, 102, 98]);
  candidate.results.cases.sparse.samples[0].sourceWireBytes += 1;
  assert.deepEqual(validateComparableReports(report([100, 101, 99, 102, 98]), candidate), []);
  assert.equal(
    compareReports(report([100, 101, 99, 102, 98]), candidate).find((metric) => metric.metric === "sourceWireBytes")
      .samples.candidate,
    5,
  );
  candidate.results.cases.sparse.samples[0].trf1Bytes += 1;
  assert.deepEqual(validateComparableReports(report([100, 101, 99, 102, 98]), candidate), [
    "sparse changed the trf1Bytes correctness invariant",
  ]);
});

test("comparison rejects dirty and mismatched runs", () => {
  const candidate = report([100, 101, 99, 102, 98]);
  candidate.config.rows = 50;
  candidate.runner.gitDirty = true;
  assert.deepEqual(validateComparableReports(report([100, 101, 99, 102, 98]), candidate), [
    "machine, runtime, suite, or workload configuration differs",
    "candidate was captured from a dirty worktree",
  ]);
});

test("comparison formatting tolerates metrics absent from an older report", () => {
  const baseline = report([100, 101, 99, 102, 98]);
  for (const sample of baseline.results.cases.sparse.samples) {
    delete sample.replicaRowPrepareMs;
  }
  const comparison = compareReports(baseline, report([100, 101, 99, 102, 98])).find(
    (metric) => metric.metric === "replicaRowPrepareMs",
  );
  assert.equal(comparison.baselineMedian, null);
  assert.equal(formatMetricValue(comparison.baselineMedian), "       n/a");
  assert.equal(formatMetricValue(comparison.candidateMedian), "      5.00");
});
