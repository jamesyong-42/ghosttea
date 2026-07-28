/**
 * Resolution for the prebuilt `ghosttead` daemon binary.
 *
 * The daemon is a Rust executable, not JavaScript, so one package cannot
 * carry it everywhere: each supported target ships in its own npm package,
 * gated by `os`/`cpu`, and installing this package pulls exactly the one
 * that matches. This module names the installed binary — or says precisely
 * which of the three possible reasons it cannot: the platform has no
 * prebuild, the optional dependency was pruned, or the platform package is
 * present with nothing staged into it, a state that exists only inside the
 * Ghosttea repository where these packages are workspace links.
 */
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

/** Platform packages keyed by `${platform}-${arch}` — the targets release CI builds and validates. */
const PLATFORM_PACKAGES: Readonly<Record<string, string>> = Object.freeze({
  "darwin-arm64": "@vibecook/ghosttead-darwin-arm64",
  "win32-x64": "@vibecook/ghosttead-win32-x64",
});

/** Targets a prebuilt daemon exists for. */
export const SUPPORTED_TARGETS: readonly string[] = Object.freeze(Object.keys(PLATFORM_PACKAGES).sort());

export interface ResolveGhostteadOptions {
  /** Defaults to `process.platform`. */
  platform?: string;
  /** Defaults to `process.arch`. */
  arch?: string;
  /** Defaults to `process.env`; `GHOSTTEAD_BIN` overrides resolution entirely. */
  env?: Readonly<Record<string, string | undefined>>;
  /** Defaults to resolving from this package; injectable so tests reach every failure without a registry. */
  resolvePackage?: (specifier: string) => string;
}

const defaultResolvePackage = (specifier: string): string => createRequire(import.meta.url).resolve(specifier);

/**
 * Absolute path of the daemon for the current platform.
 *
 * `GHOSTTEAD_BIN` wins when set. It is the same override every consumer of
 * the daemon already honors, and pointing it at a locally built
 * `target/release/ghosttead` is how development against an unreleased daemon
 * works — including on platforms with no prebuild at all.
 */
export function ghostteadPath(options: ResolveGhostteadOptions = {}): string {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const env = options.env ?? process.env;
  const resolvePackage = options.resolvePackage ?? defaultResolvePackage;

  const override = env.GHOSTTEAD_BIN;
  if (override) return override;

  const target = `${platform}-${arch}`;
  const packageName = PLATFORM_PACKAGES[target];
  if (!packageName) {
    throw new Error(
      `ghosttead has no prebuilt binary for ${target}; prebuilds exist for ${SUPPORTED_TARGETS.join(" and ")}. ` +
        "Set GHOSTTEAD_BIN to a daemon built from source to run on this platform.",
    );
  }

  let manifest: string;
  try {
    manifest = resolvePackage(`${packageName}/package.json`);
  } catch (cause) {
    throw new Error(
      `${packageName} is not installed. It arrives as an optional dependency of @vibecook/ghosttead, so an ` +
        "install that skips optional dependencies loses the daemon; reinstall with them enabled or set GHOSTTEAD_BIN.",
      { cause },
    );
  }

  const binary = join(dirname(manifest), "bin", platform === "win32" ? "ghosttead.exe" : "ghosttead");
  if (!existsSync(binary)) {
    throw new Error(
      `${packageName} resolved but ${binary} does not exist. Published packages always carry the binary; ` +
        "inside the Ghosttea repository nothing is staged outside the release workflow, so a workspace link has none.",
    );
  }
  return binary;
}
