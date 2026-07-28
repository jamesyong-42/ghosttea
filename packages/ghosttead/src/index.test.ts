import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test } from "vitest";
import { SUPPORTED_TARGETS, ghostteadPath } from "./index.js";

/**
 * A platform package on disk, with or without its staged binary. Resolution
 * failures must be reachable on every development platform, so the package is
 * injected rather than resolved from the workspace.
 */
function packageFixture(binaryName: string | null): (specifier: string) => string {
  const root = mkdtempSync(join(tmpdir(), "ghosttead-resolver-"));
  writeFileSync(join(root, "package.json"), "{}\n");
  if (binaryName) {
    mkdirSync(join(root, "bin"));
    writeFileSync(join(root, "bin", binaryName), "not a real daemon");
  }
  return () => join(root, "package.json");
}

test("GHOSTTEAD_BIN overrides resolution entirely, even on unsupported platforms", () => {
  const path = ghostteadPath({
    platform: "linux",
    arch: "riscv64",
    env: { GHOSTTEAD_BIN: "/builds/ghosttead" },
  });
  expect(path).toBe("/builds/ghosttead");
});

test("an unsupported platform names what is supported and the way out", () => {
  const resolve = () => ghostteadPath({ platform: "linux", arch: "x64", env: {} });
  expect(resolve).toThrow(/no prebuilt binary for linux-x64/);
  expect(resolve).toThrow(new RegExp(SUPPORTED_TARGETS.join(" and ")));
  expect(resolve).toThrow(/GHOSTTEAD_BIN/);
});

test("a pruned optional dependency is diagnosed, not surfaced as a bare module error", () => {
  const resolvePackage = () => {
    throw new Error("Cannot find module '@vibecook/ghosttead-darwin-arm64/package.json'");
  };
  expect(() => ghostteadPath({ platform: "darwin", arch: "arm64", env: {}, resolvePackage })).toThrow(
    /optional dependency/,
  );
});

test("resolves the staged binary inside the platform package", () => {
  const resolvePackage = packageFixture("ghosttead");
  const path = ghostteadPath({ platform: "darwin", arch: "arm64", env: {}, resolvePackage });
  expect(path).toMatch(/bin[\\/]ghosttead$/);
});

test("the Windows binary carries its executable suffix", () => {
  const resolvePackage = packageFixture("ghosttead.exe");
  const path = ghostteadPath({ platform: "win32", arch: "x64", env: {}, resolvePackage });
  expect(path).toMatch(/bin[\\/]ghosttead\.exe$/);
});

test("a platform package without a staged binary says where staging happens", () => {
  const resolvePackage = packageFixture(null);
  expect(() => ghostteadPath({ platform: "win32", arch: "x64", env: {}, resolvePackage })).toThrow(/release workflow/);
});

/**
 * A pnpm-shaped install as a bundled consumer sees it: the app's
 * `node_modules` holds only a link to this package's real directory inside a
 * store, the platform package exists only as that directory's sibling, and
 * the resolution base is the bundler's output directory — where a direct
 * walk finds no platform package at all (vibecook-dev/ghosttea#22).
 */
function bundledPnpmFixture({ platformInstalled }: { platformInstalled: boolean }): URL {
  const root = mkdtempSync(join(tmpdir(), "ghosttead-bundled-"));
  const store = join(root, ".pnpm", "ghosttead@0.0.0", "node_modules", "@vibecook");
  mkdirSync(join(store, "ghosttead"), { recursive: true });
  writeFileSync(join(store, "ghosttead", "package.json"), "{}\n");
  if (platformInstalled) {
    const platform = join(store, "ghosttead-darwin-arm64");
    mkdirSync(join(platform, "bin"), { recursive: true });
    writeFileSync(join(platform, "package.json"), "{}\n");
    writeFileSync(join(platform, "bin", "ghosttead"), "not a real daemon");
  }
  const applicationModules = join(root, "app", "node_modules", "@vibecook");
  mkdirSync(applicationModules, { recursive: true });
  // Junctions keep this runnable on Windows CI, where plain directory
  // symlinks require elevation.
  symlinkSync(
    join(store, "ghosttead"),
    join(applicationModules, "ghosttead"),
    process.platform === "win32" ? "junction" : "dir",
  );
  const bundleDirectory = join(root, "app", "dist");
  mkdirSync(bundleDirectory, { recursive: true });
  return pathToFileURL(join(bundleDirectory, "main.cjs"));
}

test("an inlined resolver still finds the daemon through the installed package", () => {
  const resolutionBase = bundledPnpmFixture({ platformInstalled: true });
  const path = ghostteadPath({ platform: "darwin", arch: "arm64", env: {}, resolutionBase });
  expect(path).toMatch(/bin[\\/]ghosttead$/);
  // Through the store's real directory, not the app's node_modules.
  expect(path).toContain(".pnpm");
});

test("an inlined resolver with a pruned platform package still diagnoses the pruning", () => {
  const resolutionBase = bundledPnpmFixture({ platformInstalled: false });
  expect(() => ghostteadPath({ platform: "darwin", arch: "arm64", env: {}, resolutionBase })).toThrow(
    /optional dependency/,
  );
});

test("a base that cannot reach the package at all names bundling, not a missing install", () => {
  // No node_modules anywhere above the temp directory: the walk a bundle
  // without `external` performs.
  const resolutionBase = pathToFileURL(join(mkdtempSync(join(tmpdir(), "ghosttead-severed-")), "main.cjs"));
  const resolve = () => ghostteadPath({ platform: "darwin", arch: "arm64", env: {}, resolutionBase });
  expect(resolve).toThrow(/inlined into a bundle/);
  expect(resolve).toThrow(/external/);
  expect(resolve).toThrow(/GHOSTTEAD_BIN/);
});
