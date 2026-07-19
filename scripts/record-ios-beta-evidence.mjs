import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

import { validateEvidence, validateMatrix } from "./check-ios-beta-matrix.mjs";

const root = resolve(import.meta.dirname, "..");
const matrixPath = resolve(root, "apple/GhostteaKit/Compatibility/ios-beta-matrix.json");

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();

function main() {
  const matrixBytes = readFileSync(matrixPath);
  const matrix = JSON.parse(matrixBytes);
  const packageManifest = readJSON(resolve(root, "package.json"));
  validateMatrix(matrix, packageManifest.scripts ?? {});

  const sourceRevision = commandOutput("git", ["rev-parse", "HEAD"]);
  if (commandOutput("git", ["status", "--porcelain"])) {
    throw new Error("Beta evidence recording requires a clean source worktree.");
  }

  const artifactPath = resolve(requiredArgument("--artifact-evidence"));
  const artifactBytes = readFileSync(artifactPath);
  validateReleaseArtifactEvidence(JSON.parse(artifactBytes), sourceRevision);

  const deviceClassID = requiredArgument("--device-class");
  if (!matrix.deviceClasses.some((item) => item.id === deviceClassID)) {
    throw new Error(`Unknown beta device class ${deviceClassID}.`);
  }
  const refreshRate = parseInteger(requiredArgument("--refresh-rate"), "refresh rate");
  if (!matrix.refreshRates.includes(refreshRate)) {
    throw new Error(`Refresh rate must be one of ${matrix.refreshRates.join(", ")}.`);
  }
  const hardwareKeyboard = parseBoolean(requiredArgument("--hardware-keyboard"), "hardware keyboard");
  const pointingDevice = parseBoolean(requiredArgument("--pointing-device"), "pointing device");
  const scenarios = parseScenarioArguments(argumentValues("--scenario"), matrix);
  const device = findDevice();
  const matrixSha256 = sha256(matrixBytes);
  const artifactEvidenceSha256 = sha256(artifactBytes);
  const output = resolve(
    optionalArgument("--output") ??
      `native/build/ios-beta-evidence/${deviceClassID}-${device.hardwareProperties.productType}.json`,
  );

  const next = mergeEvidence(existsSync(output) ? readJSON(output) : undefined, {
    schemaVersion: matrix.evidenceSchemaVersion,
    matrixSha256,
    sourceRevision,
    sourceClean: true,
    artifactEvidenceSha256,
    recordedAt: new Date().toISOString(),
    device: {
      classId: deviceClassID,
      modelIdentifier: device.hardwareProperties.productType,
      systemVersion: device.deviceProperties.osVersionNumber,
      maximumFramesPerSecond: refreshRate,
      hardwareKeyboard,
      pointingDevice,
    },
    scenarios,
  });

  mkdirSync(dirname(output), { recursive: true });
  const temporaryOutput = `${output}.tmp-${process.pid}`;
  try {
    writeFileSync(temporaryOutput, `${JSON.stringify(next, null, 2)}\n`, { flag: "wx" });
    validateEvidence(temporaryOutput, matrix, matrixSha256);
    renameSync(temporaryOutput, output);
  } finally {
    rmSync(temporaryOutput, { force: true });
  }
  console.log(
    `Recorded ${scenarios.length} beta scenario result(s) in ${basename(output)}; artifact ${artifactEvidenceSha256}.`,
  );
}

export function validateReleaseArtifactEvidence(value, sourceRevision) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Release artifact evidence must be an object.");
  }
  if (value.schemaVersion !== 1) throw new Error("Unsupported release artifact evidence schema.");
  if (value.source?.revision !== sourceRevision || value.source?.clean !== true) {
    throw new Error("Release artifact evidence must bind the current clean source revision.");
  }
  if (value.source?.truffle?.clean !== true) {
    throw new Error("Release artifact evidence must bind a clean Truffle source revision.");
  }
  if (value.policy?.eligible !== true || !Array.isArray(value.policy?.blockers) || value.policy.blockers.length !== 0) {
    throw new Error("Release artifact evidence is not policy-eligible.");
  }
  if (!value.ipa || value.ipa.application?.signature?.signingClass !== "apple-distribution") {
    throw new Error("Release artifact evidence must include an Apple Distribution IPA.");
  }
  if (value.ipa.application?.signature?.entitlements?.getTaskAllow !== false) {
    throw new Error("Release artifact IPA must disable debugger attachment.");
  }
}

