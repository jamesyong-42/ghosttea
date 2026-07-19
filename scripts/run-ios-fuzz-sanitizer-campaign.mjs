import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const argument = (name) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};
const release = process.argv.includes("--release");
const durationSeconds = Number(argument("--duration-seconds") ?? (release ? 3600 : 1));
const timeoutSeconds = Number(argument("--iteration-timeout-seconds") ?? 900);
const output = resolve(root, argument("--output") ?? "native/build/ios-fuzz-campaign/evidence.json");
const developerDir = process.env.DEVELOPER_DIR ?? "/Applications/Xcode.app/Contents/Developer";

if (process.platform !== "darwin" || process.arch !== "arm64") {
  throw new Error("The sanitizer campaign requires Apple Silicon macOS.");
}
if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
  throw new Error("--duration-seconds must be positive.");
}
if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
  throw new Error("--iteration-timeout-seconds must be positive.");
}
if (release && durationSeconds < 3600) {
  throw new Error("Release campaigns require at least 3,600 seconds per boundary.");
}

function commandOutput(program, args) {
  const result = spawnSync(program, args, {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, DEVELOPER_DIR: developerDir },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${program} failed: ${result.stderr.trim()}`);
  return result.stdout.trim();
}

if (release) {
  const status = commandOutput("git", ["status", "--porcelain", "--untracked-files=no"]);
  if (status !== "") throw new Error("Release campaigns require a clean tracked worktree.");
  const toolchain = spawnSync(process.execPath, [join(root, "scripts/check-ios-release-toolchain.mjs")], {
    cwd: root,
    env: { ...process.env, DEVELOPER_DIR: developerDir },
    stdio: "inherit",
  });
  if (toolchain.error) throw toolchain.error;
  if (toolchain.status !== 0) process.exit(toolchain.status ?? 1);
}

const corpusPaths = [
  "native/ghostty.lock.json",
  "Cargo.lock",
  "native/terminald/crates/ghosttea-ffi/include/ghosttea.h",
  "native/terminald/crates/ghosttea-ffi/src/lib.rs",
  "apple/GhostteaKit/Sources/GhostteaFrame/TRF1Decoder.swift",
  "apple/GhostteaKit/Tests/GhostteaFrameTests/TRF1DecoderTests.swift",
  "apple/GhostteaKit/Tools/GhostteaTRF1FuzzProbe/main.swift",
];
for (const path of corpusPaths) {
  if (!existsSync(join(root, path))) throw new Error(`Missing campaign input: ${path}`);
}
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const corpus = corpusPaths.map((path) => ({ path, sha256: sha256(readFileSync(join(root, path))) }));
const corpusHash = sha256(Buffer.from(corpus.map(({ path, sha256 }) => `${path}\0${sha256}\n`).join("")));
const baseEvidence = {
  schemaVersion: 1,
  sourceRevision: commandOutput("git", ["rev-parse", "HEAD"]),
  toolchain: {
    xcode: commandOutput("xcodebuild", ["-version"]).replaceAll("\n", " | "),
    rustc: commandOutput("rustc", ["--version"]),
    swift: commandOutput("swift", ["--version"]).replaceAll("\n", " | "),
  },
  sanitizer: "address",
  seed: { ffi: "0x4754454146464931", trf1: "0x5452463146555a5a" },
  corpusHash,
  corpus,
  requestedDurationSecondsPerBoundary: durationSeconds,
  iterationTimeoutSeconds: timeoutSeconds,
};
function writeEvidence(evidence) {
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(evidence, null, 2)}\n`);
}

const buildRoot = join(root, "native/build/ios-fuzz-campaign");
mkdirSync(buildRoot, { recursive: true });
const commonEnvironment = {
  ...process.env,
  ASAN_OPTIONS: "abort_on_error=1:detect_leaks=0:halt_on_error=1:strict_string_checks=1",
  DEVELOPER_DIR: developerDir,
};

function timedRun(boundary, program, args, environment) {
  const started = Date.now();
  const result = spawnSync("/usr/bin/time", ["-l", program, ...args], {
    cwd: boundary === "trf1" ? join(root, "apple/GhostteaKit") : root,
    env: { ...commonEnvironment, ...environment },
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: timeoutSeconds * 1000,
  });
  const elapsedMilliseconds = Date.now() - started;
  const combined = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  const residentMatch = combined.match(/(\d+)\s+maximum resident set size/);
  if (result.error || result.status !== 0) {
    process.stderr.write(combined);
    if (result.error) throw result.error;
    throw new Error(`${boundary} sanitizer iteration failed with status ${result.status}`);
  }
  return {
    elapsedMilliseconds,
    peakResidentBytes: residentMatch ? Number(residentMatch[1]) : null,
  };
}

