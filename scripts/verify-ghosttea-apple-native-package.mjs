import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import {
  archiveName,
  binaryTargetName,
  bundleName,
  collectEntries,
  contentDigest,
  downloadUrl,
  nativeSourceDigest,
  releaseTag,
  sha256,
  sliceDigests,
} from "./ghosttea-apple-native-artifact.mjs";

const directory = resolve(process.argv[2] ?? "artifacts/apple-native");
const archivePath = join(directory, archiveName);
const resultPath = join(directory, `${archiveName}.json`);
const problems = [];

if (!existsSync(archivePath)) problems.push(`Missing ${archivePath}.`);
if (!existsSync(resultPath)) problems.push(`Missing ${resultPath}.`);
if (problems.length > 0) fail();

const result = JSON.parse(readFileSync(resultPath, "utf8"));
const archive = readFileSync(archivePath);
const checksum = sha256(archive);
if (process.platform === "darwin") {
  const swiftChecksum = spawnSync("swift", ["package", "compute-checksum", archivePath], {
    env: {
      ...process.env,
      DEVELOPER_DIR: process.env.DEVELOPER_DIR ?? "/Applications/Xcode.app/Contents/Developer",
    },
    encoding: "utf8",
  });
  if (swiftChecksum.status !== 0) {
    problems.push(
      `SwiftPM could not compute the candidate checksum: ${swiftChecksum.stderr?.trim() || swiftChecksum.error}`,
    );
  } else {
    requireEqual(swiftChecksum.stdout.trim(), checksum, "SwiftPM checksum");
  }
}

requireEqual(result.schemaVersion, 1, "schemaVersion");
requireEqual(result.binaryTarget, binaryTargetName, "binaryTarget");
requireEqual(result.bundleName, bundleName, "bundleName");
requireEqual(result.filename, archiveName, "filename");
requireEqual(result.size, archive.length, "size");
requireEqual(result.checksum, checksum, "checksum");
requireEqual(result.sourceDigest, nativeSourceDigest(), "sourceDigest");

const scratch = mkdtempSync(join(tmpdir(), "ghosttea-apple-native-package-"));
try {
  const scratchArchive = join(scratch, archiveName);
  writeFileSync(scratchArchive, archive);
  const unzip = spawnSync("unzip", ["-q", scratchArchive, "-d", scratch], {
    encoding: "utf8",
  });
  if (unzip.status !== 0) {
    problems.push(`Could not unpack ${archivePath}: ${unzip.stderr?.trim() || unzip.error}`);
  } else {
    const entries = collectEntries(join(scratch, bundleName), bundleName);
    const digest = contentDigest(entries);
    const tag = releaseTag(digest);
    requireEqual(result.entries, entries.length, "entries");
    requireEqual(result.contentDigest, digest, "contentDigest");
    requireEqual(result.tag, tag, "tag");
    requireEqual(result.url, downloadUrl(tag), "url");

    const actualSlices = sliceDigests(entries);
    for (const [slice, expected] of Object.entries(result.slices ?? {})) {
      requireEqual(actualSlices[slice], expected, `slices.${slice}`);
    }
    for (const slice of Object.keys(actualSlices)) {
      if (!(slice in (result.slices ?? {}))) problems.push(`Unrecorded archive slice ${slice}.`);
    }
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

if (problems.length > 0) fail();
console.log(
  `Verified Apple native package ${result.tag}: ${archive.length} bytes, checksum ${checksum}, source ${result.sourceDigest}.`,
);

function requireEqual(actual, expected, field) {
  if (actual !== expected) {
    problems.push(`${field} is ${JSON.stringify(actual)}; expected ${JSON.stringify(expected)}.`);
  }
}

function fail() {
  console.error(problems.map((problem) => `- ${problem}`).join("\n"));
  process.exit(1);
}
