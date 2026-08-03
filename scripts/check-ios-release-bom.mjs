import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const bomPath = resolve(root, "apple/GhostteaKit/Compatibility/ios-release.cdx.json");
const packageManifest = readJSON("package.json");
const ghostty = readJSON("native/ghostty.lock.json");
const ssh = readJSON("native/ssh.lock.json");
const fonts = readJSON("native/fonts.lock.json");
const truffle = readJSON("apple/GhostteaKit/Compatibility/truffle-swift.lock.json");
const rust = readJSON("apple/GhostteaKit/Compatibility/ios-rust-components.lock.json");
const toolchain = readJSON("apple/GhostteaKit/Compatibility/ios-toolchain.lock.json");
const themeCatalog = readJSON("apple/GhostteaKit/Sources/GhostteaAppearance/Resources/theme-catalog.generated.json");
const shaderCollectionRevision = "85898f08fcf4a9274e418912098e99e00a5f8350";

const sha256 = (path) =>
  createHash("sha256")
    .update(readFileSync(resolve(root, path)))
    .digest("hex");

const licenseHashes = {
  mit: sha256("native/ghosttea/LICENSE"),
  ofl: sha256("apple/GhostteaKit/Sources/GhostteaFontProof/Resources/OFL-1.1.txt"),
  fontNotices: sha256("apple/GhostteaKit/Sources/GhostteaFontProof/Resources/FONT-NOTICES.md"),
};

const component = ({ type, ref, name, version, license, purl, hashes, repository, properties = [] }) => ({
  type,
  "bom-ref": ref,
  name,
  version,
  ...(license ? { licenses: [cycloneDXLicense(license)] } : {}),
  ...(purl ? { purl } : {}),
  ...(hashes ? { hashes } : {}),
  ...(repository ? { externalReferences: [{ type: "vcs", url: repository }] } : {}),
  ...(properties.length > 0 ? { properties } : {}),
});

const appRef = `pkg:npm/ghosttea@${packageManifest.version}`;
const runtimeRef = `pkg:cargo/ghosttea-apple-ffi@${packageManifest.version}`;
const ghosttyRef = `pkg:github/ghostty-org/ghostty@${ghostty.ghostty.commit}`;
const opensslRef = `pkg:github/openssl/openssl@${ssh.openssl.commit}`;
const libssh2Ref = `pkg:github/libssh2/libssh2@${ssh.libssh2.commit}`;
// Derived from the lock rather than hardcoded: Truffle's repository moved
// orgs, and a stale owner in the purl silently misattributes the component.
const truffleRef = `pkg:github/${githubSlug(truffle.package.repository)}@${truffle.package.revision}`;
const tailscaleRef = `pkg:github/tailscale/libtailscale@${truffle.tailscaleKit.revision}`;
const themeCatalogRef = `pkg:github/mbadolato/iTerm2-Color-Schemes@${themeCatalog.revision}`;
const shaderCollectionRef = `pkg:github/0xhckr/ghostty-shaders@${shaderCollectionRevision}`;
const fontRefs = fonts.fonts.map((font) => `ghosttea:font/${font.role}@${fonts.source.commit}`);
const xcodeRef = `ghosttea:toolchain/xcode@${toolchain.apple.xcodeVersion}+${toolchain.apple.xcodeBuild}`;
const swiftRef = `ghosttea:toolchain/swift@${toolchain.apple.swiftVersion}`;
const rustcRef = `ghosttea:toolchain/rustc@${toolchain.rust.release}`;
const releaseBlockers = iosReleaseBlockers();

if (rust.schemaVersion !== 1 || rust.target !== "aarch64-apple-ios") {
  throw new Error("The iOS Rust component lock has an unsupported schema or target.");
}
if (rust.root.ref !== runtimeRef) {
  throw new Error(`The iOS Rust graph root drifted: expected ${runtimeRef}, got ${rust.root.ref}.`);
}
const actualCargoLockHash = sha256("Cargo.lock");
if (rust.cargoLockSha256 !== actualCargoLockHash) {
  throw new Error(
    "Cargo.lock changed after the iOS Rust graph was reviewed; run npm run update:ios-rust-components and review the result",
  );
}

const rustComponents = rust.components.map((entry) =>
  component({
    type: "library",
    ref: entry.ref,
    name: entry.name,
    version: entry.version,
    license: normalizeLicense(entry.license),
    purl: entry.ref,
    hashes: entry.checksum ? [{ alg: "SHA-256", content: entry.checksum }] : undefined,
    properties: [
      { name: "ghosttea:cargo-source", value: entry.source },
      { name: "ghosttea:rust-target", value: rust.target },
    ],
  }),
);

