import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const packageRoot = join(root, "apple/GhostteaKit");
const artifact = join(packageRoot, "Artifacts/ghostty-vt.xcframework");
const developerDir = process.env.DEVELOPER_DIR ?? "/Applications/Xcode.app/Contents/Developer";
const moduleCache = join(packageRoot, ".build/module-cache");
const commandEnvironment = {
  ...process.env,
  CLANG_MODULE_CACHE_PATH: moduleCache,
  DEVELOPER_DIR: developerDir,
  SWIFTPM_MODULECACHE_OVERRIDE: moduleCache,
};

if (process.platform !== "darwin" || process.arch !== "arm64") {
  throw new Error("The Ghostty VT memory probe currently requires Apple Silicon macOS.");
}
if (!existsSync(artifact)) {
  throw new Error("The Ghostty VT XCFramework is missing. Run `npm run build:ghostty-vt:apple` first.");
}

mkdirSync(moduleCache, { recursive: true });

function swift(args, options = {}) {
  const result = spawnSync("swift", args, {
    cwd: packageRoot,
    env: commandEnvironment,
    encoding: options.encoding,
    stdio: options.stdio,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    if (result.stderr) process.stderr.write(result.stderr);
    process.exit(result.status ?? 1);
  }
  return result.stdout?.trim();
}

swift(["build", "--disable-sandbox", "-c", "release", "--product", "GhosttyVtMemoryProbe"], {
  stdio: "inherit",
});
const binaryDirectory = swift(["build", "--disable-sandbox", "-c", "release", "--show-bin-path"], {
  encoding: "utf8",
});
const binary = join(binaryDirectory, "GhosttyVtMemoryProbe");
const requestedArguments = process.argv.slice(2);

if (requestedArguments.length === 1 && requestedArguments[0] === "--matrix") {
  const configurations = [
    ["--sessions", "1", "--lines", "1000", "--scrollback-bytes", "1000000"],
    ["--sessions", "1", "--lines", "10000", "--scrollback-bytes", "10000000"],
    ["--sessions", "4", "--lines", "10000", "--scrollback-bytes", "10000000"],
    ["--sessions", "8", "--lines", "10000", "--scrollback-bytes", "10000000"],
  ];
  const measurements = configurations.map((args) => {
    const result = spawnSync(binary, args, {
      cwd: packageRoot,
      env: commandEnvironment,
      encoding: "utf8",
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(result.stderr || `memory probe failed for ${args.join(" ")}`);
    return JSON.parse(result.stdout);
  });
  console.log(JSON.stringify({ schemaVersion: 1, measurements }, null, 2));
  process.exit(0);
}

const result = spawnSync(binary, requestedArguments, {
  cwd: packageRoot,
  env: commandEnvironment,
  stdio: "inherit",
});
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
