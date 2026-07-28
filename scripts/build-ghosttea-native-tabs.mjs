// Build the native tabs addon as a macOS universal binary and stage it into
// `packages/ghosttea-native-tabs/prebuilds/`, where the package publishes it.
//
// The addon's two source files stay with the desktop app that first needed
// them. They are copied into a scratch directory and built there once per
// architecture, so the app's own incremental `native/build` output is never
// disturbed, and `lipo` merges the slices afterwards. N-API keeps the result
// ABI-stable across Node and Electron, so these two slices are the entire
// build matrix.
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "darwin") {
  console.error("the native tabs prebuild is macOS-only; the release workflow builds it in the macOS validate job");
  process.exit(1);
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(root, "apps", "desktop-experiment", "native");
const nodeGyp = join(root, "node_modules", "node-gyp", "bin", "node-gyp.js");
const output = join(root, "packages", "ghosttea-native-tabs", "prebuilds", "ghosttea_native_tabs.node");

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const scratch = mkdtempSync(join(tmpdir(), "ghosttea-native-tabs-"));
const slices = [];
try {
  for (const arch of ["arm64", "x64"]) {
    const directory = join(scratch, arch);
    mkdirSync(directory, { recursive: true });
    for (const file of ["binding.gyp", "macos-tab-order.mm"]) {
      copyFileSync(join(source, file), join(directory, file));
    }
    run(process.execPath, [nodeGyp, "rebuild", "--directory", directory, `--arch=${arch}`]);
    slices.push(join(directory, "build", "Release", "ghosttea_native_tabs.node"));
  }
  mkdirSync(dirname(output), { recursive: true });
  run("lipo", ["-create", ...slices, "-output", output]);
  run("lipo", ["-info", output]);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
console.log(`staged ${output}`);