const toolchainComponents = [
  component({
    type: "application",
    ref: xcodeRef,
    name: "Xcode",
    version: `${toolchain.apple.xcodeVersion} (${toolchain.apple.xcodeBuild})`,
    properties: [
      { name: "ghosttea:developer-directory", value: toolchain.apple.developerDirectory },
      { name: "ghosttea:clang-version", value: toolchain.apple.clangVersion },
      { name: "ghosttea:clang-build", value: toolchain.apple.clangBuild },
    ],
  }),
  component({
    type: "framework",
    ref: swiftRef,
    name: "Apple Swift",
    version: toolchain.apple.swiftVersion,
    properties: [{ name: "ghosttea:compiler-build", value: toolchain.apple.swiftCompilerBuild }],
  }),
  component({
    type: "application",
    ref: rustcRef,
    name: "Rust compiler",
    version: toolchain.rust.release,
    properties: [
      { name: "ghosttea:rustc-commit", value: toolchain.rust.commitHash },
      { name: "ghosttea:cargo-version", value: toolchain.rust.cargoVersion },
      { name: "ghosttea:cargo-commit", value: toolchain.rust.cargoCommit },
      { name: "ghosttea:llvm-version", value: toolchain.rust.llvmVersion },
      ...toolchain.targets.map((value) => ({ name: "ghosttea:apple-target", value })),
    ],
  }),
];

