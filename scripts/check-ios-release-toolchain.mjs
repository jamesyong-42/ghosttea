import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const lock = JSON.parse(readFileSync(resolve(root, "apple/GhostteaKit/Compatibility/ios-toolchain.lock.json"), "utf8"));
const developerDirectory = process.env.DEVELOPER_DIR ?? "/Applications/Xcode.app/Contents/Developer";
const environment = { ...process.env, DEVELOPER_DIR: developerDirectory };

const xcode = execute("xcodebuild", ["-version"]);
const swift = execute("xcrun", ["swift", "--version"]);
const clang = execute("xcrun", ["clang", "--version"]);
const rust = execute("rustc", ["--version", "--verbose"]);
const cargo = execute("cargo", ["--version"]);

requireMatch(xcode, `Xcode ${lock.apple.xcodeVersion}`, "Xcode version");
requireMatch(xcode, `Build version ${lock.apple.xcodeBuild}`, "Xcode build");
requireMatch(swift, `Apple Swift version ${lock.apple.swiftVersion}`, "Swift version");
requireMatch(swift, lock.apple.swiftCompilerBuild, "Swift compiler build");
requireMatch(clang, `Apple clang version ${lock.apple.clangVersion}`, "Clang version");
requireMatch(clang, lock.apple.clangBuild, "Clang build");
requireMatch(rust, `release: ${lock.rust.release}`, "rustc release");
requireMatch(rust, `commit-hash: ${lock.rust.commitHash}`, "rustc commit");
requireMatch(rust, `LLVM version: ${lock.rust.llvmVersion}`, "Rust LLVM version");
requireMatch(cargo, `cargo ${lock.rust.cargoVersion}`, "Cargo version");
requireMatch(cargo, lock.rust.cargoCommit, "Cargo commit");

console.log(
  `Verified iOS release toolchain: Xcode ${lock.apple.xcodeVersion} (${lock.apple.xcodeBuild}), Swift ${lock.apple.swiftVersion}, Rust ${lock.rust.release}`,
);

function execute(program, args) {
  const result = spawnSync(program, args, {
    cwd: root,
    env: environment,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${program} ${args.join(" ")} failed with status ${result.status}\n${result.stdout}${result.stderr}`,
    );
  }
  return `${result.stdout}${result.stderr}`;
}

function requireMatch(output, expected, description) {
  if (!output.includes(expected)) {
    throw new Error(`${description} drifted; expected ${JSON.stringify(expected)} in:\n${output}`);
  }
}
