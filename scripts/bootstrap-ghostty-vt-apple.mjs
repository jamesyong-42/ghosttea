import { createHash } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { spawnSync } from "node:child_process";
import { lock, prepareGhosttySource, root } from "./ghostty-vt-target.mjs";

const vendor = join(root, "native/vendor/ghostty");
const tools = join(root, ".tools");
const zigRoot = join(tools, `zig-aarch64-macos-${lock.zig.version}`);
const zig = join(zigRoot, "zig");
const developerDir =
  process.env.GHOSTTY_DEVELOPER_DIR ?? `/Applications/Xcode_${lock.appleBuilder.xcodeVersion}.app/Contents/Developer`;
const commandEnvironment = { ...process.env, DEVELOPER_DIR: developerDir };

function run(command, args, cwd = root) {
  const result = spawnSync(command, args, { cwd, env: commandEnvironment, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function capture(command, args, cwd = root) {
  const result = spawnSync(command, args, { cwd, env: commandEnvironment, encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr || `${command} failed`);
  return result.stdout.trim();
}

if (process.platform !== "darwin" || process.arch !== "arm64") {
  throw new Error("The pinned Apple bootstrap currently requires Apple Silicon macOS.");
}
if (!existsSync(developerDir)) {
  throw new Error(
    `Pinned Ghostty Xcode developer directory does not exist: ${developerDir}. ` +
      "Set GHOSTTY_DEVELOPER_DIR to the reviewed side-by-side Xcode installation.",
  );
}

const xcode = capture("xcodebuild", ["-version"]);
const macosSdk = capture("xcrun", ["--sdk", "macosx", "--show-sdk-version"]);
const iphoneosSdk = capture("xcrun", ["--sdk", "iphoneos", "--show-sdk-version"]);
const simulatorSdk = capture("xcrun", ["--sdk", "iphonesimulator", "--show-sdk-version"]);
capture("xcrun", ["--sdk", "iphoneos", "--show-sdk-path"]);
capture("xcrun", ["--sdk", "iphonesimulator", "--show-sdk-path"]);

for (const [description, actual, expected] of [
  ["Xcode version", xcode, `Xcode ${lock.appleBuilder.xcodeVersion}`],
  ["Xcode build", xcode, `Build version ${lock.appleBuilder.xcodeBuild}`],
  ["macOS SDK", macosSdk, lock.appleBuilder.macosSdkVersion],
  ["iPhoneOS SDK", iphoneosSdk, lock.appleBuilder.iphoneosSdkVersion],
  ["iPhoneSimulator SDK", simulatorSdk, lock.appleBuilder.iphonesimulatorSdkVersion],
]) {
  if (!actual.includes(expected)) {
    throw new Error(`${description} drifted; expected ${JSON.stringify(expected)} in ${JSON.stringify(actual)}.`);
  }
}

mkdirSync(join(root, "native/vendor"), { recursive: true });
mkdirSync(tools, { recursive: true });

if (!existsSync(join(vendor, ".git"))) {
  run("git", ["init", vendor]);
  run("git", ["remote", "add", "origin", lock.ghostty.repository], vendor);
  run("git", ["fetch", "--depth=1", "origin", lock.ghostty.commit], vendor);
  run("git", ["checkout", "--detach", lock.ghostty.commit], vendor);
}

if (capture("git", ["rev-parse", "HEAD"], vendor) !== lock.ghostty.commit) {
  throw new Error(`native/vendor/ghostty must be at ${lock.ghostty.commit}`);
}
prepareGhosttySource(vendor);

if (!existsSync(zig)) {
  const archive = join(tmpdir(), basename(new URL(lock.zig.macosAarch64Url).pathname));
  const response = await fetch(lock.zig.macosAarch64Url);
  if (!response.ok) throw new Error(`Zig download failed: ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const checksum = createHash("sha256").update(bytes).digest("hex");
  if (checksum !== lock.zig.macosAarch64Sha256) {
    throw new Error(`Zig checksum mismatch: expected ${lock.zig.macosAarch64Sha256}, received ${checksum}`);
  }
  writeFileSync(archive, bytes);
  try {
    run("tar", ["-xf", archive, "-C", tools]);
  } finally {
    rmSync(archive, { force: true });
  }
}

if (capture(zig, ["version"]) !== lock.zig.version) {
  throw new Error(`Expected Zig ${lock.zig.version} at ${zig}`);
}

console.log(
  `Ghostty ${lock.ghostty.commit} with the locked VT patch set, Zig ${lock.zig.version}, and ${xcode.replaceAll("\n", " ")} are ready.`,
);
