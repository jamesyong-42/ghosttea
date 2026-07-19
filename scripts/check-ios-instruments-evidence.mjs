import { existsSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "..");
const requiredScenarios = new Map([
  ["idle", 60],
  ["rendered-output-1", 120],
  ["rendered-output-4", 120],
  ["rendered-output-8", 120],
]);

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();

function main() {
  const evidencePath = resolve(
    argument("--evidence") ??
      process.env.GHOSTTEA_IOS_INSTRUMENTS_EVIDENCE ??
      join(root, "native/build/ios-instruments/evidence.json"),
  );
  const release = process.argv.includes("--release");

  if (!existsSync(evidencePath)) {
    if (release) {
      console.error(`iOS Instruments qualification blocked: no evidence at ${evidencePath}`);
      process.exitCode = 1;
    } else {
      console.log("No retained iOS Instruments evidence; schema check skipped without claiming qualification.");
    }
    return;
  }

  const evidence = validateEvidence(JSON.parse(readFileSync(evidencePath, "utf8")));
  const blockers = releaseBlockers(evidence);
  if (release) {
    const currentRevision = execute("git", ["rev-parse", "HEAD"]).stdout.trim();
    if (evidence.sourceRevision !== currentRevision) {
      blockers.push(`evidence source revision does not match current HEAD ${currentRevision}`);
    }
    if (execute("git", ["status", "--porcelain"]).stdout.trim()) {
      blockers.push("release qualification requires a clean source worktree");
    }
  }

  console.log(
    `Validated ${basename(evidencePath)} (${evidence.status}, ${evidence.traces.length}/${requiredScenarios.size} traces).`,
  );
  if (release && blockers.length > 0) {
    console.error("iOS Instruments qualification blocked:");
    for (const blocker of [...new Set(blockers)]) console.error(`- ${blocker}`);
    process.exitCode = 1;
  } else if (release) {
    console.log("iOS Instruments trace capture and CPU/Energy review passed.");
  }
}

export function validateEvidence(value) {
  requireExactKeys(
    value,
    [
      "appBundleSha256",
      "blockers",
      "device",
      "protocol",
      "quickMode",
      "recordedAt",
      "releaseMode",
      "review",
      "schemaVersion",
      "sourceClean",
      "sourceRevision",
      "status",
      "toolchain",
      "traces",
    ],
    "evidence",
  );
  if (value.schemaVersion !== 1) throw new Error("evidence schemaVersion must be 1");
  if (!/^[0-9a-f]{40}$/.test(value.sourceRevision)) throw new Error("sourceRevision must be a full Git commit");
  for (const key of ["sourceClean", "releaseMode", "quickMode"]) {
    if (typeof value[key] !== "boolean") throw new Error(`${key} must be boolean`);
  }
  if (!["blocked", "captured"].includes(value.status)) throw new Error("status must be blocked or captured");
  if (!Array.isArray(value.blockers) || value.blockers.some((item) => typeof item !== "string" || !item)) {
    throw new Error("blockers must contain only non-empty strings");
  }
  for (const blocker of value.blockers) {
    if (!allowedBlocker(blocker)) throw new Error(`blocker is not part of the redacted schema: ${blocker}`);
  }
  if (!Array.isArray(value.traces)) throw new Error("traces must be an array");
  requireNullableHash(value.appBundleSha256, "appBundleSha256");
  if (value.recordedAt !== null && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value.recordedAt)) {
    throw new Error("recordedAt must be null or an ISO-8601 UTC timestamp");
  }

  requireExactKeys(
    value.toolchain,
    ["iphoneOSSDKVersion", "xcodeBuild", "xcodeVersion", "xctraceVersion"],
    "toolchain",
  );
  for (const [key, field] of Object.entries(value.toolchain)) requireNonEmptyString(field, `toolchain.${key}`);
  requireExactKeys(
    value.device,
    ["ddiServicesAvailable", "developerModeEnabled", "modelIdentifier", "systemVersion"],
    "device",
  );
  if (!/^(?:iPhone|iPad)\d+,\d+$/.test(value.device.modelIdentifier)) {
    throw new Error("device.modelIdentifier must be a redacted Apple model identifier");
  }
  requireNonEmptyString(value.device.systemVersion, "device.systemVersion");
  for (const key of ["ddiServicesAvailable", "developerModeEnabled"]) {
    if (typeof value.device[key] !== "boolean") throw new Error(`device.${key} must be boolean`);
  }

  requireExactKeys(value.protocol, ["instruments", "scenarios", "template"], "protocol");
  if (value.protocol.template !== "Time Profiler") throw new Error("protocol.template must be Time Profiler");
  const expectedInstruments = ["Metal Application", "Points of Interest", "Power Profiler", "Thermal State"];
  if (JSON.stringify(value.protocol.instruments) !== JSON.stringify(expectedInstruments)) {
    throw new Error("protocol.instruments does not match the qualification contract");
  }
  if (!Array.isArray(value.protocol.scenarios)) throw new Error("protocol.scenarios must be an array");
  const protocolIDs = new Set();
  for (const scenario of value.protocol.scenarios) {
    requireExactKeys(scenario, ["durationSeconds", "id"], "protocol scenario");
    if (!requiredScenarios.has(scenario.id)) throw new Error(`unknown protocol scenario ${scenario.id}`);
    if (!Number.isFinite(scenario.durationSeconds) || scenario.durationSeconds <= 0) {
      throw new Error(`${scenario.id} durationSeconds must be positive`);
    }
    if (protocolIDs.has(scenario.id)) throw new Error(`duplicate protocol scenario ${scenario.id}`);
    protocolIDs.add(scenario.id);
  }
  if (protocolIDs.size !== requiredScenarios.size) throw new Error("protocol must contain all four scenarios");

  requireExactKeys(value.review, ["cpu", "energy"], "review");
  for (const key of ["cpu", "energy"]) {
    if (!["pending", "pass"].includes(value.review[key])) throw new Error(`review.${key} must be pending or pass`);
  }

  const traceIDs = new Set();
  for (const trace of value.traces) {
    requireExactKeys(trace, ["durationSeconds", "id", "tocSha256", "traceBundleSha256"], "trace");
    if (!requiredScenarios.has(trace.id)) throw new Error(`unknown trace ${trace.id}`);
    if (traceIDs.has(trace.id)) throw new Error(`duplicate trace ${trace.id}`);
    traceIDs.add(trace.id);
    if (!Number.isFinite(trace.durationSeconds) || trace.durationSeconds <= 0) {
      throw new Error(`${trace.id} durationSeconds must be positive`);
    }
    requireHash(trace.traceBundleSha256, `${trace.id} traceBundleSha256`);
    requireHash(trace.tocSha256, `${trace.id} tocSha256`);
  }
  return value;
}

