import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const artifact = join(root, "apple/GhostteaKit/Artifacts/ghosttea-font-fixture.xcframework");
const headers = join(root, "native/ghosttea/crates/ghosttea-font-fixture-ffi/include");
const developerDir = process.env.DEVELOPER_DIR ?? "/Applications/Xcode.app/Contents/Developer";
const environment = {
  ...process.env,
  DEVELOPER_DIR: developerDir,
  IPHONEOS_DEPLOYMENT_TARGET: "17.0",
  MACOSX_DEPLOYMENT_TARGET: "14.0",
};

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    env: environment,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

if (process.platform !== "darwin" || process.arch !== "arm64") {
  throw new Error("Building the font fixture XCFramework requires Apple Silicon macOS.");
}
if (!existsSync(join(developerDir, "usr/bin/xcodebuild"))) {
  throw new Error(`Full Xcode is required at ${developerDir}.`);
}

run(process.execPath, [join(root, "scripts/sync-ghosttea-fonts.mjs")]);

const targets = ["aarch64-apple-darwin", "aarch64-apple-ios", "aarch64-apple-ios-sim"];
for (const target of targets) {
  run("cargo", ["build", "-p", "ghosttea-font-fixture-ffi", "--release", "--target", target]);
}

const staging = join(root, "native/build/ghosttea-font-fixture-apple");
rmSync(staging, { recursive: true, force: true });
rmSync(artifact, { recursive: true, force: true });
mkdirSync(staging, { recursive: true });

const libraries = targets.map((target) => {
  const directory = join(staging, target);
  const stagedHeaders = join(directory, "Headers");
  const library = join(root, "target", target, "release", "libghosttea_font_fixture_ffi.a");
  if (!existsSync(library)) throw new Error(`Missing Rust static library ${library}.`);
  mkdirSync(directory, { recursive: true });
  cpSync(headers, stagedHeaders, { recursive: true });
  return { library, headers: stagedHeaders };
});

const xcframeworkArguments = ["-create-xcframework"];
for (const slice of libraries) {
  xcframeworkArguments.push("-library", slice.library, "-headers", slice.headers);
}
xcframeworkArguments.push("-output", artifact);
run("xcodebuild", xcframeworkArguments);

console.log(`Built ${artifact}`);
