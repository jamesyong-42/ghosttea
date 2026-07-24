import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const packageVersion = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
const artifact = join(root, "apple/GhostteaKit/Artifacts/GhostteaCoreFFI.xcframework");
const headers = join(root, "native/terminald/crates/ghosttea-ffi/include");
const ghosttyArtifact = join(root, "apple/GhostteaKit/Artifacts/ghostty-vt.xcframework");
const developerDir = process.env.DEVELOPER_DIR ?? "/Applications/Xcode.app/Contents/Developer";
const environment = {
  ...process.env,
  DEVELOPER_DIR: developerDir,
  IPHONEOS_DEPLOYMENT_TARGET: "17.0",
  MACOSX_DEPLOYMENT_TARGET: "14.0",
};

function run(command, args, extraEnvironment = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    env: { ...environment, ...extraEnvironment },
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function capture(command, args) {
  const result = spawnSync(command, args, { cwd: root, env: environment, encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr || `${command} failed`);
  return result.stdout.trim();
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

if (process.platform !== "darwin" || process.arch !== "arm64") {
  throw new Error("Building GhostteaCoreFFI requires Apple Silicon macOS.");
}
if (!existsSync(join(ghosttyArtifact, "Info.plist"))) {
  throw new Error("Build the pinned Ghostty VT Apple XCFramework first.");
}

const ghosttyInfo = JSON.parse(capture("plutil", ["-convert", "json", "-o", "-", join(ghosttyArtifact, "Info.plist")]));
const prefixRoot = join(root, "native/build/ghosttea-core-prefixes");
rmSync(prefixRoot, { recursive: true, force: true });

function ghosttySlice(target) {
  const simulator = target.endsWith("-sim");
  const platform = target === "aarch64-apple-darwin" ? "macos" : "ios";
  return ghosttyInfo.AvailableLibraries.find(
    (slice) =>
      slice.SupportedPlatform === platform &&
      (slice.SupportedPlatformVariant === "simulator") === simulator &&
      slice.SupportedArchitectures.includes("arm64"),
  );
}

function stageGhosttyPrefix(target) {
  const slice = ghosttySlice(target);
  if (!slice) throw new Error(`Missing pinned Ghostty slice for ${target}.`);
  const sliceRoot = join(ghosttyArtifact, slice.LibraryIdentifier);
  const prefix = join(prefixRoot, target);
  const libraryDirectory = join(prefix, "lib");
  mkdirSync(libraryDirectory, { recursive: true });
  cpSync(join(sliceRoot, slice.HeadersPath, "ghostty"), join(prefix, "include/ghostty"), {
    recursive: true,
  });
  const sourceLibrary = join(sliceRoot, slice.LibraryPath);
  const outputLibrary = join(libraryDirectory, "libghostty-vt.a");
  const architectures = capture("xcrun", ["lipo", "-archs", sourceLibrary]).split(/\s+/);
  if (architectures.length > 1) {
    run("xcrun", ["lipo", sourceLibrary, "-thin", "arm64", "-output", outputLibrary]);
  } else {
    cpSync(sourceLibrary, outputLibrary);
  }
  return prefix;
}

const targets = ["aarch64-apple-darwin", "aarch64-apple-ios", "aarch64-apple-ios-sim"];
for (const target of targets) {
  const prefix = stageGhosttyPrefix(target);
  run("cargo", ["build", "-p", "ghosttea-ffi", "--release", "--target", target], {
    GHOSTTY_VT_PREFIX: prefix,
  });
}

const staging = join(root, "native/build/ghosttea-core-apple");
rmSync(staging, { recursive: true, force: true });
rmSync(artifact, { recursive: true, force: true });
mkdirSync(staging, { recursive: true });

const libraries = targets.map((target) => {
  const directory = join(staging, target);
  const stagedHeaders = join(directory, "Headers");
  const library = join(root, "target", target, "release", "libghosttea_ffi.a");
  if (!existsSync(library)) throw new Error(`Missing Rust static library ${library}.`);
  mkdirSync(directory, { recursive: true });
  cpSync(headers, stagedHeaders, { recursive: true });
  return { library, headers: stagedHeaders };
});

const xcframeworkArguments = ["-create-xcframework"];
for (const slice of libraries) {
  xcframeworkArguments.push("-library", slice.library, "-headers", slice.headers);
}
xcframeworkArguments.push("-output", artifact);
run("xcodebuild", xcframeworkArguments);
writeFileSync(
  join(staging, "metadata.json"),
  `${JSON.stringify(
    {
      schemaVersion: 1,
      abiVersion: 1,
      packageVersion,
      sourceCommit: capture("git", ["rev-parse", "HEAD"]),
      sourceDirty: capture("git", ["status", "--porcelain"]).length > 0,
      rustc: capture("rustc", ["--version"]),
      xcode: capture("xcodebuild", ["-version"]).split("\n"),
      headerSha256: sha256(join(headers, "ghosttea.h")),
      slices: targets.map((target, index) => ({
        target,
        librarySha256: sha256(libraries[index].library),
      })),
    },
    null,
    2,
  )}\n`,
);
console.log(`Built ${artifact}`);
