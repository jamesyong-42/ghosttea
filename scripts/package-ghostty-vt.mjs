import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { installPrefix, libraryPath, lock, resolveTarget, root, targetConfig } from "./ghostty-vt-target.mjs";

const allowMismatch = process.argv.includes("--allow-mismatch");
const target = resolveTarget();
const config = targetConfig(target);
const library = libraryPath(target);
// Container cross-builds are byte-reproducible, so their locked checksums also
// gate repository builds. Native builds depend on the host toolchain, so their
// checksums only gate downloaded bundles.
const reproducible = config.build === "container";
const revision = lock.ghostty.commit.slice(0, 12);
const release = `ghostty-vt-${revision}`;
const filename = `${release}-${target}.tar`;
const outputDirectory = join(root, "artifacts/ghostty-vt");

function filesBelow(directory) {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory() ? filesBelow(path) : [path];
    })
    .toSorted(compareText);
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

const install = join(installPrefix(target), "install");
const includeRoot = join(install, "include");
const headerInputs = filesBelow(includeRoot).map((sourcePath) => ({
  bundlePath: `include/${relative(includeRoot, sourcePath).replaceAll("\\", "/")}`,
  sourcePath,
}));
const inputs = [
  ...headerInputs,
  // Only the static archive ships. On Windows the install tree also holds
  // ghostty-vt.lib, the DLL import library, which must not be bundled.
  { bundlePath: library, sourcePath: join(install, library) },
  {
    bundlePath: "LICENSES/Ghostty.txt",
    sourcePath: join(install, "share/licenses/ghostty/LICENSE"),
  },
].map((file) => ({ ...file, contents: readFileSync(file.sourcePath) }));

function digest(algorithm, contents) {
  return createHash(algorithm).update(contents).digest("hex");
}

function stableJson(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
}

function treeDigest(files) {
  const inventory = files
    .toSorted((left, right) => compareText(left.bundlePath, right.bundlePath))
    .map((file) => `${file.bundlePath}\0${digest("sha256", file.contents)}\0${file.contents.length}\n`)
    .join("");
  return digest("sha256", inventory);
}

const artifact = {
  schemaVersion: 1,
  name: "ghostty-vt",
  target,
  source: {
    repository: lock.ghostty.repository,
    commit: lock.ghostty.commit,
  },
  builder: reproducible
    ? {
        mode: "container",
        image: lock.builder.image,
        platform: lock.builder.platform,
        zigVersion: lock.zig.version,
        zigTarget: config.zigTarget,
        postprocessor: {
          tool: "Apple strip",
          flags: ["-S"],
          canonicalArchiveMetadata: true,
        },
      }
    : {
        mode: "native",
        hostPlatform: config.hostPlatform,
        zigVersion: lock.zig.version,
        zigTarget: config.zigTarget,
        postprocessor: null,
      },
  files: Object.fromEntries(
    inputs.map((file) => [file.bundlePath, { sha256: digest("sha256", file.contents), size: file.contents.length }]),
  ),
};

