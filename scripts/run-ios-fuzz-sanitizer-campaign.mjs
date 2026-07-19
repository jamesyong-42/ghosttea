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
const preflightTimeoutMs = Number(argument("--preflight-timeout-ms") ?? 15_000);
const output = resolve(root, argument("--output") ?? "native/build/ios-fuzz-campaign/evidence.json");
const developerDir = process.env.DEVELOPER_DIR ?? "/Applications/Xcode.app/Contents/Developer";
const xcodeToolchainBin = join(
  developerDir,
  "Toolchains/XcodeDefault.xctoolchain/usr/bin",
);
const lockedSwiftc = join(xcodeToolchainBin, "swiftc");
const lockedClang = join(xcodeToolchainBin, "clang");

/** Apple radar for ASan/TSan hang on macOS 26.4+ with Xcode ≤26.3. */
const APPLE_ASAN_HANG_RADAR = "171762808";
const APPLE_ASAN_HANG_MIN_MACOS = [26, 4];
const APPLE_ASAN_HANG_FIXED_XCODE = [26, 4];

if (process.platform !== "darwin" || process.arch !== "arm64") {
  throw new Error("The sanitizer campaign requires Apple Silicon macOS.");
}
if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
  throw new Error("--duration-seconds must be positive.");
}
if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
  throw new Error("--iteration-timeout-seconds must be positive.");
}
if (!Number.isFinite(preflightTimeoutMs) || preflightTimeoutMs < 1000) {
  throw new Error("--preflight-timeout-ms must be at least 1000.");
}
if (release && durationSeconds < 3600) {
  throw new Error("Release campaigns require at least 3,600 seconds per boundary.");
}
if (!existsSync(lockedSwiftc) || !existsSync(lockedClang)) {
  throw new Error(
    `Locked Xcode toolchain tools missing under ${xcodeToolchainBin}. Set DEVELOPER_DIR to the reviewed Xcode.`,
  );
}

