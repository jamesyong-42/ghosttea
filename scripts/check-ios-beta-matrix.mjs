import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "..");
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();

function main() {
  const matrixPath = resolve(
    argument("--matrix") ?? join(root, "apple/GhostteaKit/Compatibility/ios-beta-matrix.json"),
  );
  const evidenceDirectory = resolve(
    argument("--evidence-dir") ??
      process.env.GHOSTTEA_IOS_BETA_EVIDENCE_DIR ??
      join(root, "native/build/ios-beta-evidence"),
  );
  const release = process.argv.includes("--release");
  const packageManifest = readJSON(join(root, "package.json"));
  const matrixBytes = readFileSync(matrixPath);
  const matrix = JSON.parse(matrixBytes);
  const matrixHash = sha256(matrixBytes);

  validateMatrix(matrix, packageManifest.scripts ?? {});

  const evidenceFiles = existsSync(evidenceDirectory)
    ? readdirSync(evidenceDirectory)
        .filter((name) => name.endsWith(".json"))
        .sort()
        .map((name) => join(evidenceDirectory, name))
    : [];
  const evidence = evidenceFiles.map((path) => validateEvidence(path, matrix, matrixHash));
  const blockers = coverageBlockers(matrix, evidence);

  console.log(
    `Verified iOS beta matrix ${basename(matrixPath)} (${matrix.deviceClasses.length} device classes, ${matrix.refreshRates.length} refresh rates, ${matrix.scenarios.length} scenarios, ${evidence.length} evidence file(s), ${blockers.length} release blocker(s)); SHA-256 ${matrixHash}.`,
  );

  if (release) {
    const revisions = new Set(evidence.map((item) => item.sourceRevision));
    const artifacts = new Set(evidence.map((item) => item.artifactEvidenceSha256));
    const currentRevision = execute("git", ["rev-parse", "HEAD"]).stdout.trim();
    if (revisions.size > 1) blockers.push("beta evidence spans more than one source revision");
    if (artifacts.size > 1) blockers.push("beta evidence spans more than one release artifact");
    if (revisions.size === 1 && !revisions.has(currentRevision)) {
      blockers.push(`beta evidence source revision does not match current HEAD ${currentRevision}`);
    }
    if (execute("git", ["status", "--porcelain"]).stdout.trim()) {
      blockers.push("release qualification requires a clean source worktree");
    }
    if (blockers.length > 0) {
      console.error("iOS beta qualification blocked:");
      for (const blocker of [...new Set(blockers)]) console.error(`- ${blocker}`);
      process.exitCode = 1;
    } else {
      console.log("iOS beta qualification evidence passed.");
    }
  }
}

export function validateMatrix(value, scripts) {
  requireExactKeys(
    value,
    ["deviceClasses", "evidenceSchemaVersion", "refreshRates", "scenarios", "schemaVersion"],
    "matrix",
  );
  requireInteger(value.schemaVersion, 1, "matrix schemaVersion");
  requireInteger(value.evidenceSchemaVersion, 1, "evidence schemaVersion");
  requireNonEmptyArray(value.deviceClasses, "deviceClasses");
  requireNonEmptyArray(value.refreshRates, "refreshRates");
  requireNonEmptyArray(value.scenarios, "scenarios");

  const deviceIDs = new Set();
  for (const deviceClass of value.deviceClasses) {
    requireExactKeys(deviceClass, ["description", "id", "minimumRuns"], "device class");
    requireIdentifier(deviceClass.id, "device class id");
    requireNonEmptyString(deviceClass.description, "device class description");
    requireInteger(deviceClass.minimumRuns, 1, `${deviceClass.id} minimumRuns`);
    requireUnique(deviceIDs, deviceClass.id, "device class id");
  }
  requireSorted([...deviceIDs], "device class ids");

  if (JSON.stringify(value.refreshRates) !== JSON.stringify([60, 120])) {
    throw new Error("refreshRates must be exactly [60, 120]");
  }

  const scenarioIDs = new Set();
  for (const scenario of value.scenarios) {
    const allowedKeys = [
      "description",
      "id",
      "npmScript",
      "requiredAtEveryRefreshRate",
      "requiredDeviceClasses",
      "requiredMethods",
      "requiredOnEveryDeviceClass",
    ];
    requireAllowedKeys(scenario, allowedKeys, `scenario ${scenario.id ?? "<unknown>"}`);
    for (const key of ["description", "id", "requiredMethods"]) {
      if (!(key in scenario)) throw new Error(`scenario is missing ${key}`);
    }
    requireIdentifier(scenario.id, "scenario id");
    requireUnique(scenarioIDs, scenario.id, "scenario id");
    requireNonEmptyString(scenario.description, `${scenario.id} description`);
    requireNonEmptyArray(scenario.requiredMethods, `${scenario.id} requiredMethods`);
    const methods = [...new Set(scenario.requiredMethods)];
    if (
      methods.length !== scenario.requiredMethods.length ||
      methods.some((method) => !["automatic", "manual"].includes(method))
    ) {
      throw new Error(`${scenario.id} requiredMethods must contain unique automatic/manual values`);
    }
    requireSorted(scenario.requiredMethods, `${scenario.id} requiredMethods`);
    if (methods.includes("automatic")) {
      requireNonEmptyString(scenario.npmScript, `${scenario.id} npmScript`);
      if (!(scenario.npmScript in scripts))
        throw new Error(`${scenario.id} references missing npm script ${scenario.npmScript}`);
    } else if ("npmScript" in scenario) {
      throw new Error(`${scenario.id} has an npmScript without an automatic method`);
    }
    for (const booleanKey of ["requiredAtEveryRefreshRate", "requiredOnEveryDeviceClass"]) {
      if (booleanKey in scenario && scenario[booleanKey] !== true) {
        throw new Error(`${scenario.id} ${booleanKey} must be true when present`);
      }
    }
    if (scenario.requiredDeviceClasses) {
      requireNonEmptyArray(scenario.requiredDeviceClasses, `${scenario.id} requiredDeviceClasses`);
      if (new Set(scenario.requiredDeviceClasses).size !== scenario.requiredDeviceClasses.length) {
        throw new Error(`${scenario.id} requiredDeviceClasses must be unique`);
      }
      requireSorted(scenario.requiredDeviceClasses, `${scenario.id} requiredDeviceClasses`);
      for (const id of scenario.requiredDeviceClasses) {
        if (!deviceIDs.has(id)) throw new Error(`${scenario.id} references unknown device class ${id}`);
      }
    }
  }
  requireSorted([...scenarioIDs], "scenario ids");
}

