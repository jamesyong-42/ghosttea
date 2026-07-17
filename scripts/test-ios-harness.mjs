import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const project = join(root, "apple/GhostteaHarness/GhostteaHarness.xcodeproj");
const artifacts = [
  join(root, "apple/GhostteaKit/Artifacts/ghostty-vt.xcframework"),
  join(root, "apple/GhostteaKit/Artifacts/ghosttea-libssh2-candidate.xcframework"),
];
const fontFixtureArtifact = join(root, "apple/GhostteaKit/Artifacts/ghosttea-font-fixture.xcframework");
const coreArtifact = join(root, "apple/GhostteaKit/Artifacts/GhostteaCoreFFI.xcframework");
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
const fontFixture = spawnSync(process.execPath, [join(root, "scripts/build-font-fixture-apple.mjs")], {
  cwd: root,
  env: environment,
  encoding: "utf8",
});
if (fontFixture.error) throw fontFixture.error;
if (fontFixture.status !== 0) throw new Error(fontFixture.stdout + fontFixture.stderr);
process.stdout.write(fontFixture.stdout);
if (!existsSync(fontFixtureArtifact)) throw new Error(`Missing ${fontFixtureArtifact}.`);
const core = spawnSync(process.execPath, [join(root, "scripts/build-ghosttea-core-apple.mjs")], {
  cwd: root,
  env: environment,
  encoding: "utf8",
});
if (core.error) throw core.error;
if (core.status !== 0) throw new Error(core.stdout + core.stderr);
process.stdout.write(core.stdout);
if (!existsSync(coreArtifact)) throw new Error(`Missing ${coreArtifact}.`);
const compose = spawnSync(process.execPath, [join(root, "scripts/compose-ghosttea-apple-native.mjs")], {
  cwd: root,
  env: environment,
  encoding: "utf8",
});
if (compose.error) throw compose.error;
if (compose.status !== 0) throw new Error(compose.stderr);
process.stdout.write(compose.stdout);
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
