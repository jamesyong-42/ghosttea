import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const runbookPath = "apple/GhostteaKit/Compatibility/ghostty-upgrade-procedure.md";
const lock = readJSON("native/ghostty.lock.json");
const fonts = readJSON("native/fonts.lock.json");
const artifacts = readJSON("native/ghosttea/crates/ghosttea-vt-sys/artifacts.json");
const packageManifest = readJSON("package.json");
const sourceBom = readJSON("apple/GhostteaKit/Compatibility/ios-release.cdx.json");
const bundledBom = readJSON("apple/GhostteaApp/Resources/Ghosttea-iOS.cdx.json");
const workflow = read(".github/workflows/ghostty-vt-artifact.yml");
const runbook = read(runbookPath);
const configCompatibilitySource = read("native/ghosttea/crates/ghosttea-config/src/lib.rs");
const configKnownKeys = read("native/ghosttea/crates/ghosttea-config/src/known-keys.txt").trim().split("\n").sort();
const groundTruthConfig = read("bench/ghostty-ux/ground-truth/config-macos-default.txt");
const groundTruthVersion = read("bench/ghostty-ux/ground-truth/ghostty-version.txt");
const groundTruthCommit = read("bench/ghostty-ux/ground-truth/vendor-commit.txt").split("\n", 1)[0];

const commit = lock.ghostty?.commit;
if (!/^[0-9a-f]{40}$/.test(commit ?? "")) {
  throw new Error("native/ghostty.lock.json must pin a full lowercase 40-character commit.");
}
const revision = commit.slice(0, 12);
const target = "aarch64-apple-darwin";
const expectedRelease = `ghostty-vt-${revision}`;
const expectedFilename = `${expectedRelease}-${target}.tar`;
const artifact = artifacts.targets?.[target];

if (!configCompatibilitySource.includes(`GHOSTTY_COMPAT_COMMIT: &str = "${commit}"`)) {
  throw new Error("ghosttea-config compatibility commit does not match native/ghostty.lock.json.");
}
requireEqual(groundTruthCommit, commit, "Ghostty UX ground-truth commit");
const version = groundTruthVersion.match(/^\s*-\s+version:\s+(\S+)\s*$/m)?.[1];
if (!version || !configCompatibilitySource.includes(`GHOSTTY_COMPAT_VERSION: &str = "${version}"`)) {
  throw new Error("ghosttea-config compatibility version does not match the Ghostty UX ground truth.");
}
const groundTruthKeys = [
  ...new Set(
    groundTruthConfig
      .split("\n")
      .filter((line) => /^[a-z0-9-]+ = /.test(line))
      .map((line) => line.slice(0, line.indexOf(" = "))),
  ),
].sort();
requireEqual(configKnownKeys, groundTruthKeys, "ghosttea-config known-key schema");

requireEqual(artifacts.source, lock.ghostty, "native artifact source pin");
requireEqual(fonts.source, lock.ghostty, "font source pin");
requireEqual(artifact?.release, expectedRelease, "native artifact release");
requireEqual(artifact?.filename, expectedFilename, "native artifact filename");
requireEqual(
  artifact?.url,
  `https://github.com/vibecook-dev/ghosttea/releases/download/${expectedRelease}/${expectedFilename}`,
  "native artifact URL",
);
for (const field of ["sha256", "librarySha256", "headersSha256"]) {
  if (!/^[0-9a-f]{64}$/.test(artifact?.[field] ?? "")) {
    throw new Error(`Native artifact ${field} is not a SHA-256 digest.`);
  }
}
if (!Number.isSafeInteger(artifact?.size) || artifact.size <= 0) {
  throw new Error("Native artifact size must be a positive integer.");
}

for (const [description, bom] of [
  ["source release BOM", sourceBom],
  ["bundled release BOM", bundledBom],
]) {
  const component = bom.components?.find((candidate) => candidate.name === "Ghostty VT");
  requireEqual(component?.version, commit, `${description} Ghostty version`);
  requireEqual(component?.purl, `pkg:github/ghostty-org/ghostty@${commit}`, `${description} Ghostty purl`);
}

const requiredScripts = [
  "bootstrap:ghostty-vt",
  "bootstrap:ghostty-vt:apple",
  "build:ghostty-vt",
  "build:ghostty-vt:apple",
  "check:ghostty-vt:apple",
  "test:ghostty-vt:apple",
  "sync:fonts",
  "check:font-parity",
  "package:ghostty-vt",
  "check:ios-release-bom",
  "update:ios-release-resources",
  "test:ios:app:interop",
  "archive:ios:app",
  "check:ghostty-upgrade",
];
for (const name of requiredScripts) {
  if (!packageManifest.scripts?.[name]) throw new Error(`package.json is missing the ${name} script.`);
}

