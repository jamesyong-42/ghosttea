import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const defaultArtifact = join(root, "native/build/ghostty-apple/install/lib/ghostty-vt.xcframework");
const artifact = resolve(process.argv[2] ?? defaultArtifact);
const developerDir = process.env.DEVELOPER_DIR ?? "/Applications/Xcode.app/Contents/Developer";
const commandEnvironment = { ...process.env, DEVELOPER_DIR: developerDir };

function capture(command, args) {
  const result = spawnSync(command, args, { env: commandEnvironment, encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr || `${command} failed`);
  return result.stdout.trim();
}

function assert(condition, message) {
  if (!condition) throw new Error(`Invalid Ghostty VT XCFramework: ${message}`);
}

assert(process.platform === "darwin", "validation requires macOS Apple tooling");
assert(existsSync(artifact), `artifact does not exist: ${artifact}`);
const infoPath = join(artifact, "Info.plist");
assert(existsSync(infoPath), "Info.plist is missing");
const info = JSON.parse(capture("plutil", ["-convert", "json", "-o", "-", infoPath]));
assert(info.XCFrameworkFormatVersion === "1.0", "unsupported XCFramework format");
assert(Array.isArray(info.AvailableLibraries), "AvailableLibraries is missing");

const expectedSlices = [
  { platform: "macos", variant: undefined, architectures: ["arm64", "x86_64"] },
  { platform: "ios", variant: undefined, architectures: ["arm64"] },
  { platform: "ios", variant: "simulator", architectures: ["arm64"] },
];

for (const expected of expectedSlices) {
  const slice = info.AvailableLibraries.find(
    (candidate) =>
      candidate.SupportedPlatform === expected.platform &&
      candidate.SupportedPlatformVariant === expected.variant &&
      expected.architectures.every((architecture) => candidate.SupportedArchitectures?.includes(architecture)),
  );
  assert(slice, `missing ${expected.platform}${expected.variant ? `-${expected.variant}` : ""} slice`);
  const library = join(artifact, slice.LibraryIdentifier, slice.LibraryPath);
  const headers = join(artifact, slice.LibraryIdentifier, slice.HeadersPath);
  assert(existsSync(library), `library is missing for ${slice.LibraryIdentifier}`);
  assert(existsSync(join(headers, "module.modulemap")), `module map is missing for ${slice.LibraryIdentifier}`);
  assert(existsSync(join(headers, "ghostty/vt.h")), `umbrella header is missing for ${slice.LibraryIdentifier}`);
  const archive = readFileSync(library);
  const archiveMagic = archive.subarray(0, 8).toString("ascii") === "!<arch>\n";
  const fatMagic = new Set([0xcafebabe, 0xcafebabf]).has(archive.readUInt32BE(0));
  assert(
    archiveMagic || fatMagic,
    `${slice.LibraryIdentifier} is neither a static archive nor a universal static archive`,
  );
  const lipo = capture("xcrun", ["lipo", "-archs", library]).split(/\s+/).filter(Boolean);
  for (const architecture of expected.architectures) {
    assert(lipo.includes(architecture), `${slice.LibraryIdentifier} is missing ${architecture}`);
  }
}

console.log(`Validated ${artifact}`);
