import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  mergeEvidence,
  parseScenarioArguments,
  validateReleaseArtifactEvidence,
} from "../scripts/record-ios-beta-evidence.mjs";

const revision = "b".repeat(40);
const matrix = {
  scenarios: [
    { id: "memory-pressure-recovery", requiredMethods: ["automatic", "manual"] },
    { id: "process-restoration", requiredMethods: ["automatic", "manual"] },
  ],
};

test("recorder requires eligible distribution artifact evidence", () => {
  const evidence = releaseArtifactEvidence();
  assert.doesNotThrow(() => validateReleaseArtifactEvidence(evidence, revision));
  evidence.policy.eligible = false;
  evidence.policy.blockers.push("blocked");
  assert.throws(() => validateReleaseArtifactEvidence(evidence, revision), /not policy-eligible/);
});

test("scenario arguments hash retained bytes without copying paths", () => {
  withTemporaryDirectory((directory) => {
    const retained = join(directory, "memory.log");
    writeFileSync(retained, "numeric qualification output\n");
    const scenarios = parseScenarioArguments([`memory-pressure-recovery:automatic:${retained}`], matrix);
    assert.deepEqual(Object.keys(scenarios[0]).sort(), ["evidenceSha256", "id", "method", "result"]);
    assert.match(scenarios[0].evidenceSha256, /^[0-9a-f]{64}$/);
    assert.equal(JSON.stringify(scenarios).includes(directory), false);
  });
});

test("recorder rejects duplicate or unreviewed scenario methods", () => {
  withTemporaryDirectory((directory) => {
    const retained = join(directory, "result.log");
    writeFileSync(retained, "pass\n");
    assert.throws(
      () =>
        parseScenarioArguments(
          [`process-restoration:manual:${retained}`, `process-restoration:manual:${retained}`],
          matrix,
        ),
      /Duplicate/,
    );
    assert.throws(() => parseScenarioArguments([`process-restoration:unknown:${retained}`], matrix), /does not accept/);
  });
});

test("merge preserves one run identity and refuses replacement", () => {
  const initial = runEvidence({ id: "memory-pressure-recovery", method: "automatic" });
  const addition = runEvidence({ id: "process-restoration", method: "automatic" });
  const merged = mergeEvidence(initial, addition);
  assert.equal(merged.scenarios.length, 2);
  assert.throws(() => mergeEvidence(merged, addition), /already records/);
  const otherArtifact = { ...addition, artifactEvidenceSha256: "d".repeat(64) };
  assert.throws(() => mergeEvidence(initial, otherArtifact), /artifactEvidenceSha256/);
});

function releaseArtifactEvidence() {
  return {
    schemaVersion: 1,
    source: { revision, clean: true, truffle: { clean: true } },
    ipa: {
      application: {
        signature: {
          signingClass: "apple-distribution",
          entitlements: { getTaskAllow: false },
        },
      },
    },
    policy: { eligible: true, blockers: [] },
  };
}

function runEvidence(scenario) {
  return {
    schemaVersion: 1,
    matrixSha256: "a".repeat(64),
    sourceRevision: revision,
    sourceClean: true,
    artifactEvidenceSha256: "c".repeat(64),
    recordedAt: "2026-07-18T00:00:00.000Z",
    device: {
      classId: "largePhone",
      modelIdentifier: "iPhone15,2",
      systemVersion: "26.5.2",
      maximumFramesPerSecond: 120,
      hardwareKeyboard: false,
      pointingDevice: false,
    },
    scenarios: [{ ...scenario, result: "pass", evidenceSha256: "e".repeat(64) }],
  };
}

function withTemporaryDirectory(operation) {
  const directory = mkdtempSync(join(tmpdir(), "ghosttea-beta-recorder-"));
  try {
    operation(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
