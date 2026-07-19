import assert from "node:assert/strict";
import test from "node:test";

import { releaseBlockers, validateEvidence } from "../scripts/check-ios-instruments-evidence.mjs";

test("full reviewed trace evidence is release-eligible", () => {
  const evidence = makeEvidence();
  assert.equal(validateEvidence(evidence), evidence);
  assert.deepEqual(releaseBlockers(evidence), []);
});

test("quick, partial, and unreviewed evidence fails closed", () => {
  const evidence = makeEvidence();
  evidence.quickMode = true;
  evidence.releaseMode = false;
  evidence.review.cpu = "pending";
  evidence.traces.pop();
  const blockers = releaseBlockers(validateEvidence(evidence));
  assert(blockers.some((item) => item.includes("not a full release-mode")));
  assert(blockers.some((item) => item.includes("3 of 4")));
  assert(blockers.some((item) => item.includes("CPU trace review")));
  assert(blockers.some((item) => item.includes("rendered-output-8")));
});

test("evidence rejects identity-bearing unknown fields", () => {
  const evidence = makeEvidence();
  evidence.device.name = "personal phone";
  assert.throws(() => validateEvidence(evidence), /unexpected keys: name/);
});

test("evidence rejects arbitrary blocker text", () => {
  const evidence = makeEvidence();
  evidence.status = "blocked";
  evidence.blockers = ["arbitrary private context"];
  assert.throws(() => validateEvidence(evidence), /not part of the redacted schema/);
});

test("release evidence requires the full scenario durations", () => {
  const evidence = makeEvidence();
  evidence.traces.find((item) => item.id === "idle").durationSeconds = 59.9;
  assert(releaseBlockers(validateEvidence(evidence)).some((item) => item.includes("shorter than 60s")));
});

function makeEvidence() {
  const scenarios = [
    ["idle", 60],
    ["rendered-output-1", 120],
    ["rendered-output-4", 120],
    ["rendered-output-8", 120],
  ];
  return {
    schemaVersion: 1,
    status: "captured",
    sourceRevision: "a".repeat(40),
    sourceClean: true,
    releaseMode: true,
    quickMode: false,
    appBundleSha256: "b".repeat(64),
    recordedAt: "2026-07-18T12:00:00Z",
    toolchain: {
      xcodeVersion: "26.6",
      xcodeBuild: "17G45",
      iphoneOSSDKVersion: "26.5",
      xctraceVersion: "26.0 (17G45)",
    },
    device: {
      modelIdentifier: "iPhone15,2",
      systemVersion: "26.5.2",
      developerModeEnabled: true,
      ddiServicesAvailable: true,
    },
    protocol: {
      template: "Time Profiler",
      instruments: ["Metal Application", "Points of Interest", "Power Profiler", "Thermal State"],
      scenarios: scenarios.map(([id, durationSeconds]) => ({ id, durationSeconds })),
    },
    review: { cpu: "pass", energy: "pass" },
    traces: scenarios.map(([id, durationSeconds]) => ({
      id,
      durationSeconds,
      traceBundleSha256: "c".repeat(64),
      tocSha256: "d".repeat(64),
    })),
    blockers: [],
  };
}
