/**
 * The macOS native window-tab ordering addon, prebuilt.
 *
 * AppKit owns the real tab order the moment a user drags a tab, and Electron
 * does not expose it; the addon reads it straight from AppKit. The compiled
 * `.node` ships inside this package as a universal (arm64 + x86_64) binary,
 * and because it is built against N-API (`NAPI_VERSION=8`), the same file
 * loads in every Node and Electron a consumer runs — there is no per-runtime
 * build matrix.
 *
 * Everywhere but macOS the addon has nothing to read. Both entry points
 * return `null` there, which is the contract consumers already code to: no
 * native tabs, not an error.
 */
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

export interface NativeTabs {
  /** AppKit's tab order for windows identified by their `getNativeWindowHandle()` buffers. */
  tabOrder(handles: readonly Buffer[]): unknown;
}

export interface NativeTabsOptions {
  /** Defaults to `process.platform`. */
  platform?: string;
}

const PREBUILD = new URL("../prebuilds/ghosttea_native_tabs.node", import.meta.url);

/**
 * Absolute path of the prebuilt addon, or null off macOS.
 *
 * Electron main processes are usually bundled, and a bundle cannot `require`
 * a `.node` file that stayed behind in `node_modules`; builds copy the file
 * from this path next to their own output instead. `dist` and `prebuilds`
 * are siblings inside the package, so the path is stable relative to this
 * module.
 */
export function addonPath(options: NativeTabsOptions = {}): string | null {
  const platform = options.platform ?? process.platform;
  if (platform !== "darwin") return null;
  const path = fileURLToPath(PREBUILD);
  if (!existsSync(path)) {
    throw new Error(
      `${path} does not exist. Published packages always carry the prebuild; inside the Ghosttea repository ` +
        "it is produced by `npm run build:ghosttea-native-tabs`, which the release workflow runs before publishing.",
    );
  }
  return path;
}

/** The loaded addon, or null off macOS. */
export function loadNativeTabs(options: NativeTabsOptions = {}): NativeTabs | null {
  const path = addonPath(options);
  if (path === null) return null;
  const loaded = createRequire(import.meta.url)(path) as Partial<NativeTabs>;
  // The exported shape is validated at load so a defective build fails here,
  // with a named cause, rather than at first use inside a consumer.
  if (typeof loaded.tabOrder !== "function") {
    throw new Error("ghosttea_native_tabs.node does not export tabOrder");
  }
  return loaded as NativeTabs;
}
