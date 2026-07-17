import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const artifact = join(root, "apple/GhostteaKit/Artifacts/ghosttea-libssh2-candidate.xcframework/macos-arm64");
const source = join(root, "tests/fixtures/ssh/libssh2_candidate_probe.c");
const outputDirectory = join(root, "native/build/ssh-fixture");
const output = join(outputDirectory, "libssh2-candidate-probe");
const developerDir = process.env.DEVELOPER_DIR ?? "/Applications/Xcode.app/Contents/Developer";
const commandEnvironment = { ...process.env, DEVELOPER_DIR: developerDir };

if (process.platform !== "darwin" || process.arch !== "arm64") {
  throw new Error("The libssh2 fixture probe currently requires Apple Silicon macOS.");
}
if (!existsSync(artifact)) {
  throw new Error("The SSH candidate artifact is missing. Run `npm run build:ssh:apple` first.");
}

mkdirSync(outputDirectory, { recursive: true });
const result = spawnSync(
  "xcrun",
  [
    "clang",
    "-std=c11",
    "-Wall",
    "-Wextra",
    "-Werror",
    "-Wpedantic",
    "-mmacosx-version-min=14.0",
    "-I",
    join(artifact, "Headers"),
    "-I",
    join(artifact, "Headers", "LibSSH2Candidate"),
    source,
    join(artifact, "libghosttea-libssh2-candidate.a"),
    "-o",
    output,
  ],
  { cwd: root, env: commandEnvironment, encoding: "utf8" },
);
if (result.error) throw result.error;
if (result.status !== 0) throw new Error(result.stderr || "Failed to compile libssh2 fixture probe.");

console.log(`Built ${output}`);
