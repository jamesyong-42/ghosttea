import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const packageRoot = join(root, "apple/GhostteaKit");
const artifact = join(packageRoot, "Artifacts/ghostty-vt.xcframework");
const sshCandidateArtifact = join(packageRoot, "Artifacts/ghosttea-libssh2-candidate.xcframework");
const developerDir = process.env.DEVELOPER_DIR ?? "/Applications/Xcode.app/Contents/Developer";
const moduleCache = join(packageRoot, ".build/module-cache");
const commandEnvironment = {
  ...process.env,
  CLANG_MODULE_CACHE_PATH: moduleCache,
  DEVELOPER_DIR: developerDir,
  SWIFTPM_MODULECACHE_OVERRIDE: moduleCache,
};

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: packageRoot,
    env: commandEnvironment,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function capture(command, args) {
  const result = spawnSync(command, args, {
    cwd: packageRoot,
    env: commandEnvironment,
    encoding: "utf8",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr || `${command} failed`);
  return result.stdout.trim();
}

if (process.platform !== "darwin" || process.arch !== "arm64") {
  throw new Error("The Apple integration proof currently requires Apple Silicon macOS.");
}
if (!existsSync(artifact)) {
  throw new Error("The Ghostty VT XCFramework is missing. Run `npm run build:ghostty-vt:apple` first.");
}
if (!existsSync(sshCandidateArtifact)) {
  throw new Error("The SSH candidate XCFramework is missing. Run `npm run build:ssh:apple` first.");
}

run("node", [join(root, "scripts/build-ghosttea-apple-native.mjs")]);

mkdirSync(moduleCache, { recursive: true });
run("swift", ["test", "--disable-sandbox"]);

const simulatorSdk = capture("xcrun", ["--sdk", "iphonesimulator", "--show-sdk-path"]);
for (const target of [
  "GhosttyVtProof",
  "GhostteaCredentials",
  "GhostteaTransport",
  "GhostteaSSHProbe",
  "GhostteaSSH",
]) {
  run("swift", [
    "build",
    "--disable-sandbox",
    "--triple",
    "arm64-apple-ios17.0-simulator",
    "--sdk",
    simulatorSdk,
    "--build-path",
    ".build/ios-simulator",
    "--target",
    target,
  ]);
}

const deviceSdk = capture("xcrun", ["--sdk", "iphoneos", "--show-sdk-path"]);
for (const target of [
  "GhosttyVtProof",
  "GhostteaCredentials",
  "GhostteaTransport",
  "GhostteaSSHProbe",
  "GhostteaSSH",
]) {
  run("swift", [
    "build",
    "--disable-sandbox",
    "--triple",
    "arm64-apple-ios17.0",
    "--sdk",
    deviceSdk,
    "--build-path",
    ".build/ios-device",
    "--target",
    target,
  ]);
}

console.log("Swift VT, transport, and nonblocking SSH candidate passed on macOS and arm64 iOS SDKs.");