function campaign(boundary, operationCount, run) {
  const started = Date.now();
  let iterations = 0;
  let peakResidentBytes = 0;
  do {
    const measurement = run();
    iterations += 1;
    peakResidentBytes = Math.max(peakResidentBytes, measurement.peakResidentBytes ?? 0);
    process.stdout.write(`${boundary} sanitizer iteration ${iterations} passed\n`);
  } while (Date.now() - started < durationSeconds * 1000);
  return {
    boundary,
    iterations,
    executions: iterations * operationCount,
    elapsedMilliseconds: Date.now() - started,
    peakResidentBytes: peakResidentBytes || null,
    crashCount: 0,
    hangCount: 0,
    sanitizerFindingCount: 0,
  };
}

const trf1Probe = join(buildRoot, release ? "trf1-fuzz-release" : "trf1-fuzz-debug");
const trf1Build = spawnSync(
  "swiftc",
  [
    "-sanitize=address",
    "-O",
    ...(!release ? ["-g"] : []),
    join(root, "apple/GhostteaKit/Sources/GhostteaFrame/TRF1Decoder.swift"),
    join(root, "apple/GhostteaKit/Tools/GhostteaTRF1FuzzProbe/main.swift"),
    "-o",
    trf1Probe,
  ],
  { cwd: root, env: commonEnvironment, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
);
if (trf1Build.error) throw trf1Build.error;
if (trf1Build.status !== 0) {
  process.stderr.write(`${trf1Build.stdout ?? ""}\n${trf1Build.stderr ?? ""}`);
  throw new Error(`TRF1 sanitizer probe build failed with status ${trf1Build.status}`);
}
const swiftRuntimePreflight = spawnSync(trf1Probe, [], {
  cwd: root,
  env: { ...commonEnvironment, GHOSTTEA_FUZZ_ITERATIONS: "0" },
  encoding: "utf8",
  timeout: 15_000,
});
if (swiftRuntimePreflight.error?.code === "ETIMEDOUT") {
  const blocker = "Swift AddressSanitizer runtime preflight timed out before main; TRF1 ASan coverage is unavailable";
  writeEvidence({
    ...baseEvidence,
    status: "blocked",
    releaseEligible: false,
    boundaries: [
      {
        boundary: "trf1",
        status: "runtime-preflight-timeout",
        iterations: 0,
        executions: 0,
      },
    ],
    blockers: [blocker],
  });
  throw new Error(`${blocker}; evidence written to ${output}`);
}
if (swiftRuntimePreflight.error) throw swiftRuntimePreflight.error;
if (swiftRuntimePreflight.status !== 0) {
  process.stderr.write(`${swiftRuntimePreflight.stdout ?? ""}\n${swiftRuntimePreflight.stderr ?? ""}`);
  throw new Error(`Swift AddressSanitizer runtime preflight failed with status ${swiftRuntimePreflight.status}`);
}

const profileArguments = release ? ["--release"] : [];
const ffi = campaign("ffi", 256, () =>
  timedRun(
    "ffi",
    "cargo",
    [
      "test",
      "-p",
      "ghosttea-ffi",
      "--target",
      "aarch64-apple-darwin",
      ...profileArguments,
      "deterministic_ffi_state_machine_fuzz_smoke",
    ],
    {
      CARGO_TARGET_DIR: join(buildRoot, release ? "ffi-release" : "ffi-debug"),
      RUSTC_BOOTSTRAP: "1",
      RUSTFLAGS: "-Zsanitizer=address",
    },
  ),
);
const ffiTargetDirectory = join(buildRoot, release ? "ffi-release" : "ffi-debug");
const ffiClean = spawnSync("cargo", ["clean", "--target-dir", ffiTargetDirectory], {
  cwd: root,
  encoding: "utf8",
});
if (ffiClean.error) throw ffiClean.error;
if (ffiClean.status !== 0) {
  throw new Error(`Could not clean isolated FFI target: ${ffiClean.stderr.trim()}`);
}
const trf1 = campaign("trf1", 8192, () => timedRun("trf1", trf1Probe, [], {}));

const evidence = {
  ...baseEvidence,
  status: "passed",
  releaseEligible: release,
  boundaries: [ffi, trf1],
  blockers: release ? [] : ["development-duration campaign; rerun --release for at least one hour per boundary"],
};
writeEvidence(evidence);
console.log(`Sanitizer campaign passed; evidence written to ${output}`);
