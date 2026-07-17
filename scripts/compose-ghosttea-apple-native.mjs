import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const artifacts = join(root, "apple/GhostteaKit/Artifacts");
const ghosttyArtifact = join(artifacts, "ghostty-vt.xcframework");
const sshArtifact = join(artifacts, "ghosttea-libssh2-candidate.xcframework");
const fontFixtureArtifact = join(artifacts, "ghosttea-font-fixture.xcframework");
const coreArtifact = join(artifacts, "GhostteaCoreFFI.xcframework");
const output = join(artifacts, "ghosttea-apple-native.xcframework");
const work = join(root, "native/build/ghosttea-apple-native");
const developerDir = process.env.DEVELOPER_DIR ?? "/Applications/Xcode.app/Contents/Developer";
const environment = { ...process.env, DEVELOPER_DIR: developerDir };

function capture(command, args) {
  const result = spawnSync(command, args, { cwd: root, env: environment, encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr || `${command} failed`);
  return result.stdout.trim();
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, env: environment, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function readXCFramework(path) {
  return JSON.parse(capture("plutil", ["-convert", "json", "-o", "-", join(path, "Info.plist")]));
}

function sliceFor(info, platform, variant) {
  const slice = info.AvailableLibraries?.find(
    (candidate) =>
      candidate.SupportedPlatform === platform &&
      candidate.SupportedPlatformVariant === variant &&
      candidate.SupportedArchitectures?.includes("arm64"),
  );
  if (!slice) throw new Error(`Missing ${platform}${variant ? `-${variant}` : ""} arm64 slice.`);
  return slice;
}

function libraryPath(artifact, slice) {
  return join(artifact, slice.LibraryIdentifier, slice.LibraryPath);
}

function headersPath(artifact, slice) {
  return join(artifact, slice.LibraryIdentifier, slice.HeadersPath);
}

if (process.platform !== "darwin" || process.arch !== "arm64") {
  throw new Error("Composing the Apple native artifact requires Apple Silicon macOS.");
}
for (const artifact of [ghosttyArtifact, sshArtifact, fontFixtureArtifact, coreArtifact]) {
  if (!existsSync(join(artifact, "Info.plist"))) {
    throw new Error(`Missing ${artifact}. Build every Apple native artifact first.`);
  }
}

const ghosttyInfo = readXCFramework(ghosttyArtifact);
const sshInfo = readXCFramework(sshArtifact);
const fontFixtureInfo = readXCFramework(fontFixtureArtifact);
const coreInfo = readXCFramework(coreArtifact);
rmSync(work, { recursive: true, force: true });
rmSync(output, { recursive: true, force: true });
mkdirSync(work, { recursive: true });

const platforms = [
  { name: "macos-arm64", platform: "macos", variant: undefined },
  { name: "ios-arm64", platform: "ios", variant: undefined },
  { name: "ios-arm64-simulator", platform: "ios", variant: "simulator" },
];
const libraries = [];

for (const platform of platforms) {
  const ghosttySlice = sliceFor(ghosttyInfo, platform.platform, platform.variant);
  const sshSlice = sliceFor(sshInfo, platform.platform, platform.variant);
  const fontFixtureSlice = sliceFor(fontFixtureInfo, platform.platform, platform.variant);
  const coreSlice = sliceFor(coreInfo, platform.platform, platform.variant);
  const directory = join(work, platform.name);
  const headers = join(directory, "Headers");
  const ghosttyHeaders = headersPath(ghosttyArtifact, ghosttySlice);
  const sshHeaders = headersPath(sshArtifact, sshSlice);
  const fontFixtureHeaders = headersPath(fontFixtureArtifact, fontFixtureSlice);
  const coreHeaders = headersPath(coreArtifact, coreSlice);
  mkdirSync(headers, { recursive: true });
  cpSync(join(ghosttyHeaders, "ghostty"), join(headers, "ghostty"), { recursive: true });
  for (const header of ["libssh2.h", "libssh2_publickey.h", "libssh2_sftp.h"]) {
    cpSync(join(sshHeaders, header), join(headers, header));
  }
  cpSync(join(fontFixtureHeaders, "ghosttea_font_fixture.h"), join(headers, "ghosttea_font_fixture.h"));
  cpSync(join(coreHeaders, "ghosttea.h"), join(headers, "ghosttea.h"));
  writeFileSync(
    join(headers, "module.modulemap"),
    [
      "module GhosttyVt {",
      '  umbrella header "ghostty/vt.h"',
      "  export *",
      "}",
      "module LibSSH2Candidate {",
      '  header "libssh2.h"',
      '  header "libssh2_publickey.h"',
      '  header "libssh2_sftp.h"',
      "  export *",
      "}",
      "module GhostteaFontFixtureNative {",
      '  header "ghosttea_font_fixture.h"',
      "  export *",
      "}",
      "module GhostteaCoreNative {",
      '  header "ghosttea.h"',
      "  export *",
      "}",
      "",
    ].join("\n"),
  );

  let ghosttyLibrary = libraryPath(ghosttyArtifact, ghosttySlice);
  const architectures = capture("xcrun", ["lipo", "-archs", ghosttyLibrary]).split(/\s+/);
  if (architectures.length > 1) {
    const thinned = join(directory, `arm64-${basename(ghosttyLibrary)}`);
    run("xcrun", ["lipo", ghosttyLibrary, "-thin", "arm64", "-output", thinned]);
    ghosttyLibrary = thinned;
  }

  const library = join(directory, "libghosttea-apple-native.a");
  run("xcrun", [
    "libtool",
    "-static",
    "-o",
    library,
    ghosttyLibrary,
    libraryPath(sshArtifact, sshSlice),
    libraryPath(fontFixtureArtifact, fontFixtureSlice),
    libraryPath(coreArtifact, coreSlice),
  ]);
  libraries.push({ library, headers });
}

const args = ["-create-xcframework"];
for (const slice of libraries) args.push("-library", slice.library, "-headers", slice.headers);
args.push("-output", output);
run("xcodebuild", args);
console.log(`Composed ${output}`);
