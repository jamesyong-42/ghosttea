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

const sha256 = (path) =>
  createHash("sha256")
    .update(readFileSync(resolve(root, path)))
    .digest("hex");

const licenseHashes = {
  mit: sha256("native/terminald/LICENSE"),
  ofl: sha256("apple/GhostteaKit/Sources/GhostteaFontProof/Resources/OFL-1.1.txt"),
  fontNotices: sha256("apple/GhostteaKit/Sources/GhostteaFontProof/Resources/FONT-NOTICES.md"),
};

const component = ({ type, ref, name, version, license, purl, hashes, repository, properties = [] }) => ({
  type,
  "bom-ref": ref,
  name,
  version,
  licenses: [{ license: { id: license } }],
  ...(purl ? { purl } : {}),
  ...(hashes ? { hashes } : {}),
  ...(repository ? { externalReferences: [{ type: "vcs", url: repository }] } : {}),
  ...(properties.length > 0 ? { properties } : {}),
});

const appRef = `pkg:npm/ghosttea@${packageManifest.version}`;
const runtimeRef = `pkg:cargo/ghosttea-ffi@${packageManifest.version}`;
const ghosttyRef = `pkg:github/ghostty-org/ghostty@${ghostty.ghostty.commit}`;
const opensslRef = `pkg:github/openssl/openssl@${ssh.openssl.commit}`;
const libssh2Ref = `pkg:github/libssh2/libssh2@${ssh.libssh2.commit}`;
const truffleRef = `pkg:github/jamesyong-42/truffle@${truffle.package.revision}`;
const tailscaleRef = `pkg:github/tailscale/libtailscale@${truffle.tailscaleKit.revision}`;
const fontRefs = fonts.fonts.map((font) => `ghosttea:font/${font.role}@${fonts.source.commit}`);
const releaseBlockers = iosReleaseBlockers();

const expected = {
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
        { name: "ghosttea:scope", value: "iOS release direct and bundled inputs" },
        { name: "ghosttea:source-lock", value: "native/ghostty.lock.json" },
        { name: "ghosttea:source-lock", value: "native/ssh.lock.json" },
        { name: "ghosttea:source-lock", value: "native/fonts.lock.json" },
        {
          name: "ghosttea:source-lock",
          value: "apple/GhostteaKit/Compatibility/truffle-swift.lock.json",
        },
      ],
    }),
    properties: [
      { name: "ghosttea:reproducible", value: "true" },
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
      name: "ghosttea-ffi",
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
    { ref: appRef, dependsOn: [runtimeRef, opensslRef, libssh2Ref, truffleRef, ...fontRefs] },
    { ref: runtimeRef, dependsOn: [ghosttyRef] },
    { ref: ghosttyRef, dependsOn: [] },
    { ref: opensslRef, dependsOn: [] },
    { ref: libssh2Ref, dependsOn: [opensslRef] },
    { ref: truffleRef, dependsOn: [tailscaleRef] },
    { ref: tailscaleRef, dependsOn: [] },
    ...fontRefs.map((ref) => ({ ref, dependsOn: [] })),
  ],
};

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
