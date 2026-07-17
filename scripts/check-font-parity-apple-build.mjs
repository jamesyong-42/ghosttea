import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const developerDir = process.env.DEVELOPER_DIR ?? "/Applications/Xcode.app/Contents/Developer";
const environment = { ...process.env, DEVELOPER_DIR: developerDir };
const targets = ["aarch64-apple-ios", "aarch64-apple-ios-sim"];

if (process.platform !== "darwin" || process.arch !== "arm64") {
  throw new Error("The Apple font build gate requires Apple Silicon macOS.");
}

for (const target of targets) {
  const result = spawnSync("cargo", ["check", "-p", "ghosttea-text", "--all-features", "--target", target], {
    cwd: root,
    env: environment,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

console.log(`Ghosttea text engine cross-compiled for ${targets.join(" and ")}`);
