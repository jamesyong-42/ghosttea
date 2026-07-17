import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "darwin") process.exit(0);

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const nativeDirectory = join(root, "apps", "desktop", "native");
const output = join(nativeDirectory, "build", "Release", "ghosttea_native_tabs.node");
const inputs = [join(nativeDirectory, "binding.gyp"), join(nativeDirectory, "macos-tab-order.mm")];
if (existsSync(output) && inputs.every((input) => statSync(input).mtimeMs <= statSync(output).mtimeMs)) process.exit(0);

const nodeGyp = join(root, "node_modules", "node-gyp", "bin", "node-gyp.js");
const result = spawnSync(process.execPath, [nodeGyp, "rebuild", "--directory", nativeDirectory], {
  cwd: root,
  stdio: "inherit",
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
