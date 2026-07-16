import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const lock = JSON.parse(readFileSync(join(root, "native/ghostty.lock.json"), "utf8"));
const vendor = join(root, "native/vendor/ghostty");
const tools = join(root, ".tools");
const zigRoot = join(tools, `zig-aarch64-macos-${lock.zig.version}`);
const zig = join(zigRoot, "zig");
const developerDir = process.env.DEVELOPER_DIR ?? "/Applications/Xcode.app/Contents/Developer";
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
  throw new Error(`Xcode developer directory does not exist: ${developerDir}`);
}

capture("xcodebuild", ["-version"]);
capture("xcrun", ["--sdk", "iphoneos", "--show-sdk-path"]);
capture("xcrun", ["--sdk", "iphonesimulator", "--show-sdk-path"]);

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
  `Ghostty ${lock.ghostty.commit}, Zig ${lock.zig.version}, and ${capture("xcodebuild", ["-version"]).replaceAll("\n", " ")} are ready.`,
);