const spdxFiles = inputs.map((file, index) => ({
  SPDXID: `SPDXRef-File-${index + 1}`,
  fileName: `./${file.bundlePath}`,
  checksums: [
    { algorithm: "SHA1", checksumValue: digest("sha1", file.contents) },
    { algorithm: "SHA256", checksumValue: digest("sha256", file.contents) },
  ],
  licenseConcluded: "MIT",
  licenseInfoInFiles: ["MIT"],
  copyrightText: "NOASSERTION",
}));
const verificationCode = digest(
  "sha1",
  spdxFiles
    .map((file) => file.checksums.find((checksum) => checksum.algorithm === "SHA1").checksumValue)
    .sort()
    .join(""),
);
const sbom = {
  spdxVersion: "SPDX-2.3",
  dataLicense: "CC0-1.0",
  SPDXID: "SPDXRef-DOCUMENT",
  name: `${release}-${target}`,
  documentNamespace: `https://github.com/jamesyong-42/ghosttea/sbom/${release}/${target}`,
  creationInfo: {
    created: "1970-01-01T00:00:00Z",
    creators: ["Tool: ghosttea-package-ghostty-vt"],
  },
  packages: [
    {
      SPDXID: "SPDXRef-Package-Ghostty",
      name: "Ghostty VT",
      versionInfo: lock.ghostty.commit,
      downloadLocation: `${lock.ghostty.repository}@${lock.ghostty.commit}`,
      filesAnalyzed: true,
      packageVerificationCode: { packageVerificationCodeValue: verificationCode },
      licenseConcluded: "MIT",
      licenseDeclared: "MIT",
      copyrightText: "Copyright (c) Mitchell Hashimoto and contributors",
    },
  ],
  files: spdxFiles,
  relationships: [
    {
      spdxElementId: "SPDXRef-DOCUMENT",
      relationshipType: "DESCRIBES",
      relatedSpdxElement: "SPDXRef-Package-Ghostty",
    },
    ...spdxFiles.map((file) => ({
      spdxElementId: "SPDXRef-Package-Ghostty",
      relationshipType: "CONTAINS",
      relatedSpdxElement: file.SPDXID,
    })),
  ],
};

function writeOctal(header, offset, length, value) {
  const encoded = value.toString(8).padStart(length - 1, "0") + "\0";
  header.write(encoded, offset, length, "ascii");
}

function tarEntry(name, contents) {
  if (Buffer.byteLength(name) > 100) throw new Error(`tar path is too long: ${name}`);
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, "utf8");
  writeOctal(header, 100, 8, 0o644);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, contents.length);
  writeOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header.write("0", 156, 1, "ascii");
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  header.write("root", 265, 32, "ascii");
  header.write("root", 297, 32, "ascii");
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  const padding = Buffer.alloc((512 - (contents.length % 512)) % 512);
  return Buffer.concat([header, contents, padding]);
}

const entries = [
  ...inputs.map((file) => [file.bundlePath, file.contents]),
  ["artifact.json", stableJson(artifact)],
  ["sbom.spdx.json", stableJson(sbom)],
].sort(([left], [right]) => compareText(left, right));
const bundle = Buffer.concat([...entries.map(([name, contents]) => tarEntry(name, contents)), Buffer.alloc(1024)]);

mkdirSync(outputDirectory, { recursive: true });
writeFileSync(join(outputDirectory, filename), bundle);
const result = {
  schemaVersion: 1,
  release,
  target,
  filename,
  url: `https://github.com/jamesyong-42/ghosttea/releases/download/${release}/${filename}`,
  sha256: digest("sha256", bundle),
  size: bundle.length,
  libraryPath: library,
  librarySha256: artifact.files[library].sha256,
  headersSha256: treeDigest(inputs.filter((file) => file.bundlePath.startsWith("include/"))),
  reproducible,
};
writeFileSync(join(outputDirectory, `${filename}.json`), stableJson(result));
writeFileSync(join(outputDirectory, `${filename}.spdx.json`), stableJson(sbom));
console.log(JSON.stringify(result, null, 2));
const lockedManifest = JSON.parse(
  readFileSync(join(root, "native/terminald/crates/ghostty-vt-sys/artifacts.json"), "utf8"),
);
const lockedTarget = lockedManifest.targets[target];
for (const field of [
  "release",
  "filename",
  "url",
  "sha256",
  "size",
  "libraryPath",
  "librarySha256",
  "headersSha256",
  "reproducible",
]) {
  if (lockedTarget?.[field] !== result[field]) {
    const message = `native artifact manifest mismatch for ${field}: expected ${JSON.stringify(lockedTarget?.[field])}, got ${JSON.stringify(result[field])}`;
    if (!allowMismatch) throw new Error(message);
    console.warn(message);
  }
}
