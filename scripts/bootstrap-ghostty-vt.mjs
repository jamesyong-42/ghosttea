import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const lock = JSON.parse(readFileSync(join(root, "native/ghostty.lock.json"), "utf8"));
const vendor = join(root, "native/vendor/ghostty");
const tools = join(root, ".tools");
const zig = join(tools, `zig-aarch64-linux-${lock.zig.version}`, "zig");

function run(command, args, cwd = root) {
  const result = spawnSync(command, args, { cwd, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

mkdirSync(join(root, "native/vendor"), { recursive: true });
mkdirSync(tools, { recursive: true });

if (!existsSync(join(vendor, ".git"))) {
  run("git", ["init", vendor]);
  run("git", ["remote", "add", "origin", lock.ghostty.repository], vendor);
  run("git", ["fetch", "--depth=1", "origin", lock.ghostty.commit], vendor);
  run("git", ["checkout", "--detach", lock.ghostty.commit], vendor);
}

const revision = spawnSync("git", ["rev-parse", "HEAD"], { cwd: vendor, encoding: "utf8" });
if (revision.status !== 0 || revision.stdout.trim() !== lock.ghostty.commit) {
  throw new Error(`native/vendor/ghostty must be at ${lock.ghostty.commit}`);
}

if (!existsSync(zig)) {
  const archive = join(tmpdir(), basename(new URL(lock.zig.linuxAarch64Url).pathname));
  const response = await fetch(lock.zig.linuxAarch64Url);
  if (!response.ok) throw new Error(`Zig download failed: ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const checksum = createHash("sha256").update(bytes).digest("hex");
  if (checksum !== lock.zig.linuxAarch64Sha256) {
    throw new Error(`Zig checksum mismatch: expected ${lock.zig.linuxAarch64Sha256}, received ${checksum}`);
  }
  writeFileSync(archive, bytes);
  try {
    run("tar", ["-xf", archive, "-C", tools]);
  } finally {
    rmSync(archive, { force: true });
  }
}

console.log(`Ghostty ${lock.ghostty.commit} and Zig ${lock.zig.version} are ready.`);
