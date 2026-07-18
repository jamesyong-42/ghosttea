import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const packageRoot = join(root, "apple/GhostteaKit");
const artifact = join(packageRoot, "Artifacts/ghosttea-apple-native.xcframework");
const moduleCache = join(packageRoot, ".build/module-cache");
const developerDir = process.env.DEVELOPER_DIR ?? "/Applications/Xcode.app/Contents/Developer";

if (process.platform !== "darwin" || process.arch !== "arm64") {
  throw new Error("The Swift TRF1 mutation gate requires Apple Silicon macOS.");
}
if (!existsSync(artifact)) {
  throw new Error("The combined Apple artifact is missing. Run `npm run test:ios:harness` first.");
}

mkdirSync(moduleCache, { recursive: true });
const result = spawnSync("swift", ["test", "--disable-sandbox", "--filter", "deterministicTRF1DecoderFuzzSmoke"], {
  cwd: packageRoot,
  env: {
    ...process.env,
    CLANG_MODULE_CACHE_PATH: moduleCache,
    DEVELOPER_DIR: developerDir,
    SWIFTPM_MODULECACHE_OVERRIDE: moduleCache,
  },
  stdio: "inherit",
});
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);

console.log("Swift TRF1 deterministic mutation fuzz smoke passed (4,096 envelopes and section payloads).");