const expected = {
  $schema: "https://cyclonedx.org/schema/bom-1.6.schema.json",
  bomFormat: "CycloneDX",
  specVersion: "1.6",
  serialNumber: "urn:uuid:2d610210-754c-4eed-a3c6-8f798651d2e9",
  version: 1,
  metadata: {
    timestamp: "2026-07-18T00:00:00Z",
    component: component({
      type: "application",
      ref: appRef,
      name: "Ghosttea iOS",
      version: packageManifest.version,
      license: packageManifest.license,
      purl: appRef,
      properties: [
        {
          name: "ghosttea:scope",
          value: "iOS release direct, transitive Rust, bundled, and build inputs",
        },
        { name: "ghosttea:source-lock", value: "native/ghostty.lock.json" },
        { name: "ghosttea:source-lock", value: "native/ssh.lock.json" },
        { name: "ghosttea:source-lock", value: "native/fonts.lock.json" },
        {
          name: "ghosttea:source-lock",
          value: "apple/GhostteaKit/Compatibility/truffle-swift.lock.json",
        },
        {
          name: "ghosttea:source-lock",
          value: "apple/GhostteaKit/Compatibility/ios-rust-components.lock.json",
        },
        {
          name: "ghosttea:source-lock",
          value: "apple/GhostteaKit/Compatibility/ios-toolchain.lock.json",
        },
      ],
    }),
    tools: { components: toolchainComponents },
    properties: [
      { name: "ghosttea:reproducible", value: "true" },
      { name: "ghosttea:cargo-lock:sha256", value: rust.cargoLockSha256 },
      { name: "ghosttea:rust-target", value: rust.target },
      { name: "ghosttea:license-file:MIT:sha256", value: licenseHashes.mit },
      { name: "ghosttea:license-file:OFL-1.1:sha256", value: licenseHashes.ofl },
      { name: "ghosttea:font-notices:sha256", value: licenseHashes.fontNotices },
      {
        name: "ghosttea:ssh-production-approved",
        value: String(ssh.candidateStatus.productionApproved),
      },
      {
        name: "ghosttea:ssh-security-reviewed-at",
        value: ssh.securityReview.reviewedAt,
      },
    ],
  },
  components: [
    component({
      type: "library",
      ref: runtimeRef,
      name: "ghosttea-apple-ffi",
      version: packageManifest.version,
      license: "MIT",
      purl: runtimeRef,
    }),
    component({
      type: "library",
      ref: ghosttyRef,
      name: "Ghostty VT",
      version: ghostty.ghostty.commit,
      license: "MIT",
      purl: ghosttyRef,
      repository: ghostty.ghostty.repository,
    }),
    component({
      type: "library",
      ref: opensslRef,
      name: "OpenSSL",
      version: ssh.openssl.tag,
      license: "Apache-2.0",
      purl: opensslRef,
      repository: ssh.openssl.repository,
    }),
    component({
      type: "library",
      ref: libssh2Ref,
      name: "libssh2",
      version: ssh.libssh2.tag,
      license: "BSD-3-Clause",
      purl: libssh2Ref,
      repository: ssh.libssh2.repository,
      properties: [
        {
          name: "ghosttea:production-approved",
          value: String(ssh.candidateStatus.productionApproved),
        },
        ...releaseBlockers.map((value) => ({
          name: "ghosttea:release-blocker",
          value,
        })),
        ...ssh.securityReview.requiredFixCommits.map((value) => ({
          name: "ghosttea:required-fix-commit",
          value,
        })),
      ],
    }),
    component({
      type: "library",
      ref: truffleRef,
      name: "Truffle Swift",
      version: truffle.package.revision,
      license: truffle.package.license,
      purl: truffleRef,
      repository: truffle.package.repository,
      properties: [
        { name: "ghosttea:package-path", value: truffle.package.packagePath },
        { name: "ghosttea:truffle-app-id", value: truffle.ghosttea.appId },
        {
          name: "ghosttea:production-tailscale-backend-required",
          value: String(truffle.releaseRequirements.requireProductionTailscaleBackend),
        },
      ],
    }),
    component({
      type: "library",
      ref: tailscaleRef,
      name: "TailscaleKit",
      version: truffle.tailscaleKit.revision,
      license: truffle.tailscaleKit.license,
      purl: tailscaleRef,
      hashes: [
        {
          alg: "SHA-256",
          content: truffle.tailscaleKit.artifacts.iosArm64.sha256,
        },
      ],
      repository: truffle.tailscaleKit.repository,
      properties: [
        { name: "ghosttea:minimum-ios", value: truffle.tailscaleKit.minimumIOS },
        {
          name: "ghosttea:license:sha256",
          value: truffle.tailscaleKit.licenseSha256,
        },
        ...truffle.tailscaleKit.patches.flatMap((patch) => [
          { name: "ghosttea:source-patch", value: patch.path },
          { name: "ghosttea:source-patch:sha256", value: patch.sha256 },
          { name: "ghosttea:source-patch:purpose", value: patch.purpose },
        ]),
        {
          name: "ghosttea:ios-device-artifact",
          value: truffle.tailscaleKit.artifacts.iosArm64.path,
        },
        {
          name: "ghosttea:ios-simulator-artifact",
          value: truffle.tailscaleKit.artifacts.iosSimulatorUniversal.path,
        },
        {
          name: "ghosttea:ios-simulator-artifact:sha256",
          value: truffle.tailscaleKit.artifacts.iosSimulatorUniversal.sha256,
        },
      ],
    }),
    component({
      type: "library",
      ref: themeCatalogRef,
      name: "Ghostty color-theme catalog",
      version: themeCatalog.revision,
      license: "MIT",
      purl: themeCatalogRef,
      repository: "https://github.com/mbadolato/iTerm2-Color-Schemes",
      properties: [
        { name: "ghosttea:theme-count", value: String(themeCatalog.themes.length) },
        {
          name: "ghosttea:license-note",
          value: "The collection is MIT; individual themes retain their authors' terms.",
        },
      ],
    }),
    component({
      type: "library",
      ref: shaderCollectionRef,
      name: "Ghostty shader adaptations",
      version: shaderCollectionRevision,
      license: "Unlicense AND MIT AND CC-BY-3.0 AND CC-BY-NC-SA-3.0",
      purl: shaderCollectionRef,
      repository: "https://github.com/0xhckr/ghostty-shaders",
      properties: [
        { name: "ghosttea:bundled-port", value: "better-crt" },
        { name: "ghosttea:bundled-port", value: "crt" },
        { name: "ghosttea:bundled-port", value: "sparks-from-fire" },
        { name: "ghosttea:bundled-port", value: "vhs" },
      ],
    }),
    ...rustComponents,
    ...fonts.fonts.map((font, index) =>
      component({
        type: "file",
        ref: fontRefs[index],
        name: font.path.split("/").at(-1),
        version: fonts.source.commit,
        license: fonts.license.id,
        hashes: [{ alg: "SHA-256", content: font.sha256 }],
        repository: fonts.source.repository,
        properties: [
          { name: "ghosttea:font-role", value: font.role },
          { name: "ghosttea:source-path", value: font.path },
        ],
      }),
    ),
  ],
  dependencies: [
    {
      ref: appRef,
      dependsOn: [runtimeRef, opensslRef, libssh2Ref, truffleRef, themeCatalogRef, shaderCollectionRef, ...fontRefs],
    },
    { ref: runtimeRef, dependsOn: [...rust.root.dependencies, ghosttyRef].sort() },
    { ref: ghosttyRef, dependsOn: [] },
    { ref: opensslRef, dependsOn: [] },
    { ref: libssh2Ref, dependsOn: [opensslRef] },
    { ref: truffleRef, dependsOn: [tailscaleRef] },
    { ref: tailscaleRef, dependsOn: [] },
    { ref: themeCatalogRef, dependsOn: [] },
    { ref: shaderCollectionRef, dependsOn: [] },
    ...rust.components.map((entry) => ({ ref: entry.ref, dependsOn: entry.dependencies })),
    ...fontRefs.map((ref) => ({ ref, dependsOn: [] })),
  ],
};

