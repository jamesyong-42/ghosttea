import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { coverageBlockers, validateEvidence, validateMatrix } from "../scripts/check-ios-beta-matrix.mjs";

const root = resolve(import.meta.dirname, "..");
const matrixPath = join(root, "apple/GhostteaKit/Compatibility/ios-beta-matrix.json");
const matrixBytes = readFileSync(matrixPath);
const matrix = JSON.parse(matrixBytes);
const matrixHash = createHash("sha256").update(matrixBytes).digest("hex");
const packageManifest = JSON.parse(readFileSync(join(root, "package.json")));

test("beta matrix references existing automatic commands", () => {
  assert.doesNotThrow(() => validateMatrix(matrix, packageManifest.scripts));
});

test("complete redacted evidence covers every required dimension", () => {
  withTemporaryDirectory((directory) => {
    const validated = matrix.deviceClasses.map((deviceClass, index) => {
      const evidence = makeEvidence(deviceClass.id, index);
      const path = join(directory, `${deviceClass.id}.json`);
      writeFileSync(path, JSON.stringify(evidence));
      return validateEvidence(path, matrix, matrixHash);
    });
    assert.deepEqual(coverageBlockers(matrix, validated), []);
  });
});

test("evidence rejects unknown fields that could carry sensitive context", () => {
  withTemporaryDirectory((directory) => {
    const evidence = makeEvidence("compactPhone", 0);
    evidence.device.hostname = "should-never-be-recorded";
    const path = join(directory, "leaky.json");
    writeFileSync(path, JSON.stringify(evidence));
    assert.throws(() => validateEvidence(path, matrix, matrixHash), /unexpected keys: hostname/);
  });
});

test("evidence cannot be reused after the matrix changes", () => {
  withTemporaryDirectory((directory) => {
    const path = join(directory, "stale.json");
    writeFileSync(path, JSON.stringify(makeEvidence("largePhone", 1)));
    assert.throws(() => validateEvidence(path, matrix, "d".repeat(64)), /current beta matrix hash/);
  });
});

function makeEvidence(classId, index) {
  const tablet = classId.startsWith("tablet");
  const keyboardPointer = classId === "tabletKeyboardPointer";
  return {
    schemaVersion: matrix.evidenceSchemaVersion,
    matrixSha256: matrixHash,
    sourceRevision: "b".repeat(40),
    sourceClean: true,
    artifactEvidenceSha256: "a".repeat(64),
    recordedAt: "2026-07-18T00:00:00Z",
    device: {
      classId,
      modelIdentifier: tablet ? "iPad16,5" : "iPhone15,2",
      systemVersion: "26.5.2",
      maximumFramesPerSecond: index % 2 === 0 ? 60 : 120,
      hardwareKeyboard: keyboardPointer,
      pointingDevice: keyboardPointer,
    },
    scenarios: matrix.scenarios.flatMap((scenario) =>
      scenario.requiredMethods.map((method) => ({
        id: scenario.id,
        method,
        result: "pass",
        evidenceSha256: "c".repeat(64),
      })),
    ),
  };
}

function withTemporaryDirectory(operation) {
  const directory = mkdtempSync(join(tmpdir(), "ghosttea-ios-beta-matrix-"));
  try {
    operation(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
