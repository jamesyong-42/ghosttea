// Install the published binary packages from the registry and prove they
// work. The release gate validates the artifacts it builds; the registry
// serves different objects — they went through staging, `npm pack`, an
// optionalDependencies split, and a tarball round-trip — and nothing in the
// gate ever installs or executes those. This does, so "published" and
// "verified" stay the same claim.
//
// Runs on the platforms the daemon ships for and on one it deliberately does
// not: the resolver failing closed with a useful message on Linux is as much
// published contract as the daemon starting on macOS.
//
// usage: node scripts/smoke-published.mjs <version>
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const version = process.argv[2];
if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
  console.error("usage: node scripts/smoke-published.mjs <exact published version>");
  process.exit(1);
}

/**
 * Run npm without going through its Windows `.cmd` shim; Node refuses to
 * `execFile` one (CVE-2024-27980). The pattern matches `check-packages.mjs`.
 */
function runNpm(args, options) {
  const cli = process.env.npm_execpath;
  if (cli) return execFileSync(process.execPath, [cli, ...args], options);
  return execFileSync(process.platform === "win32" ? "npm.cmd" : "npm", args, {
    ...options,
    shell: process.platform === "win32",
  });
}

const consumer = mkdtempSync(join(tmpdir(), "ghosttea-published-smoke-"));
writeFileSync(
  join(consumer, "package.json"),
  JSON.stringify({ name: "ghosttea-published-smoke", private: true, type: "module" }, null, 2),
);

// Installed from the registry only: no workspace links, no tarballs, exactly
// what a consumer's lockfile would resolve.
runNpm(
  ["install", "--no-audit", "--no-fund", `@vibecook/ghosttead@${version}`, `@vibecook/ghosttea-native-tabs@${version}`],
  { cwd: consumer, stdio: "inherit" },
);

const probe = `
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { SUPPORTED_TARGETS, ghostteadPath } from "@vibecook/ghosttead";
import { addonPath, loadNativeTabs } from "@vibecook/ghosttea-native-tabs";

const version = process.env.SMOKE_VERSION;
const target = process.platform + "-" + process.arch;

if (SUPPORTED_TARGETS.includes(target)) {
  const daemon = ghostteadPath();
  if (!existsSync(daemon)) throw new Error("resolved daemon does not exist: " + daemon);
  const result = spawnSync(daemon, ["--version"], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error("ghosttead --version exited " + result.status + ": " + (result.stderr || result.error));
  }
  const reported = result.stdout.trim();
  if (reported !== "ghosttead " + version) {
    throw new Error('daemon reports "' + reported + '", expected "ghosttead ' + version + '"');
  }
  console.log("ok  " + target + " daemon runs from the registry install and reports " + version);
} else {
  let failed = false;
  try {
    ghostteadPath();
  } catch (error) {
    failed = true;
    if (!String(error).includes("GHOSTTEAD_BIN")) {
      throw new Error("the unsupported-platform error does not name the override: " + error);
    }
  }
  if (!failed) throw new Error(target + " has no prebuild but resolution did not fail closed");
  console.log("ok  " + target + " fails closed and names GHOSTTEAD_BIN");
}

if (process.platform === "darwin") {
  const tabs = loadNativeTabs();
  if (typeof tabs?.tabOrder !== "function") throw new Error("native tabs addon loaded without tabOrder");
  console.log("ok  native tabs addon loads from the registry prebuild");
} else {
  if (addonPath() !== null || loadNativeTabs() !== null) throw new Error("native tabs must be null off macOS");
  console.log("ok  native tabs is null on " + process.platform + ", by contract");
}

console.log("published package smoke passed");
`;
writeFileSync(join(consumer, "probe.mjs"), probe);
execFileSync(process.execPath, ["probe.mjs"], {
  cwd: consumer,
  stdio: "inherit",
  env: { ...process.env, SMOKE_VERSION: version },
});
