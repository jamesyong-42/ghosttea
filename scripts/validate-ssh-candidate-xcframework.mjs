import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const defaultArtifact = join(root, "apple/GhostteaKit/Artifacts/ghosttea-libssh2-candidate.xcframework");
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
  if (!condition) throw new Error(`Invalid SSH candidate XCFramework: ${message}`);
}

assert(process.platform === "darwin", "validation requires macOS Apple tooling");
assert(existsSync(artifact), `artifact does not exist: ${artifact}`);
const infoPath = join(artifact, "Info.plist");
assert(existsSync(infoPath), "Info.plist is missing");
const info = JSON.parse(capture("plutil", ["-convert", "json", "-o", "-", infoPath]));
assert(info.XCFrameworkFormatVersion === "1.0", "unsupported XCFramework format");
assert(Array.isArray(info.AvailableLibraries), "AvailableLibraries is missing");

const expectedSlices = [
  { platform: "macos", variant: undefined },
  { platform: "ios", variant: undefined },
  { platform: "ios", variant: "simulator" },
];
const requiredSymbols = [
  "_libssh2_init",
  "_libssh2_session_init_ex",
  "_libssh2_userauth_keyboard_interactive_ex",
  "_libssh2_version",
];

for (const expected of expectedSlices) {
  const slice = info.AvailableLibraries.find(
    (candidate) =>
      candidate.SupportedPlatform === expected.platform &&
      candidate.SupportedPlatformVariant === expected.variant &&
      candidate.SupportedArchitectures?.includes("arm64"),
  );
  assert(slice, `missing ${expected.platform}${expected.variant ? `-${expected.variant}` : ""} slice`);
  const library = join(artifact, slice.LibraryIdentifier, slice.LibraryPath);
  const headers = join(artifact, slice.LibraryIdentifier, slice.HeadersPath);
  assert(existsSync(library), `library is missing for ${slice.LibraryIdentifier}`);
  for (const header of ["libssh2.h", "libssh2_publickey.h", "libssh2_sftp.h", "module.modulemap"]) {
    assert(existsSync(join(headers, header)), `${header} is missing for ${slice.LibraryIdentifier}`);
  }
  const archive = readFileSync(library);
  assert(
    archive.subarray(0, 8).toString("ascii") === "!<arch>\n",
    `${slice.LibraryIdentifier} is not a static archive`,
  );
  const architectures = capture("xcrun", ["lipo", "-archs", library]).split(/\s+/).filter(Boolean);
  assert(architectures.includes("arm64"), `${slice.LibraryIdentifier} is missing arm64`);
  const symbols = capture("xcrun", ["nm", "-gU", library]);
  for (const symbol of requiredSymbols) {
    assert(symbols.includes(symbol), `${slice.LibraryIdentifier} is missing ${symbol}`);
  }
}

console.log(`Validated ${artifact}`);