const requiredInputs = [
  "native/ghostty.lock.json",
  "native/fonts.lock.json",
  "native/ghosttea/crates/ghosttea-vt-sys/artifacts.json",
  "native/ghosttea/crates/ghosttea-vt-sys/src/ghostty_shim.c",
  "native/ghosttea/fixtures/phase1/ansi-baseline.json",
  "native/ghosttea/fixtures/phase2/font-parity.json",
  "apple/GhostteaKit/Sources/GhostteaTerminal/Resources/terminal-visual-golden.json",
  "apple/GhostteaKit/Compatibility/ios-release.cdx.json",
  "apple/GhostteaKit/Compatibility/ios-release-resources.lock.json",
];
for (const path of requiredInputs) {
  if (!existsSync(resolve(root, path))) throw new Error(`Ghostty upgrade input is missing: ${path}`);
}

const requiredRunbookText = [
  ...requiredInputs,
  ...requiredScripts.map((name) => `npm run ${name}`),
  "[STOP-SOURCE]",
  "[STOP-ABI]",
  "[STOP-PARITY]",
  "[STOP-FONTS]",
  "[STOP-PERFORMANCE]",
  "[STOP-PACKAGING]",
  "[STOP-DEVICE]",
  "[ROLLBACK]",
  "byte-identical TRF1",
  "desktop and iOS",
  "same Truffle session",
];
for (const text of requiredRunbookText) {
  if (!runbook.includes(text)) throw new Error(`${runbookPath} omits required text: ${text}`);
}

if (workflow.includes(`ghostty-vt-${revision}-`)) {
  throw new Error("Ghostty artifact workflow hardcodes the current revision instead of resolving its locked path.");
}
for (const text of [
  "id: ghostty_artifact",
  "artifacts.json",
  "steps.ghostty_artifact.outputs.path",
  "steps.ghostty_artifact.outputs.sbom",
]) {
  if (!workflow.includes(text)) throw new Error(`Ghostty artifact workflow omits ${text}.`);
}

// The multi-target scripts read the pin through one shared module rather than
// each opening the lock, so that module has to be the thing that reads it.
const sharedTargets = "scripts/ghostty-vt-target.mjs";
if (!read(sharedTargets).includes("native/ghostty.lock.json")) {
  throw new Error(`${sharedTargets} does not read native/ghostty.lock.json.`);
}

for (const path of [
  "scripts/bootstrap-ghostty-vt.mjs",
  "scripts/bootstrap-ghostty-vt-apple.mjs",
  "scripts/build-ghostty-vt.mjs",
  "scripts/build-ghostty-vt-apple.mjs",
]) {
  const source = read(path);
  if (!source.includes("native/ghostty.lock.json") && !source.includes("./ghostty-vt-target.mjs")) {
    throw new Error(`${path} does not read native/ghostty.lock.json.`);
  }
  for (const text of ["rev-parse", "lock.ghostty.commit"]) {
    if (!source.includes(text)) throw new Error(`${path} does not enforce ${text}.`);
  }
}
for (const path of ["scripts/build-ghostty-vt.mjs", "scripts/build-ghostty-vt-apple.mjs"]) {
  if (!read(path).includes('"status", "--porcelain"')) {
    throw new Error(`${path} does not reject a dirty Ghostty source checkout.`);
  }
}
for (const [path, requiredText] of [
  ["scripts/check-ios-release-ready.mjs", "scripts/check-ghostty-upgrade-procedure.mjs"],
  ["scripts/archive-ios-app.mjs", "scripts/check-ghostty-upgrade-procedure.mjs"],
]) {
  if (!read(path).includes(requiredText)) {
    throw new Error(`${path} does not run the Ghostty upgrade drift gate.`);
  }
}

console.log(
  `Verified Ghostty upgrade procedure for ${commit}: exact source/font/BOM locks, ${requiredInputs.length} inputs, and dynamic artifact attestation.`,
);

function read(path) {
  return readFileSync(resolve(root, path), "utf8");
}

function readJSON(path) {
  return JSON.parse(read(path));
}

function requireEqual(actual, expected, description) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${description} drifted: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}.`);
  }
}
