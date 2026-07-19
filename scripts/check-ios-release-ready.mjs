import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const checks = [
  ["scripts/check-ghostty-upgrade-procedure.mjs"],
  ["scripts/check-ios-release-bom.mjs", "--release"],
  ["scripts/check-ios-release-resources.mjs"],
  ["scripts/check-ios-release-toolchain.mjs"],
  ["scripts/check-ios-app-store-readiness.mjs", "--release"],
  ["scripts/check-ios-beta-matrix.mjs", "--release"],
  ["scripts/check-ios-instruments-evidence.mjs", "--release"],
];
let failed = false;

for (const args of checks) {
  const result = spawnSync("node", args, { cwd: root, encoding: "utf8", stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) failed = true;
}

if (failed) {
  console.error("iOS release readiness failed; resolve every blocker reported above.");
  process.exitCode = 1;
} else {
  console.log("iOS release readiness passed.");
}
