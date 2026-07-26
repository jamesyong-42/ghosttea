import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { basename, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const lock = readJSON("apple/GhostteaKit/Compatibility/ios-release-resources.lock.json");
const sourceBom = read(lock.sourceBom.path);
const bundledBom = read(lock.bundledBom.path);
const notices = read(lock.notices.path);

requireHash(sourceBom, lock.sourceBom.sha256, lock.sourceBom.path);
requireHash(bundledBom, lock.bundledBom.sha256, lock.bundledBom.path);
requireHash(notices, lock.notices.sha256, lock.notices.path);
if (!sourceBom.equals(bundledBom)) {
  throw new Error("The app-bundled CycloneDX BOM is not byte-identical to the reviewed source BOM.");
}
const noticeText = notices.toString("utf8");
const sourceBomDocument = JSON.parse(sourceBom);
for (const expected of [
  `CycloneDX SHA-256: ${lock.sourceBom.sha256}`,
  `Components: ${lock.notices.componentCount}`,
  `Unique license documents: ${lock.notices.licenseDocumentCount}`,
]) {
  if (!noticeText.includes(expected)) {
    throw new Error(`Third-party notices omit ${JSON.stringify(expected)}.`);
  }
}
for (const component of sourceBomDocument.components) {
  const label = `${component.name} ${component.version}`;
  if (!noticeText.includes(label)) {
    throw new Error(`Third-party notices omit component ${label}.`);
  }
}
const documentSections = noticeText.match(/^LICENSE-\d{3} · /gm) ?? [];
if (documentSections.length !== lock.notices.licenseDocumentCount) {
  throw new Error(
    `Third-party notices contain ${documentSections.length} license sections, expected ${lock.notices.licenseDocumentCount}.`,
  );
}
if (noticeText.includes("/Users/") || noticeText.includes(root)) {
  throw new Error("Third-party notices contain a machine-local path.");
}

const bundleFlag = process.argv.indexOf("--app-bundle");
if (bundleFlag >= 0) {
  const bundle = process.argv[bundleFlag + 1];
  if (!bundle) throw new Error("--app-bundle requires a path.");
  verifyBundleResource(bundle, lock.bundledBom, bundledBom);
  verifyBundleResource(bundle, lock.notices, notices);
}

console.log(
  `Verified iOS release resources: ${lock.notices.componentCount} components, ${lock.notices.licenseDocumentCount} license documents.`,
);

function verifyBundleResource(bundle, entry, expectedBytes) {
  const path = resolve(bundle, basename(entry.path));
  if (!existsSync(path)) throw new Error(`Application bundle is missing ${path}.`);
  const bytes = readFileSync(path);
  requireHash(bytes, entry.sha256, path);
  if (!bytes.equals(expectedBytes)) throw new Error(`Application resource drifted: ${path}.`);
}

function requireHash(bytes, expected, description) {
  const actual = sha256(bytes);
  if (actual !== expected) {
    // These files are hash-locked and checked out with LF everywhere, so an
    // editor or script that rewrote one with platform line endings changes its
    // bytes without changing a character. That reads as an unexplained drift
    // otherwise, and only on the machine that did not write the file.
    if (bytes.includes("\r\n")) {
      throw new Error(
        `${description} uses CRLF line endings, so its SHA-256 cannot match. ` +
          `Rewrite it with LF; the repository checks these files out with LF on every platform.`,
      );
    }
    throw new Error(`${description} SHA-256 drifted: expected ${expected}, got ${actual}.`);
  }
}

function read(path) {
  const absolutePath = resolve(root, path);
  if (!existsSync(absolutePath)) throw new Error(`Missing release resource ${absolutePath}.`);
  return readFileSync(absolutePath);
}

function readJSON(path) {
  return JSON.parse(readFileSync(resolve(root, path), "utf8"));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
