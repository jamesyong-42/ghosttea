import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
