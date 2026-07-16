import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const lock = JSON.parse(readFileSync(join(root, "native/ssh.lock.json"), "utf8"));
const opensslSource = join(root, "native/vendor/openssl");
const libssh2Source = join(root, "native/vendor/libssh2");
const output = join(root, "native/build/ssh-apple");
const artifact = join(output, "ghosttea-libssh2-candidate.xcframework");
const packageArtifact = join(root, "apple/GhostteaKit/Artifacts/ghosttea-libssh2-candidate.xcframework");
const developerDir = process.env.DEVELOPER_DIR ?? "/Applications/Xcode.app/Contents/Developer";
const commandEnvironment = { ...process.env, DEVELOPER_DIR: developerDir };
const jobs = String(Math.max(1, availableParallelism()));
const resume = process.argv.includes("--resume");

function capture(command, args, cwd = root, env = commandEnvironment) {
  const result = spawnSync(command, args, { cwd, env, encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr || `${command} failed`);
  return result.stdout.trim();
}

function run(command, args, cwd = root, env = commandEnvironment) {
  const result = spawnSync(command, args, { cwd, env, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function directorySize(path) {
  return readdirSync(path, { withFileTypes: true }).reduce((total, entry) => {
    const child = join(path, entry.name);
    return total + (entry.isDirectory() ? directorySize(child) : statSync(child).size);
  }, 0);
}

function verifySource(name, path, specification) {
  if (!existsSync(join(path, ".git"))) {
    throw new Error(`${name} source is missing. Run \`npm run bootstrap:ssh:apple\` first.`);
  }
  if (capture("git", ["rev-parse", "HEAD"], path) !== specification.commit) {
    throw new Error(`${name} source is not at locked commit ${specification.commit}`);
  }
  if (capture("git", ["status", "--porcelain"], path) !== "") {
    throw new Error(`${name} source has local changes.`);
  }
}

function buildOpenSSL(slice) {
  const build = join(output, `openssl-${slice.name}`);
  const install = join(output, `install-openssl-${slice.name}`);
  mkdirSync(build, { recursive: true });
  const env = { ...commandEnvironment, ...slice.environment };
  run(
    join(opensslSource, "Configure"),
    [
      slice.opensslTarget,
      `--prefix=${install}`,
      `--openssldir=${join(install, "ssl")}`,
      "no-shared",
      "no-tests",
      "no-apps",
      "no-docs",
      slice.deploymentFlag,
    ],
    build,
    env,
  );
  run("make", ["-j", jobs], build, env);
  run("make", ["install_sw"], build, env);
  return install;
}

function buildLibssh2(slice, opensslInstall) {
  const build = join(output, `libssh2-${slice.name}`);
  const install = join(output, `install-libssh2-${slice.name}`);
  const args = [
    "-S",
    libssh2Source,
    "-B",
    build,
    "-G",
    "Unix Makefiles",
    `-DCMAKE_BUILD_TYPE=Release`,
    `-DCMAKE_OSX_ARCHITECTURES=arm64`,
    `-DCMAKE_OSX_DEPLOYMENT_TARGET=${slice.minimumVersion}`,
    `-DCMAKE_OSX_SYSROOT=${slice.sdk}`,
    `-DCMAKE_INSTALL_PREFIX=${install}`,
    `-DOPENSSL_ROOT_DIR=${opensslInstall}`,
    `-DOPENSSL_CRYPTO_LIBRARY=${join(opensslInstall, "lib/libcrypto.a")}`,
    `-DOPENSSL_INCLUDE_DIR=${join(opensslInstall, "include")}`,
    `-DOPENSSL_USE_STATIC_LIBS=TRUE`,
    `-DCMAKE_EXPORT_NO_PACKAGE_REGISTRY=ON`,
    `-DCMAKE_FIND_USE_PACKAGE_REGISTRY=FALSE`,
    `-DCRYPTO_BACKEND=OpenSSL`,
    `-DCMAKE_DISABLE_FIND_PACKAGE_ZLIB=TRUE`,
    `-DBUILD_SHARED_LIBS=OFF`,
    `-DBUILD_STATIC_LIBS=ON`,
    `-DBUILD_EXAMPLES=OFF`,
    `-DBUILD_TESTING=OFF`,
  ];
  if (slice.systemName) args.push(`-DCMAKE_SYSTEM_NAME=${slice.systemName}`);
  run("cmake", args);
  run("cmake", ["--build", build, "--parallel", jobs]);
  run("cmake", ["--install", build]);
  return install;
}

function combineSlice(slice, opensslInstall, libssh2Install) {
  const destination = join(output, `combined-${slice.name}`);
  mkdirSync(destination, { recursive: true });
  const library = join(destination, "libghosttea-libssh2-candidate.a");
  run("xcrun", [
    "libtool",
    "-static",
    "-o",
    library,
    join(libssh2Install, "lib/libssh2.a"),
    join(opensslInstall, "lib/libcrypto.a"),
  ]);
  return library;
}

if (process.platform !== "darwin" || process.arch !== lock.appleBuilder.architecture) {
  throw new Error(`The SSH candidate build requires macOS ${lock.appleBuilder.architecture}.`);
}
verifySource("OpenSSL", opensslSource, lock.openssl);
verifySource("libssh2", libssh2Source, lock.libssh2);
if (!resume) rmSync(output, { recursive: true, force: true });
mkdirSync(output, { recursive: true });

const iphoneosSdk = capture("xcrun", ["--sdk", "iphoneos", "--show-sdk-path"]);
const simulatorSdk = capture("xcrun", ["--sdk", "iphonesimulator", "--show-sdk-path"]);
const macosSdk = capture("xcrun", ["--sdk", "macosx", "--show-sdk-path"]);
const iphoneosPlatform = capture("xcrun", ["--sdk", "iphoneos", "--show-sdk-platform-path"]);
const simulatorPlatform = capture("xcrun", ["--sdk", "iphonesimulator", "--show-sdk-platform-path"]);
const slices = [
  {
    name: "macos-arm64",
    opensslTarget: "darwin64-arm64-cc",
    deploymentFlag: `-mmacosx-version-min=${lock.appleBuilder.minimumMacosVersion}`,
    minimumVersion: lock.appleBuilder.minimumMacosVersion,
    sdk: macosSdk,
    systemName: undefined,
    environment: {},
  },
  {
    name: "ios-arm64",
    opensslTarget: "ios64-xcrun",
    deploymentFlag: `-miphoneos-version-min=${lock.appleBuilder.minimumIosVersion}`,
    minimumVersion: lock.appleBuilder.minimumIosVersion,
    sdk: iphoneosSdk,
    systemName: "iOS",
    environment: { CROSS_TOP: join(iphoneosPlatform, "Developer"), CROSS_SDK: "iPhoneOS.sdk" },
  },
  {
    name: "ios-arm64-simulator",
    opensslTarget: "iossimulator-xcrun",
    deploymentFlag: `-mios-simulator-version-min=${lock.appleBuilder.minimumIosVersion}`,
    minimumVersion: lock.appleBuilder.minimumIosVersion,
    sdk: simulatorSdk,
    systemName: "iOS",
    environment: {
      CROSS_TOP: join(simulatorPlatform, "Developer"),
      CROSS_SDK: "iPhoneSimulator.sdk",
    },
  },
];

const headers = join(output, "headers");
mkdirSync(headers, { recursive: true });
cpSync(join(libssh2Source, "include/libssh2.h"), join(headers, "libssh2.h"));
cpSync(join(libssh2Source, "include/libssh2_publickey.h"), join(headers, "libssh2_publickey.h"));
cpSync(join(libssh2Source, "include/libssh2_sftp.h"), join(headers, "libssh2_sftp.h"));
writeFileSync(
  join(headers, "module.modulemap"),
  `module LibSSH2Candidate {\n  header "libssh2.h"\n  header "libssh2_publickey.h"\n  header "libssh2_sftp.h"\n  export *\n}\n`,
);

const libraries = [];
for (const slice of slices) {
  const opensslInstall = buildOpenSSL(slice);
  const libssh2Install = buildLibssh2(slice, opensslInstall);
  libraries.push(combineSlice(slice, opensslInstall, libssh2Install));
}

const xcframeworkArgs = ["-create-xcframework"];
for (const library of libraries) {
  xcframeworkArgs.push("-library", library, "-headers", headers);
}
xcframeworkArgs.push("-output", artifact);
run("xcodebuild", xcframeworkArgs);
run("node", [join(root, "scripts/validate-ssh-candidate-xcframework.mjs"), artifact]);

mkdirSync(join(root, "apple/GhostteaKit/Artifacts"), { recursive: true });
rmSync(packageArtifact, { recursive: true, force: true });
cpSync(artifact, packageArtifact, { recursive: true });
cpSync(join(opensslSource, "LICENSE.txt"), join(output, "OPENSSL-LICENSE.txt"));
cpSync(join(libssh2Source, "COPYING"), join(output, "LIBSSH2-LICENSE.txt"));

const info = JSON.parse(capture("plutil", ["-convert", "json", "-o", "-", join(artifact, "Info.plist")]));
if (info.AvailableLibraries?.length !== 3) {
  throw new Error("SSH candidate XCFramework does not contain all three Apple slices.");
}
writeFileSync(
  join(output, "build-metadata.json"),
  `${JSON.stringify(
    {
      schemaVersion: 1,
      openssl: lock.openssl,
      libssh2: lock.libssh2,
      xcodeVersion: capture("xcodebuild", ["-version"]).replaceAll("\n", " "),
      artifactSizeBytes: directorySize(artifact),
      libraries: info.AvailableLibraries,
      knownGap: lock.candidateStatus.knownGap,
    },
    null,
    2,
  )}\n`,
);

console.log(`Built SSH candidate ${artifact}`);
console.log(`Synced ${packageArtifact}`);
