/**
 * Resolution for the prebuilt `ghosttead` daemon binary.
 *
 * The daemon is a Rust executable, not JavaScript, so one package cannot
 * carry it everywhere: each supported target ships in its own npm package,
 * gated by `os`/`cpu`, and installing this package pulls exactly the one
 * that matches. This module names the installed binary — or says precisely
 * which of the four possible reasons it cannot: the platform has no
 * prebuild, a bundler inlined this resolver and severed its view of
 * `node_modules`, the optional dependency was pruned, or the platform
 * package is present with nothing staged into it, a state that exists only
 * inside the Ghosttea repository where these packages are workspace links.
 */
import { existsSync, realpathSync } from "node:fs";
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
  /** Defaults to `import.meta.url`; injectable so tests can stand where a bundler would put this code. */
  resolutionBase?: string | URL;
}

function notInstalled(packageName: string, cause: unknown): Error {
  return new Error(
    `${packageName} is not installed. It arrives as an optional dependency of @vibecook/ghosttead, so an ` +
      "install that skips optional dependencies loses the daemon; reinstall with them enabled or set GHOSTTEAD_BIN.",
    { cause },
  );
}

function inlinedByBundler(packageName: string, cause: unknown): Error {
  return new Error(
    `${packageName} cannot be resolved, and no reachable node_modules contains @vibecook/ghosttead either — ` +
      "the signature of this resolver having been inlined into a bundle, which severs the node_modules walk " +
      "it depends on. Mark @vibecook/ghosttead external in the bundler (see its README) or set GHOSTTEAD_BIN.",
    { cause },
  );
}

/**
 * The platform package's manifest path, resolved the way installs actually
 * lay packages out.
 *
 * The platform packages are dependencies of this package, not of the
 * consumer, and pnpm's strict layout makes them visible only from beside
 * this package's real directory. From the unbundled module that is one
 * resolution — but a bundler that inlines this code moves it into the
 * consumer's output, where the direct walk finds nothing. The consumer does
 * depend on `@vibecook/ghosttead`, so its installed directory is usually
 * still reachable from the bundle; resolving the platform package from that
 * directory's real path restores exactly the walk the unbundled module
 * would have done. The lookup scans `require.resolve.paths()` by hand
 * because this package's `exports` map would otherwise stand between a
 * `require`-based probe and its own `package.json`.
 *
 * A base that cannot see even `@vibecook/ghosttead` is not a layout problem
 * at all, and is reported as what it is: bundling without `external`.
 */
function resolveInstalledManifest(packageName: string, base: string | URL): string {
  let requireFromBase: ReturnType<typeof createRequire>;
  try {
    requireFromBase = createRequire(base);
  } catch (cause) {
    // A bundler that erased `import.meta.url` outright lands here.
    throw inlinedByBundler(packageName, cause);
  }
  let directFailure: unknown;
  try {
    return requireFromBase.resolve(`${packageName}/package.json`);
  } catch (error) {
    directFailure = error;
  }
  let selfManifest: string | undefined;
  for (const directory of requireFromBase.resolve.paths("@vibecook/ghosttead") ?? []) {
    const candidate = join(directory, "@vibecook", "ghosttead", "package.json");
    if (existsSync(candidate)) {
      // Follow the package manager's link so the sibling walk starts from
      // the store directory that actually holds the platform packages.
      selfManifest = realpathSync(candidate);
      break;
    }
  }
  if (!selfManifest) throw inlinedByBundler(packageName, directFailure);
  try {
    return createRequire(selfManifest).resolve(`${packageName}/package.json`);
  } catch (cause) {
    throw notInstalled(packageName, cause);
  }
}

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
  if (options.resolvePackage) {
    try {
      manifest = options.resolvePackage(`${packageName}/package.json`);
    } catch (cause) {
      throw notInstalled(packageName, cause);
    }
  } else {
    manifest = resolveInstalledManifest(packageName, options.resolutionBase ?? import.meta.url);
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