function commandOutput(program, args, environment = {}) {
  const result = spawnSync(program, args, {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, DEVELOPER_DIR: developerDir, ...environment },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${program} failed: ${(result.stderr || result.stdout || "").trim()}`);
  }
  return result.stdout.trim();
}

function parseDottedVersion(text) {
  const match = String(text).match(/(\d+)\.(\d+)(?:\.(\d+))?/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)];
}

function versionAtLeast(version, minimum) {
  if (!version) return false;
  for (let index = 0; index < minimum.length; index += 1) {
    const left = version[index] ?? 0;
    const right = minimum[index] ?? 0;
    if (left > right) return true;
    if (left < right) return false;
  }
  return true;
}

function versionLessThan(version, exclusiveUpper) {
  if (!version) return false;
  for (let index = 0; index < exclusiveUpper.length; index += 1) {
    const left = version[index] ?? 0;
    const right = exclusiveUpper[index] ?? 0;
    if (left < right) return true;
    if (left > right) return false;
  }
  return false;
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

const macSdk = commandOutput("xcrun", ["--sdk", "macosx", "--show-sdk-path"]);
const hostMacos = commandOutput("sw_vers", ["-productVersion"]);
const hostMacosBuild = commandOutput("sw_vers", ["-buildVersion"]);
const xcodeVersionText = commandOutput("xcodebuild", ["-version"]).replaceAll("\n", " | ");
const rustcVersion = commandOutput("rustc", ["--version"]);
const lockedSwiftVersion = commandOutput(lockedSwiftc, ["--version"]).replaceAll("\n", " | ");
const hostMacosVersion = parseDottedVersion(hostMacos);
const lockedXcodeVersion = parseDottedVersion(xcodeVersionText);
const hostMatchesAppleAsanHang =
  versionAtLeast(hostMacosVersion, APPLE_ASAN_HANG_MIN_MACOS) &&
  versionLessThan(lockedXcodeVersion, APPLE_ASAN_HANG_FIXED_XCODE);

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
  schemaVersion: 2,
  sourceRevision: commandOutput("git", ["rev-parse", "HEAD"]),
  host: {
    platform: process.platform,
    arch: process.arch,
    macos: hostMacos,
    macosBuild: hostMacosBuild,
  },
  toolchain: {
    developerDirectory: developerDir,
    macSdk,
    xcode: xcodeVersionText,
    rustc: rustcVersion,
    swift: lockedSwiftVersion,
    swiftcPath: lockedSwiftc,
    clangPath: lockedClang,
  },
  sanitizer: "address",
  seed: { ffi: "0x4754454146464931", trf1: "0x5452463146555a5a" },
  corpusHash,
  corpus,
  requestedDurationSecondsPerBoundary: durationSeconds,
  iterationTimeoutSeconds: timeoutSeconds,
  preflightTimeoutMilliseconds: preflightTimeoutMs,
  knownIssues: {
    appleAsanHangRadar: APPLE_ASAN_HANG_RADAR,
    hostMatchesAppleAsanHangAdvisory: hostMatchesAppleAsanHang,
    advisory:
      "Address Sanitizer and Thread Sanitizer might hang on macOS 26.4+ when building with Xcode 26.3 or older. Workaround: Xcode 26.4+.",
  },
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
  // Keep the reviewed macOS SDK visible to cc-rs/cargo without rewriting PATH
  // (PATH may still point at Command Line Tools; Apple tools are invoked by
  // absolute locked paths below).
  SDKROOT: macSdk,
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
    status: "passed",
    iterations,
    executions: iterations * operationCount,
    elapsedMilliseconds: Date.now() - started,
    peakResidentBytes: peakResidentBytes || null,
    crashCount: 0,
    hangCount: 0,
    sanitizerFindingCount: 0,
  };
}

function classifyAppleAsanHang({ timedOut, stderr }) {
  const text = stderr ?? "";
  const shadowSignature =
    text.includes("FindDynamicShadowStart") ||
    text.includes("InitializeShadowMemory") ||
    text.includes("AddressSanitizer: libc interceptors initialized");
  if (!timedOut) return null;
  if (hostMatchesAppleAsanHang || shadowSignature) {
    return {
      code: "apple-radar-171762808",
      radar: APPLE_ASAN_HANG_RADAR,
      message:
        `Apple AddressSanitizer runtime hung during shadow initialization on macOS ${hostMacos} with ${xcodeVersionText}. ` +
        `This matches Apple radar ${APPLE_ASAN_HANG_RADAR} (ASan/TSan hang on macOS 26.4+ with Xcode ≤26.3). ` +
        `Unblock by reviewing and locking Xcode ${APPLE_ASAN_HANG_FIXED_XCODE.join(".")}+ on this host, then re-running the campaign.`,
      shadowSignature,
      hostMatchesAdvisory: hostMatchesAppleAsanHang,
    };
  }
  return {
    code: "swift-asan-runtime-preflight-timeout",
    radar: null,
    message:
      "Swift AddressSanitizer runtime preflight timed out before main; TRF1 ASan coverage is unavailable.",
    shadowSignature,
    hostMatchesAdvisory: false,
  };
}

function runProcess(program, args, { env = {}, timeoutMs, cwd = root } = {}) {
  const started = Date.now();
  const result = spawnSync(program, args, {
    cwd,
    env: { ...commonEnvironment, ...env },
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    timeout: timeoutMs,
  });
  return {
    ...result,
    elapsedMilliseconds: Date.now() - started,
    timedOut: result.error?.code === "ETIMEDOUT",
  };
}

// Cheap Apple-clang ASan capability probe (independent of TRF1).
const clangSmokeSource = join(buildRoot, "asan-clang-smoke.c");
const clangSmokeBinary = join(buildRoot, "asan-clang-smoke");
writeFileSync(clangSmokeSource, 'int main(void){return 0;}\n');
const clangBuild = runProcess(
  lockedClang,
  ["-isysroot", macSdk, "-fsanitize=address", "-O1", clangSmokeSource, "-o", clangSmokeBinary],
  { timeoutMs: 60_000 },
);
if (clangBuild.error && !clangBuild.timedOut) throw clangBuild.error;
if (clangBuild.status !== 0) {
  process.stderr.write(`${clangBuild.stdout ?? ""}\n${clangBuild.stderr ?? ""}`);
  throw new Error(`Apple clang ASan smoke build failed with status ${clangBuild.status}`);
}
const clangPreflight = runProcess(clangSmokeBinary, [], { timeoutMs: preflightTimeoutMs });
const appleAsanRuntime = {
  status: clangPreflight.timedOut
    ? "runtime-preflight-timeout"
    : clangPreflight.status === 0
      ? "passed"
      : "failed",
  elapsedMilliseconds: clangPreflight.elapsedMilliseconds,
  exitStatus: clangPreflight.status,
  stderrTail: `${clangPreflight.stderr ?? ""}`.trim().split("\n").slice(-8),
  hang: classifyAppleAsanHang({
    timedOut: clangPreflight.timedOut,
    stderr: clangPreflight.stderr,
  }),
};
if (clangPreflight.timedOut) {
  process.stdout.write(
    `Apple clang ASan runtime preflight timed out after ${preflightTimeoutMs}ms (radar ${APPLE_ASAN_HANG_RADAR} likely)\n`,
  );
} else if (clangPreflight.status !== 0) {
  process.stderr.write(`${clangPreflight.stdout ?? ""}\n${clangPreflight.stderr ?? ""}`);
  throw new Error(`Apple clang ASan runtime preflight failed with status ${clangPreflight.status}`);
}

// Always collect the Rust FFI boundary first so Swift runtime gaps still leave
// partial, honest evidence.
const profileArguments = release ? ["--release"] : [];
const ffiTargetDirectory = join(buildRoot, release ? "ffi-release" : "ffi-debug");
let ffi;
let ffiError = null;
try {
  ffi = campaign("ffi", 256, () =>
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
        CARGO_TARGET_DIR: ffiTargetDirectory,
        RUSTC_BOOTSTRAP: "1",
        RUSTFLAGS: "-Zsanitizer=address",
      },
    ),
  );
} catch (error) {
  ffiError = error;
  ffi = {
    boundary: "ffi",
    status: "failed",
    iterations: 0,
    executions: 0,
    error: String(error?.message ?? error),
  };
}
const ffiClean = spawnSync("cargo", ["clean", "--target-dir", ffiTargetDirectory], {
  cwd: root,
  encoding: "utf8",
});
if (ffiClean.error) throw ffiClean.error;
if (ffiClean.status !== 0) {
  throw new Error(`Could not clean isolated FFI target: ${ffiClean.stderr.trim()}`);
}

const trf1Probe = join(buildRoot, release ? "trf1-fuzz-release" : "trf1-fuzz-debug");
const trf1Build = runProcess(
  lockedSwiftc,
  [
    "-sdk",
    macSdk,
    "-sanitize=address",
    "-O",
    ...(!release ? ["-g"] : []),
    join(root, "apple/GhostteaKit/Sources/GhostteaFrame/TRF1Decoder.swift"),
    join(root, "apple/GhostteaKit/Tools/GhostteaTRF1FuzzProbe/main.swift"),
    "-o",
    trf1Probe,
  ],
  { timeoutMs: 180_000 },
);
if (trf1Build.error && !trf1Build.timedOut) throw trf1Build.error;
if (trf1Build.status !== 0) {
  process.stderr.write(`${trf1Build.stdout ?? ""}\n${trf1Build.stderr ?? ""}`);
  throw new Error(`TRF1 sanitizer probe build failed with status ${trf1Build.status}`);
}

const swiftRuntimePreflight = runProcess(trf1Probe, [], {
  env: { GHOSTTEA_FUZZ_ITERATIONS: "0" },
  timeoutMs: preflightTimeoutMs,
});
const swiftHang = classifyAppleAsanHang({
  timedOut: swiftRuntimePreflight.timedOut,
  stderr: swiftRuntimePreflight.stderr,
});

if (swiftRuntimePreflight.timedOut || appleAsanRuntime.status === "runtime-preflight-timeout") {
  const hang = swiftHang ?? appleAsanRuntime.hang;
  const blocker =
    hang?.message ??
    "Swift AddressSanitizer runtime preflight timed out before main; TRF1 ASan coverage is unavailable";
  const evidence = {
    ...baseEvidence,
    status: "blocked",
    releaseEligible: false,
    appleAsanRuntime,
    boundaries: [
      ffi,
      {
        boundary: "trf1",
        status: "runtime-preflight-timeout",
        iterations: 0,
        executions: 0,
        elapsedMilliseconds: swiftRuntimePreflight.elapsedMilliseconds,
        hang,
      },
    ],
    blockers: [blocker],
  };
  writeEvidence(evidence);
  if (ffiError) {
    throw new Error(
      `${blocker}; FFI boundary also failed (${ffiError.message}); evidence written to ${output}`,
    );
  }
  throw new Error(`${blocker}; evidence written to ${output}`);
}
if (swiftRuntimePreflight.error) throw swiftRuntimePreflight.error;
if (swiftRuntimePreflight.status !== 0) {
  process.stderr.write(`${swiftRuntimePreflight.stdout ?? ""}\n${swiftRuntimePreflight.stderr ?? ""}`);
  throw new Error(
    `Swift AddressSanitizer runtime preflight failed with status ${swiftRuntimePreflight.status}`,
  );
}
if (ffiError) throw ffiError;

const trf1 = campaign("trf1", 8192, () => timedRun("trf1", trf1Probe, [], {}));

const evidence = {
  ...baseEvidence,
  status: "passed",
  releaseEligible: release,
  appleAsanRuntime,
  boundaries: [ffi, trf1],
  blockers: release ? [] : ["development-duration campaign; rerun --release for at least one hour per boundary"],
};
writeEvidence(evidence);
console.log(`Sanitizer campaign passed; evidence written to ${output}`);