export function validateEvidence(path, matrix, matrixHash) {
  const value = readJSON(path);
  requireExactKeys(
    value,
    [
      "artifactEvidenceSha256",
      "device",
      "matrixSha256",
      "recordedAt",
      "scenarios",
      "schemaVersion",
      "sourceClean",
      "sourceRevision",
    ],
    `evidence ${basename(path)}`,
  );
  requireInteger(value.schemaVersion, matrix.evidenceSchemaVersion, `${basename(path)} schemaVersion`);
  requireHash(value.matrixSha256, `${basename(path)} matrixSha256`);
  if (value.matrixSha256 !== matrixHash)
    throw new Error(`${basename(path)} does not reference the current beta matrix hash`);
  requireHash(value.artifactEvidenceSha256, `${basename(path)} artifactEvidenceSha256`);
  if (!/^[0-9a-f]{40}$/.test(value.sourceRevision))
    throw new Error(`${basename(path)} sourceRevision must be a full Git commit`);
  if (value.sourceClean !== true) throw new Error(`${basename(path)} sourceClean must be true`);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value.recordedAt)) {
    throw new Error(`${basename(path)} recordedAt must be an ISO-8601 UTC timestamp`);
  }

  requireExactKeys(
    value.device,
    ["classId", "hardwareKeyboard", "maximumFramesPerSecond", "modelIdentifier", "pointingDevice", "systemVersion"],
    `${basename(path)} device`,
  );
  const deviceIDs = new Set(matrix.deviceClasses.map((item) => item.id));
  if (!deviceIDs.has(value.device.classId))
    throw new Error(`${basename(path)} has unknown device class ${value.device.classId}`);
  if (!/^(?:iPhone|iPad)\d+,\d+$/.test(value.device.modelIdentifier)) {
    throw new Error(`${basename(path)} modelIdentifier is not a redacted Apple model identifier`);
  }
  requireNonEmptyString(value.device.systemVersion, `${basename(path)} systemVersion`);
  if (!matrix.refreshRates.includes(value.device.maximumFramesPerSecond)) {
    throw new Error(`${basename(path)} refresh rate is not part of the matrix`);
  }
  for (const key of ["hardwareKeyboard", "pointingDevice"]) {
    if (typeof value.device[key] !== "boolean") throw new Error(`${basename(path)} device.${key} must be boolean`);
  }
  if (
    value.device.classId === "tabletKeyboardPointer" &&
    (!value.device.hardwareKeyboard || !value.device.pointingDevice)
  ) {
    throw new Error(`${basename(path)} tabletKeyboardPointer evidence requires both hardware capabilities`);
  }

  requireNonEmptyArray(value.scenarios, `${basename(path)} scenarios`);
  const scenarioByID = new Map(matrix.scenarios.map((item) => [item.id, item]));
  const keys = new Set();
  for (const scenario of value.scenarios) {
    requireExactKeys(scenario, ["evidenceSha256", "id", "method", "result"], `${basename(path)} scenario`);
    const definition = scenarioByID.get(scenario.id);
    if (!definition) throw new Error(`${basename(path)} references unknown scenario ${scenario.id}`);
    if (!definition.requiredMethods.includes(scenario.method)) {
      throw new Error(`${basename(path)} ${scenario.id} has unexpected method ${scenario.method}`);
    }
    if (scenario.result !== "pass") throw new Error(`${basename(path)} ${scenario.id} result must be pass`);
    requireHash(scenario.evidenceSha256, `${basename(path)} ${scenario.id} evidenceSha256`);
    requireUnique(keys, `${scenario.id}:${scenario.method}`, `${basename(path)} scenario/method`);
  }
  return value;
}

