import assert from "node:assert/strict";
import test from "node:test";
import {
  bootstrapRelativeMedianDelta,
  compareMetric,
  median,
  percentile,
  validateComparableReports,
} from "./lib/compare.mjs";

test("percentile and median interpolate stable distributions", () => {
  assert.equal(percentile([1, 2, 3, 4], 50), 2.5);
  assert.equal(median([4, 1, 3, 2]), 2.5);
});

test("comparison requires both practical and statistical evidence", () => {
  assert.equal(compareMetric([100, 101, 99, 100, 102], [78, 80, 81, 79, 80]).assessment, "improved");
  assert.equal(compareMetric([100, 101, 99, 100, 102], [119, 120, 121, 122, 120]).assessment, "regressed");
  assert.equal(compareMetric([100, 95, 105, 98, 102], [99, 104, 96, 103, 98]).assessment, "inconclusive");
});

test("bootstrap output is deterministic", () => {
  assert.deepEqual(
    bootstrapRelativeMedianDelta([10, 11, 12], [8, 9, 10]),
    bootstrapRelativeMedianDelta([10, 11, 12], [8, 9, 10]),
  );
});

test("comparison gate rejects dirty or mismatched runs", () => {
  const report = {
    config: {
      suite: "suite",
      width: 100,
      height: 100,
      cases: [],
      runner: { host: "host", platform: "os", cpu: "cpu", gitDirty: false },
    },
    electron: { versions: { electron: "1", chrome: "1" }, display: { scaleFactor: 2 }, finalThermalState: "nominal" },
    results: { cases: {} },
  };
  assert.deepEqual(validateComparableReports(report, structuredClone(report)), []);
  const dirty = structuredClone(report);
  dirty.config.runner.gitDirty = true;
  assert.deepEqual(validateComparableReports(report, dirty), ["candidate was captured from a dirty worktree"]);
  const mismatch = structuredClone(report);
  mismatch.config.width = 200;
  assert.deepEqual(validateComparableReports(report, mismatch), [
    "machine, display, runtime, suite, or workload configuration differs",
  ]);
});
