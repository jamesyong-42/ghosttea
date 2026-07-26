import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const appDirectory = resolve(root, process.argv[2] ?? "apps/desktop");
const manifest = resolve(root, "Cargo.toml");
const result = spawnSync("cargo", ["build", "--release", "--package", "ghosttead", "--manifest-path", manifest], {
  cwd: root,
  stdio: "inherit",
});
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);

const executable = process.platform === "win32" ? "ghosttead.exe" : "ghosttead";
const source = resolve(root, "target/release", executable);
const destination = resolve(appDirectory, "build/bin", executable);
mkdirSync(dirname(destination), { recursive: true });
copyFileSync(source, destination);
if (process.platform !== "win32") chmodSync(destination, 0o755);
console.log(`staged ghosttead at ${destination}`);
