import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const project = join(root, "apple/GhostteaHarness/GhostteaHarness.xcodeproj");
const artifacts = [
  join(root, "apple/GhostteaKit/Artifacts/ghostty-vt.xcframework"),
  join(root, "apple/GhostteaKit/Artifacts/ghosttea-libssh2-candidate.xcframework"),
];
const combinedArtifact = join(root, "apple/GhostteaKit/Artifacts/ghosttea-apple-native.xcframework");
const buildRoot = join(root, "native/build/ios-harness");
const moduleCache = join(buildRoot, "module-cache");
const environment = {
  ...process.env,
  CLANG_MODULE_CACHE_PATH: moduleCache,
  SWIFTPM_MODULECACHE_OVERRIDE: moduleCache,
  DEVELOPER_DIR: process.env.DEVELOPER_DIR ?? "/Applications/Xcode.app/Contents/Developer",
};

if (process.platform !== "darwin" || process.arch !== "arm64") {
  throw new Error("The iOS harness build currently requires Apple Silicon macOS.");
}
for (const artifact of artifacts) {
  if (!existsSync(artifact)) {
    throw new Error(`Missing ${artifact}. Build the Apple VT and SSH artifacts first.`);
  }
}
const appleNative = spawnSync(process.execPath, [join(root, "scripts/build-ghosttea-apple-native.mjs")], {
  cwd: root,
  env: environment,
  encoding: "utf8",
});
if (appleNative.error) throw appleNative.error;
if (appleNative.status !== 0) throw new Error(appleNative.stdout + appleNative.stderr);
process.stdout.write(appleNative.stdout);
if (!existsSync(combinedArtifact)) throw new Error(`Missing composed artifact ${combinedArtifact}.`);
rmSync(buildRoot, { recursive: true, force: true });
mkdirSync(moduleCache, { recursive: true });

function build(name, destination, sdk) {
  const result = spawnSync(
    "xcodebuild",
    [
      "-project",
      project,
      "-scheme",
      "GhostteaHarness",
      "-configuration",
      "Debug",
      "-quiet",
      "-destination",
      destination,
      "-sdk",
      sdk,
      "-derivedDataPath",
      join(buildRoot, name),
      "ARCHS=arm64",
      "CODE_SIGNING_ALLOWED=NO",
      "build",
    ],
    { cwd: root, env: environment, encoding: "utf8" },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(result.stdout + result.stderr);
  }
  process.stdout.write(result.stdout);
}

build("simulator", "generic/platform=iOS Simulator", "iphonesimulator");
build("device", "generic/platform=iOS", "iphoneos");
console.log("Ghosttea iOS harness builds for arm64 simulator and physical-device SDKs.");
