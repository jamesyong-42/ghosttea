// Guards the three ways the published GhostteaKit package can silently stop
// resolving:
//
//   1. The root manifest's URL/checksum drift from the artifact lock.
//   2. The root and local manifests drift into different package graphs — they
//      are mirrors except for how the native artifact is sourced.
//   3. The locked artifact stops describing the artifact actually on disk.
//
// `--release` additionally requires the asset to be published, so a release
// cannot ship a manifest pointing at a URL that does not resolve yet.
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import {
  collectEntries,
  contentDigest,
  lockPath,
  readLock,
  root,
  sourceArtifact,
} from "./ghosttea-apple-native-artifact.mjs";

const releaseMode = process.argv.includes("--release");
const lock = readLock();
const problems = [];

const rootManifest = join(root, "Package.swift");
const localManifest = join(root, "apple/GhostteaKit/Package.swift");

// ── 1. The root manifest pins what the lock records ──────────────────────────
const manifestText = readFileSync(rootManifest, "utf8");
const pinned = (name) => manifestText.match(new RegExp(`let ${name} =\\s*\\n?\\s*"([^"]+)"`))?.[1] ?? null;

const pinnedURL = pinned("appleNativeURL");
const pinnedChecksum = pinned("appleNativeChecksum");

if (pinnedURL !== lock.url) {
  problems.push(`Package.swift pins appleNativeURL ${pinnedURL ?? "<unparsed>"}, but the lock records ${lock.url}.`);
}
if (pinnedChecksum !== lock.checksum) {
  problems.push(
    `Package.swift pins appleNativeChecksum ${pinnedChecksum ?? "<unparsed>"}, but the lock records ${lock.checksum}.`,
  );
}
// The tag is what makes the URL content-addressed; a URL that no longer contains
// it would resolve to some other artifact's release.
if (!lock.url.includes(`/download/${lock.tag}/`)) {
  problems.push(`The locked URL does not carry the locked tag ${lock.tag}.`);
}
if (!lock.url.endsWith(`/${lock.filename}`)) {
  problems.push(`The locked URL does not end in the locked filename ${lock.filename}.`);
}

// ── 2. Both manifests describe the same package ─────────────────────────────
function dumpPackage(packagePath) {
  const result = spawnSync("swift", ["package", "--package-path", packagePath, "dump-package"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    problems.push(`swift package dump-package failed for ${packagePath}: ${result.stderr?.trim() || result.error}`);
    return null;
  }
  return JSON.parse(result.stdout);
}

// Dependency order is meaningless to SwiftPM, so compare as a set — an ordering
// difference is not drift and should not fail a release.
function shape(dump) {
  return {
    // Package-level pins, not just target wiring. A `truffleRevision` bumped in
    // one manifest and not the other is invisible in products and targets — both
    // sides keep naming the same `.product(name:package:)` — but it would ship
    // consumers a different Truffle than Apple development builds against.
    dependencies: (dump.dependencies ?? [])
      .flatMap((dependency) => dependency.sourceControl ?? [])
      .map((source) =>
        [
          source.identity,
          source.location?.remote?.map((remote) => remote.urlString).join(",") ?? "<local>",
          JSON.stringify(source.requirement),
        ].join("|"),
      )
      .toSorted(),
    products: dump.products
      .map((product) => `${product.name}:${JSON.stringify(product.targets.toSorted())}`)
      .toSorted(),
    targets: dump.targets
      .map((target) =>
        [
          target.name,
          target.type,
          JSON.stringify(target.dependencies.map((dependency) => JSON.stringify(dependency)).toSorted()),
        ].join("|"),
      )
      .toSorted(),
  };
}

if (spawnSync("swift", ["--version"], { encoding: "utf8" }).status !== 0) {
  console.warn("swift is unavailable; skipping the manifest-parity comparison.");
} else {
  const rootDump = dumpPackage(".");
  const localDump = dumpPackage("apple/GhostteaKit");
  if (rootDump && localDump) {
    const rootShape = shape(rootDump);
    const localShape = shape(localDump);
    for (const field of ["dependencies", "products", "targets"]) {
      const onlyRoot = rootShape[field].filter((entry) => !localShape[field].includes(entry));
      const onlyLocal = localShape[field].filter((entry) => !rootShape[field].includes(entry));
      for (const entry of onlyRoot) problems.push(`${field}: only Package.swift declares ${entry}`);
      for (const entry of onlyLocal) problems.push(`${field}: only apple/GhostteaKit/Package.swift declares ${entry}`);
    }
    // The one intended difference: the root manifest fetches the artifact, the
    // local one builds against it. Assert that rather than let it slip.
    const binaryTargetOf = (dump) => dump.targets.find((target) => target.type === "binary");
    if (binaryTargetOf(rootDump)?.url !== lock.url) {
      problems.push("Package.swift's binary target must be sourced by url; it is not.");
    }
    if (binaryTargetOf(localDump)?.path !== "Artifacts/ghosttea-apple-native.xcframework") {
      problems.push(
        "apple/GhostteaKit/Package.swift's binary target must stay path-sourced so Apple development builds against a local artifact.",
      );
    }
  }
}

if (!readFileSync(localManifest, "utf8").includes("Artifacts/ghosttea-apple-native.xcframework")) {
  problems.push(`${localManifest} no longer references the local artifact path.`);
}

// ── 3. The lock still describes the artifact on disk ────────────────────────
if (existsSync(sourceArtifact)) {
  const entries = collectEntries();
  const digest = contentDigest(entries);
  if (digest !== lock.contentDigest) {
    problems.push(
      `The composed artifact has content digest ${digest}, but the lock records ${lock.contentDigest}. ` +
        `Re-run \`npm run package:ghosttea-apple-native\`, publish the new tag, and update ${lockPath}.`,
    );
  }
} else {
  // Not a failure: the artifact is a gitignored build output, and this check has
  // to pass on a machine that has never run the Apple build.
  console.warn("The composed artifact is absent; skipping the content-digest comparison.");
}

// ── Release gate ────────────────────────────────────────────────────────────
if (releaseMode && lock.published !== true) {
  problems.push(
    `The Apple native artifact is not published yet (published: false in ${lockPath}). ` +
      `Publish ${lock.filename} under tag ${lock.tag}, then set published to true.`,
  );
}

if (problems.length > 0) {
  console.error(problems.map((problem) => `- ${problem}`).join("\n"));
  process.exit(1);
}

console.log(
  `Apple native artifact lock is consistent (tag ${lock.tag}, published: ${lock.published})` +
    `${releaseMode ? " and release-ready" : ""}.`,
);
