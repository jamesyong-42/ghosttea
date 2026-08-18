import { createHash } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  lock,
  prepareGhosttySource,
  resolveTarget,
  root,
  zigDistribution,
  zigExecutable,
} from "./ghostty-vt-target.mjs";

const target = resolveTarget();
const vendor = join(root, "native/vendor/ghostty");
const tools = join(root, ".tools");
const distribution = zigDistribution(target);
const zig = zigExecutable(target);

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
prepareGhosttySource(vendor);

if (!existsSync(zig)) {
  const archive = join(tmpdir(), basename(new URL(distribution.url).pathname));
  const response = await fetch(distribution.url);
  if (!response.ok) throw new Error(`Zig download failed: ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const checksum = createHash("sha256").update(bytes).digest("hex");
  if (checksum !== distribution.sha256) {
    throw new Error(`Zig checksum mismatch: expected ${distribution.sha256}, received ${checksum}`);
  }
  writeFileSync(archive, bytes);
  try {
    // Zig ships .tar.xz for POSIX hosts and .zip for Windows. Git for Windows
    // puts GNU tar ahead of the system bsdtar on PATH and GNU tar cannot read a
    // zip, so name the Windows archiver explicitly rather than trusting
    // resolution order.
    const bsdtar = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");
    const archiver = distribution.archive === "zip" && existsSync(bsdtar) ? bsdtar : "tar";
    run(archiver, ["-xf", archive, "-C", tools]);
  } finally {
    rmSync(archive, { force: true });
  }
  if (!existsSync(zig)) throw new Error(`Zig ${lock.zig.version} did not extract to ${zig}`);
}

console.log(
  `Ghostty ${lock.ghostty.commit} with the locked VT patch set and Zig ${lock.zig.version} are ready for ${target}.`,
);
