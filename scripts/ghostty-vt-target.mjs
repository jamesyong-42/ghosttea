/**
 * Shared Ghostty VT target resolution.
 *
 * Every Ghostty VT script keys off a Rust target triple declared in
 * `native/ghostty.lock.json`. Targets differ in how they are produced:
 *
 * - `container` targets cross-compile inside the pinned Linux builder image,
 *   which is fully hermetic and is how the macOS artifact is produced;
 * - `native` targets build on a matching host because Zig cannot supply the
 *   toolchain hermetically. `x86_64-pc-windows-msvc` is native because
 *   Microsoft's CRT headers and import libraries are not redistributable, so
 *   Zig must find an installed MSVC and Windows SDK.
 */
import { readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

export const root = resolve(import.meta.dirname, "..");
export const lock = JSON.parse(readFileSync(join(root, "native/ghostty.lock.json"), "utf8"));
export const targets = lock.targets;

const TARGET_FLAG = "--target=";

/**
 * The target this host builds when none is requested. A host with its own
 * native builder defaults to it; every other host defaults to the container
 * cross-build, which runs anywhere Docker does.
 */
export function defaultTarget() {
  const native = Object.entries(targets).find(([, config]) => config.hostPlatform === process.platform);
  if (native) return native[0];
  const container = Object.entries(targets).find(([, config]) => config.build === "container");
  if (!container) throw new Error("ghostty.lock.json declares no container target");
  return container[0];
}

export function resolveTarget(argv = process.argv.slice(2)) {
  const flag = argv.find((value) => value.startsWith(TARGET_FLAG));
  const target = flag ? flag.slice(TARGET_FLAG.length) : defaultTarget();
  if (!targets[target]) {
    throw new Error(`Unknown Ghostty VT target ${target}; known targets: ${Object.keys(targets).join(", ")}`);
  }
  return target;
}

export function targetConfig(target) {
  return targets[target];
}

/** The pinned Zig distribution a target's builder runs. */
export function zigDistribution(target) {
  const name = targets[target].zigDistribution;
  const url = lock.zig[`${name}Url`];
  const sha256 = lock.zig[`${name}Sha256`];
  if (!url || !sha256) throw new Error(`ghostty.lock.json has no Zig distribution named ${name}`);
  const directory = basename(new URL(url).pathname).replace(/\.(tar\.xz|zip)$/, "");
  return { name, url, sha256, directory, archive: url.endsWith(".zip") ? "zip" : "tar.xz" };
}

export function zigRoot(target) {
  return join(root, ".tools", zigDistribution(target).directory);
}

export function zigExecutable(target) {
  const distribution = zigDistribution(target);
  return join(zigRoot(target), distribution.directory.includes("-windows-") ? "zig.exe" : "zig");
}

/** Per-target install tree, so one checkout can hold several platforms. */
export function installPrefix(target) {
  return join(root, "native/build/ghostty", target);
}

/** Bundle-relative path of the static archive Ghostty installs for a target. */
export function libraryPath(target) {
  return targets[target].libraryPath;
}

/**
 * A native target may only be built on a matching host.
 */
export function assertBuildableHost(target) {
  const config = targets[target];
  if (config.build === "native" && config.hostPlatform !== process.platform) {
    throw new Error(
      `${target} builds natively on ${config.hostPlatform}; this host is ${process.platform}. ` +
        `Zig cannot cross-compile to it hermetically.`,
    );
  }
}