export function coverageBlockers(matrix, evidence) {
  const blockers = [];
  for (const deviceClass of matrix.deviceClasses) {
    const count = evidence.filter((item) => item.device.classId === deviceClass.id).length;
    if (count < deviceClass.minimumRuns) {
      blockers.push(`${deviceClass.id} has ${count} of ${deviceClass.minimumRuns} required physical runs`);
    }
  }
  for (const refreshRate of matrix.refreshRates) {
    if (!evidence.some((item) => item.device.maximumFramesPerSecond === refreshRate)) {
      blockers.push(`no physical ${refreshRate} Hz evidence`);
    }
  }
  for (const scenario of matrix.scenarios) {
    const hasScopedCoverage =
      scenario.requiredOnEveryDeviceClass ||
      scenario.requiredAtEveryRefreshRate ||
      (scenario.requiredDeviceClasses?.length ?? 0) > 0;
    if (!hasScopedCoverage) {
      for (const method of scenario.requiredMethods) {
        if (!hasScenario(evidence, scenario.id, method)) {
          blockers.push(`${scenario.id} is missing ${method} evidence`);
        }
      }
    }
    if (scenario.requiredOnEveryDeviceClass) {
      for (const deviceClass of matrix.deviceClasses) {
        for (const method of scenario.requiredMethods) {
          const matching = evidence.filter((item) => item.device.classId === deviceClass.id);
          if (!hasScenario(matching, scenario.id, method)) {
            blockers.push(`${scenario.id} is missing ${method} evidence on ${deviceClass.id}`);
          }
        }
      }
    }
    for (const deviceClassID of scenario.requiredDeviceClasses ?? []) {
      const matching = evidence.filter((item) => item.device.classId === deviceClassID);
      for (const method of scenario.requiredMethods) {
        if (!hasScenario(matching, scenario.id, method)) {
          blockers.push(`${scenario.id} is missing ${method} evidence on ${deviceClassID}`);
        }
      }
    }
    if (scenario.requiredAtEveryRefreshRate) {
      for (const refreshRate of matrix.refreshRates) {
        const matching = evidence.filter((item) => item.device.maximumFramesPerSecond === refreshRate);
        for (const method of scenario.requiredMethods) {
          if (!hasScenario(matching, scenario.id, method)) {
            blockers.push(`${scenario.id} is missing ${method} evidence at ${refreshRate} Hz`);
          }
        }
      }
    }
  }
  return blockers;
}

function hasScenario(evidence, id, method) {
  return evidence.some((item) =>
    item.scenarios.some((scenario) => scenario.id === id && scenario.method === method && scenario.result === "pass"),
  );
}

function requireAllowedKeys(value, allowed, description) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${description} must be an object`);
  const unexpected = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unexpected.length) throw new Error(`${description} has unexpected keys: ${unexpected.join(", ")}`);
}

function requireExactKeys(value, expected, description) {
  requireAllowedKeys(value, expected, description);
  const missing = expected.filter((key) => !(key in value));
  if (missing.length) throw new Error(`${description} is missing keys: ${missing.join(", ")}`);
}

function requireInteger(value, expected, description) {
  if (!Number.isInteger(value) || value !== expected) throw new Error(`${description} must be ${expected}`);
}

function requireIdentifier(value, description) {
  if (typeof value !== "string" || !/^[a-z][A-Za-z0-9-]*$/.test(value)) throw new Error(`${description} is invalid`);
}

function requireNonEmptyString(value, description) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${description} must be a nonempty string`);
}

function requireNonEmptyArray(value, description) {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${description} must be a nonempty array`);
}

function requireUnique(set, value, description) {
  if (set.has(value)) throw new Error(`duplicate ${description}: ${value}`);
  set.add(value);
}

function requireSorted(values, description) {
  const sorted = [...values].sort();
  if (JSON.stringify(values) !== JSON.stringify(sorted)) throw new Error(`${description} must be sorted`);
}

function requireHash(value, description) {
  if (!/^[0-9a-f]{64}$/.test(value) || /^0+$/.test(value)) throw new Error(`${description} must be a nonzero SHA-256`);
}

function argument(name) {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

function readJSON(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function execute(program, args) {
  const result = spawnSync(program, args, { cwd: root, encoding: "utf8", stdio: "pipe" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${program} ${args.join(" ")} failed with status ${result.status}`);
  return result;
}
