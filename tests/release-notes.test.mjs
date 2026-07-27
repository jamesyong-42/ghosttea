// Release notes are generated once per release, on a tag, inside CI. A defect
// here surfaces at the least recoverable moment, so the extraction is pinned
// here rather than discovered during a release.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { changelogSection, publishedCrates, publishedPackages, releaseNotes } from "../scripts/release-notes.mjs";

const CHANGELOG = `# Changelog

Preamble that belongs to no release.

## 0.4.0 - 2026-07-25

### Added

- A thing.

### Fixed

- Another thing.

## 0.3.0 - 2026-07-24

### Changed

- An older thing.
`;

test("extracts one version and stops at the next", () => {
  const section = changelogSection(CHANGELOG, "0.4.0");
  assert.match(section, /- A thing\./);
  assert.match(section, /- Another thing\./);
  assert.doesNotMatch(section, /older thing/, "leaked into the following release");
  assert.doesNotMatch(section, /Preamble/, "leaked from before the first release");
});

test("promotes headings, because the version is already the release title", () => {
  const section = changelogSection(CHANGELOG, "0.4.0");
  assert.match(section, /^## Added$/m);
  assert.doesNotMatch(section, /^### /m);
});

test("reads the last release without running past the end", () => {
  assert.match(changelogSection(CHANGELOG, "0.3.0"), /- An older thing\./);
});

test("a version prefix is not a version", () => {
  // `0.4` must not match the `0.4.0` heading and ship the wrong notes.
  assert.throws(() => changelogSection(CHANGELOG, "0.4"), /no section for 0\.4/);
});

test("fails closed on a version the changelog does not describe", () => {
  assert.throws(() => changelogSection(CHANGELOG, "9.9.9"), /no section for 9\.9\.9/);
});

test("fails closed on a section with no content", () => {
  assert.throws(() => changelogSection("## 1.0.0 - 2026-01-01\n\n## 0.9.0\n", "1.0.0"), /is empty/);
});

test("lists what the workspace actually publishes", () => {
  const crates = publishedCrates();
  const packages = publishedPackages();
  // Declared `publish = false`, so they must never appear in release notes.
  for (const priv of ["ghosttead", "ghosttea-ffi", "ghosttea-font-fixture-ffi"]) {
    assert.ok(!crates.includes(priv), `${priv} is private but was listed`);
  }
  assert.ok(crates.includes("ghosttea-vt-sys"), "a published crate went missing");
  assert.ok(
    packages.every((name) => name.startsWith("@vibecook/")),
    "an unscoped package was listed",
  );
  assert.ok(!packages.includes("ghosttea-demo"), "a private application was listed");
});

test("renders this repository's current version end to end", () => {
  const version = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
  const notes = releaseNotes(version);
  assert.match(notes, /^Ghosttea is a native Ghostty-powered terminal runtime/);
  assert.match(notes, /## Packages/);
  assert.match(notes, /## Requirements/);
  assert.match(notes, /Node \d+\+ and Rust /);
});