validateBom(expected);

if (process.argv.includes("--print")) {
  process.stdout.write(`${JSON.stringify(expected, null, 2)}\n`);
  process.exit(0);
}

if (process.argv.includes("--write")) {
  writeFileSync(bomPath, `${JSON.stringify(expected, null, 2)}\n`);
  console.log(`Wrote deterministic iOS CycloneDX BOM to ${bomPath}`);
  process.exit(0);
}

const actual = readJSON("apple/GhostteaKit/Compatibility/ios-release.cdx.json");
if (JSON.stringify(actual) !== JSON.stringify(expected)) {
  throw new Error(
    `${bomPath} does not match the authoritative lock files; run with --print and review the intentional BOM update`,
  );
}

if (process.argv.includes("--release") && releaseBlockers.length > 0) {
  console.error("iOS release blocked:");
  for (const blocker of releaseBlockers) console.error(`- ${blocker}`);
  process.exit(1);
}

console.log(
  `Verified deterministic iOS CycloneDX BOM: ${expected.components.length} components, ${releaseBlockers.length} release blocker(s)`,
);

function readJSON(path) {
  return JSON.parse(readFileSync(resolve(root, path), "utf8"));
}

// "https://github.com/owner/repo.git" -> "owner/repo", for purl construction.
function githubSlug(repository) {
  const match = /github\.com[/:]([^/]+)\/(.+?)(?:\.git)?\/?$/.exec(String(repository));
  if (!match) throw new Error(`Cannot derive a GitHub slug from ${repository}.`);
  return `${match[1]}/${match[2]}`;
}

function cycloneDXLicense(value) {
  return value.includes(" ") || value.includes("/") || value.includes("(")
    ? { expression: value }
    : { license: { id: value } };
}

function normalizeLicense(value) {
  return value.replaceAll("MIT / Apache-2.0", "MIT OR Apache-2.0").replaceAll("MIT/Apache-2.0", "MIT OR Apache-2.0");
}

function validateBom(bom) {
  if (bom.bomFormat !== "CycloneDX" || bom.specVersion !== "1.6") {
    throw new Error("The generated document is not a CycloneDX 1.6 BOM.");
  }
  const componentRefs = [bom.metadata.component, ...bom.components].map((entry) => entry["bom-ref"]);
  const repeatedRefs = componentRefs.filter((ref, index) => componentRefs.indexOf(ref) !== index);
  if (repeatedRefs.length > 0) {
    throw new Error(`CycloneDX component references are not unique: ${[...new Set(repeatedRefs)].join(", ")}`);
  }
  const knownRefs = new Set(componentRefs);
  const dependencyRefs = new Set();
  for (const dependency of bom.dependencies) {
    if (!knownRefs.has(dependency.ref)) {
      throw new Error(`CycloneDX dependency subject is unknown: ${dependency.ref}`);
    }
    if (dependencyRefs.has(dependency.ref)) {
      throw new Error(`CycloneDX dependency subject is duplicated: ${dependency.ref}`);
    }
    dependencyRefs.add(dependency.ref);
    for (const child of dependency.dependsOn) {
      if (!knownRefs.has(child)) {
        throw new Error(`CycloneDX dependency target is unknown: ${child}`);
      }
    }
  }
  const missingDependencySubjects = componentRefs.filter((ref) => !dependencyRefs.has(ref));
  if (missingDependencySubjects.length > 0) {
    throw new Error(`CycloneDX dependency graph omits: ${missingDependencySubjects.join(", ")}`);
  }
}

function iosReleaseBlockers() {
  const review = ssh.securityReview;
  const blockers = [];
  if (!ssh.candidateStatus.productionApproved) {
    blockers.push(review.blockedReason || "SSH candidate lacks a recorded blocking reason");
  }
  const missingFixes = review.requiredFixCommits.filter((commit) => !review.incorporatedFixCommits.includes(commit));
  if (missingFixes.length > 0) {
    blockers.push(`SSH security fixes not incorporated: ${missingFixes.join(", ")}`);
  }
  const missingRevalidation = review.requiredRevalidation.filter(
    (gate) => !review.completedRevalidation.includes(gate),
  );
  if (missingRevalidation.length > 0) {
    blockers.push(`SSH revalidation incomplete: ${missingRevalidation.join(", ")}`);
  }
  return blockers;
}
