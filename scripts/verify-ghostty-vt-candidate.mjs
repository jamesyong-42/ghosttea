import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { ghosttySourceDigest, ghosttySourceIdentity, root } from "./ghostty-vt-target.mjs";

const target = argument("--target=");
const directory = resolve(argument("--directory="));
const manifest = JSON.parse(readFileSync(join(root, "native/ghosttea/crates/ghosttea-vt-sys/artifacts.json"), "utf8"));
const locked = manifest.targets?.[target];
if (!locked) throw new Error(`No locked Ghostty VT artifact for ${target}.`);
if (!locked.reproducible && (!Number.isSafeInteger(locked.candidateRunId) || locked.candidateRunId <= 0)) {
  throw new Error(`The ${target} artifact must name a positive candidateRunId before promotion.`);
}

const bundlePath = join(directory, locked.filename);
const resultPath = `${bundlePath}.json`;
const sbomPath = `${bundlePath}.spdx.json`;
const bundle = readFileSync(bundlePath);
const result = JSON.parse(readFileSync(resultPath, "utf8"));
const sidecarSbom = readFileSync(sbomPath);

requireEqual(bundle.length, locked.size, "bundle size");
requireEqual(sha256(bundle), locked.sha256, "bundle SHA-256");
requireEqual(result.schemaVersion, 1, "candidate result schema version");
requireEqual(result.target, target, "candidate result target");
for (const field of [
  "sourceDigest",
  "release",
  "filename",
  "url",
  "sha256",
  "size",
  "libraryPath",
  "librarySha256",
  "headersSha256",
  "reproducible",
]) {
  requireEqual(result[field], locked[field], `candidate result ${field}`);
}

const entries = tarEntries(bundle);
const artifact = JSON.parse(requiredEntry(entries, "artifact.json").toString("utf8"));
const bundledSbom = requiredEntry(entries, "sbom.spdx.json");
requireEqual(sidecarSbom, bundledSbom, "sidecar/bundled SBOM bytes");
requireEqual(artifact.target, target, "bundled target");
requireEqual(artifact.source, manifest.source, "bundled source identity");
requireEqual(artifact.source, { ...ghosttySourceIdentity(), digest: ghosttySourceDigest() }, "current source identity");

const sbom = JSON.parse(sidecarSbom.toString("utf8"));
requireEqual(sbom.name, `${locked.release}-${target}`, "SBOM name");
requireEqual(sbom.packages?.[0]?.versionInfo, locked.sourceDigest, "SBOM source digest");

console.log(
  `Verified ${target} candidate${locked.candidateRunId ? ` from workflow run ${locked.candidateRunId}` : ""}: ${locked.filename} (${locked.sha256}).`,
);

function argument(prefix) {
  const value = process.argv
    .slice(2)
    .find((candidate) => candidate.startsWith(prefix))
    ?.slice(prefix.length);
  if (!value) throw new Error(`Missing ${prefix}<value>.`);
  return value;
}

function sha256(contents) {
  return createHash("sha256").update(contents).digest("hex");
}

function tarEntries(contents) {
  const entries = new Map();
  let offset = 0;
  while (offset + 512 <= contents.length) {
    const header = contents.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/s, "");
    const encodedSize = header.subarray(124, 136).toString("ascii").replace(/\0.*$/s, "").trim();
    const size = Number.parseInt(encodedSize || "0", 8);
    if (!name || !Number.isSafeInteger(size) || size < 0) throw new Error("Malformed candidate tar header.");
    const start = offset + 512;
    const end = start + size;
    if (end > contents.length) throw new Error(`Truncated candidate tar entry ${name}.`);
    if (entries.has(name)) throw new Error(`Duplicate candidate tar entry ${name}.`);
    entries.set(name, contents.subarray(start, end));
    offset = start + Math.ceil(size / 512) * 512;
  }
  return entries;
}

function requiredEntry(entries, name) {
  const contents = entries.get(name);
  if (!contents) throw new Error(`Candidate bundle omits ${name}.`);
  return contents;
}

function requireEqual(actual, expected, description) {
  const equal =
    Buffer.isBuffer(actual) && Buffer.isBuffer(expected)
      ? actual.equals(expected)
      : JSON.stringify(actual) === JSON.stringify(expected);
  if (!equal) {
    throw new Error(
      `${description} mismatch: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}.`,
    );
  }
}