export function releaseBlockers(value) {
  const blockers = [...value.blockers];
  if (value.status !== "captured") blockers.push(`evidence status is ${value.status}`);
  if (!value.releaseMode || value.quickMode) blockers.push("evidence is not a full release-mode capture");
  if (value.sourceClean !== true) blockers.push("evidence was not captured from a clean source worktree");
  if (value.appBundleSha256 === null) blockers.push("evidence is not bound to a signed app bundle");
  if (value.recordedAt === null) blockers.push("evidence has no capture timestamp");
  if (value.traces.length !== requiredScenarios.size) {
    blockers.push(`captured ${value.traces.length} of ${requiredScenarios.size} required traces`);
  }
  const traces = new Map(value.traces.map((trace) => [trace.id, trace]));
  for (const [id, durationSeconds] of requiredScenarios) {
    const trace = traces.get(id);
    if (!trace) blockers.push(`missing ${id} trace`);
    else if (trace.durationSeconds < durationSeconds) blockers.push(`${id} trace is shorter than ${durationSeconds}s`);
  }
  for (const key of ["cpu", "energy"]) {
    if (value.review[key] !== "pass") blockers.push(`${key.toUpperCase()} trace review is pending`);
  }
  return blockers;
}

function argument(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  if (!process.argv[index + 1]) throw new Error(`${name} requires a value`);
  return process.argv[index + 1];
}

function requireExactKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    const unexpected = actual.filter((key) => !wanted.includes(key));
    const missing = wanted.filter((key) => !actual.includes(key));
    throw new Error(
      `${label} keys differ${unexpected.length ? `; unexpected keys: ${unexpected.join(", ")}` : ""}${
        missing.length ? `; missing keys: ${missing.join(", ")}` : ""
      }`,
    );
  }
}

function requireNonEmptyString(value, label) {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} must be a non-empty string`);
}

function requireHash(value, label) {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    throw new Error(`${label} must be a lowercase SHA-256`);
  }
}

function requireNullableHash(value, label) {
  if (value !== null) requireHash(value, label);
}

function allowedBlocker(value) {
  const fixed = [
    /^missing xctrace template: Time Profiler$/,
    /^missing xctrace instrument: (?:Metal Application|Points of Interest|Power Profiler|Thermal State)$/,
    /^physical device Developer Mode is disabled$/,
    /^locked iPhoneOS SDK \d+\.\d+(?:\.\d+)? does not support device OS \d+\.\d+(?:\.\d+)?$/,
    /^release trace capture requires a clean source worktree$/,
    /^capture setup failed$/,
    /^(?:idle|rendered-output-[148]) xctrace recording failed with status -?\d+$/,
    /^(?:idle|rendered-output-[148]) workload did not report completion$/,
    /^(?:idle|rendered-output-[148]) did not produce a trace bundle$/,
    /^(?:idle|rendered-output-[148]) trace table-of-contents export failed$/,
    /^(?:idle|rendered-output-[148]) trace did not target a physical iOS device$/,
    /^(?:idle|rendered-output-[148]) trace duration is shorter than its workload$/,
    /^captured [0-4] of 4 required traces$/,
  ];
  return fixed.some((pattern) => pattern.test(value));
}

function execute(program, args) {
  const result = spawnSync(program, args, { cwd: root, encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${program} ${args.join(" ")} failed with status ${result.status}`);
  return result;
}