export function parseScenarioArguments(values, matrix) {
  if (values.length === 0) throw new Error("At least one --scenario result is required.");
  const definitions = new Map(matrix.scenarios.map((item) => [item.id, item]));
  const keys = new Set();
  return values.map((value) => {
    const firstSeparator = value.indexOf(":");
    const secondSeparator = value.indexOf(":", firstSeparator + 1);
    if (firstSeparator < 1 || secondSeparator <= firstSeparator + 1 || secondSeparator === value.length - 1) {
      throw new Error("--scenario must use id:method:/path/to/retained-evidence.");
    }
    const id = value.slice(0, firstSeparator);
    const method = value.slice(firstSeparator + 1, secondSeparator);
    const evidencePath = resolve(value.slice(secondSeparator + 1));
    const definition = definitions.get(id);
    if (!definition) throw new Error(`Unknown beta scenario ${id}.`);
    if (!definition.requiredMethods.includes(method)) {
      throw new Error(`${id} does not accept ${method} evidence.`);
    }
    const key = `${id}:${method}`;
    if (keys.has(key)) throw new Error(`Duplicate beta scenario result ${key}.`);
    keys.add(key);
    if (!existsSync(evidencePath)) throw new Error(`Retained evidence does not exist: ${evidencePath}.`);
    return {
      id,
      method,
      result: "pass",
      evidenceSha256: sha256(readFileSync(evidencePath)),
    };
  });
}

export function mergeEvidence(existing, incoming) {
  if (!existing) return incoming;
  for (const key of ["schemaVersion", "matrixSha256", "sourceRevision", "sourceClean", "artifactEvidenceSha256"]) {
    if (existing[key] !== incoming[key]) throw new Error(`Existing evidence does not match ${key}.`);
  }
  if (JSON.stringify(existing.device) !== JSON.stringify(incoming.device)) {
    throw new Error("Existing evidence does not describe the same physical device run.");
  }
  const scenarios = [...existing.scenarios];
  const keys = new Set(scenarios.map((item) => `${item.id}:${item.method}`));
  for (const scenario of incoming.scenarios) {
    const key = `${scenario.id}:${scenario.method}`;
    if (keys.has(key)) throw new Error(`Existing evidence already records ${key}.`);
    keys.add(key);
    scenarios.push(scenario);
  }
  return { ...existing, recordedAt: incoming.recordedAt, scenarios };
}

function findDevice() {
  const directory = mkdtempSync(join(tmpdir(), "ghosttea-beta-device-"));
  const output = join(directory, "devices.json");
  let response;
  try {
    commandOutput("xcrun", ["devicectl", "list", "devices", "--json-output", output, "--quiet"]);
    response = readJSON(output);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
  const devices = response.result.devices.filter(
    (device) =>
      device.hardwareProperties?.platform === "iOS" &&
      device.hardwareProperties?.reality === "physical" &&
      device.connectionProperties?.pairingState === "paired",
  );
  const requested = process.env.GHOSTTEA_IOS_DEVICE_ID;
  if (requested) {
    const match = devices.find(
      (device) => device.identifier === requested || device.hardwareProperties?.udid === requested,
    );
    if (!match) throw new Error(`Connected iOS device ${requested} was not found.`);
    return match;
  }
  if (devices.length !== 1) throw new Error(`Expected one paired physical iOS device, found ${devices.length}.`);
  return devices[0];
}

function argumentValues(name) {
  const values = [];
  for (let index = 0; index < process.argv.length; index += 1) {
    if (process.argv[index] === name) values.push(process.argv[index + 1] ?? "");
  }
  return values;
}

function optionalArgument(name) {
  const values = argumentValues(name);
  if (values.length > 1) throw new Error(`${name} may be provided only once.`);
  return values[0];
}

function requiredArgument(name) {
  const value = optionalArgument(name);
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value.`);
  return value;
}

function parseInteger(value, description) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) throw new Error(`${description} must be an integer.`);
  return parsed;
}

function parseBoolean(value, description) {
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${description} must be true or false.`);
}

function readJSON(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function commandOutput(program, args) {
  const result = spawnSync(program, args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${program} ${args.join(" ")} failed with status ${result.status}.`);
  return result.stdout.trim();
}
