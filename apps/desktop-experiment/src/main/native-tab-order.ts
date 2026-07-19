import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { app } from "electron";

interface NativeTabBinding {
  tabOrder(handles: readonly Buffer[]): unknown;
}

interface NativeTabWindow {
  getNativeWindowHandle(): Buffer;
}

let binding: NativeTabBinding | null | undefined;
let warned = false;

function loadBinding(): NativeTabBinding | null {
  if (binding !== undefined) return binding;
  const filename = "ghosttea_native_tabs.node";
  const candidates = app.isPackaged
    ? [join(process.resourcesPath, "native", filename)]
    : [
        join(app.getAppPath(), "native", "build", "Release", filename),
        join(app.getAppPath(), "apps", "desktop", "native", "build", "Release", filename),
      ];
  const require = createRequire(import.meta.url);
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    try {
      const loaded = require(candidate) as Partial<NativeTabBinding>;
      if (typeof loaded.tabOrder !== "function") throw new Error("native tab addon does not export tabOrder");
      binding = loaded as NativeTabBinding;
      return binding;
    } catch (error) {
      if (!warned) console.warn(`[terminal-runtime] failed to load native tab ordering from ${candidate}`, error);
      warned = true;
    }
  }
  if (!warned) console.warn("[terminal-runtime] native tab ordering addon is unavailable");
  warned = true;
  binding = null;
  return null;
}

export function validatedNativeOrder(length: number, value: unknown): number[] | null {
  if (!Array.isArray(value) || value.length !== length) return null;
  const indexes = value.filter((index): index is number => Number.isSafeInteger(index) && index >= 0 && index < length);
  return indexes.length === length && new Set(indexes).size === length ? indexes : null;
}

/** Returns the actual AppKit tab order, including user drag reordering. */
export function orderNativeTabs<Window extends NativeTabWindow>(windows: readonly Window[]): Window[] {
  if (process.platform !== "darwin" || windows.length < 2) return [...windows];
  const native = loadBinding();
  if (!native) return [...windows];
  const indexes = validatedNativeOrder(
    windows.length,
    native.tabOrder(windows.map((window) => window.getNativeWindowHandle())),
  );
  return indexes ? indexes.map((index) => windows[index]!) : [...windows];
}
