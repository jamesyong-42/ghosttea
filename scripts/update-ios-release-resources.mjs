import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const packageVersion = readJSON("package.json").version;
const resourcesDirectory = resolve(root, "apple/GhostteaApp/Resources");
const noticePath = resolve(resourcesDirectory, "THIRD-PARTY-NOTICES.txt");
const bundledBomPath = resolve(resourcesDirectory, "Ghosttea-iOS.cdx.json");
const lockPath = resolve(root, "apple/GhostteaKit/Compatibility/ios-release-resources.lock.json");
const sourceBomPath = resolve(root, "apple/GhostteaKit/Compatibility/ios-release.cdx.json");
const rustLock = readJSON("apple/GhostteaKit/Compatibility/ios-rust-components.lock.json");
const truffleLock = readJSON("apple/GhostteaKit/Compatibility/truffle-swift.lock.json");
const bomBytes = readFileSync(sourceBomPath);
const bom = JSON.parse(bomBytes);
const tailscaleLicensePath = "../p008/truffle/apple/.vendor/libtailscale/LICENSE";
const tailscaleLicenseHash = sha256(readFileSync(resolve(root, tailscaleLicensePath)));
if (tailscaleLicenseHash !== truffleLock.tailscaleKit.licenseSha256) {
  throw new Error(
    `TailscaleKit license drifted: expected ${truffleLock.tailscaleKit.licenseSha256}, got ${tailscaleLicenseHash}.`,
  );
}

const metadataResult = spawnSync(
  "cargo",
  ["metadata", "--locked", "--format-version", "1", "--filter-platform", rustLock.target],
  {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  },
);
if (metadataResult.error) throw metadataResult.error;
if (metadataResult.status !== 0) {
  throw new Error(`cargo metadata failed with status ${metadataResult.status}`);
}
const metadata = JSON.parse(metadataResult.stdout);

const componentNotices = [];
const documentsByHash = new Map();

addComponent("ghosttea-ffi", packageVersion, "MIT", ["native/ghosttea/LICENSE"]);
addComponent("Ghostty VT", versionOf("Ghostty VT"), "MIT", ["native/vendor/ghostty/LICENSE"]);
addComponent("OpenSSL", versionOf("OpenSSL"), "Apache-2.0", ["native/vendor/openssl/LICENSE.txt"]);
addComponent(
  "libssh2",
  versionOf("libssh2"),
  "BSD-3-Clause and bundled notices",
  readdirSync(resolve(root, "native/vendor/libssh2/LICENSES"))
    .sort()
    .map((name) => `native/vendor/libssh2/LICENSES/${name}`),
);
addComponent("Truffle Swift", versionOf("Truffle Swift"), "MIT", ["../p008/truffle/LICENSE"]);
addComponent("TailscaleKit", versionOf("TailscaleKit"), "BSD-3-Clause", [tailscaleLicensePath]);

for (const entry of rustLock.components) {
  if (entry.source === "workspace") {
    addComponent(entry.name, entry.version, entry.license, ["native/ghosttea/LICENSE"]);
    continue;
  }
  const matches = metadata.packages.filter(
    (candidate) =>
      candidate.name === entry.name &&
      candidate.version === entry.version &&
      (candidate.source ?? "workspace") === entry.source,
  );
  if (matches.length !== 1) {
    throw new Error(`Expected one resolved package for ${entry.name}@${entry.version}, found ${matches.length}.`);
  }
  const packageDirectory = dirname(matches[0].manifest_path);
  const licenseFiles = findLicenseFiles(packageDirectory);
  if (licenseFiles.length === 0) {
    throw new Error(`Resolved package ${entry.name}@${entry.version} contains no license file.`);
  }
  addComponent(entry.name, entry.version, entry.license, licenseFiles);
}

for (const font of bom.components.filter((entry) => entry.type === "file")) {
  addComponent(font.name, font.version, licenseOf(font), [
    "apple/GhostteaKit/Sources/GhostteaFontProof/Resources/OFL-1.1.txt",
    "apple/GhostteaKit/Sources/GhostteaFontProof/Resources/FONT-NOTICES.md",
  ]);
}

const documents = [...documentsByHash.values()].sort((left, right) => left.hash.localeCompare(right.hash));
const documentIDByHash = new Map(
  documents.map((entry, index) => [entry.hash, `LICENSE-${String(index + 1).padStart(3, "0")}`]),
);
const sourceBomSha256 = sha256(bomBytes);
const notice = renderNotice(componentNotices, documents, documentIDByHash, sourceBomSha256);

mkdirSync(resourcesDirectory, { recursive: true });
writeFileSync(bundledBomPath, bomBytes);
writeFileSync(noticePath, notice);

const lock = {
  schemaVersion: 1,
  sourceBom: {
    path: "apple/GhostteaKit/Compatibility/ios-release.cdx.json",
    sha256: sourceBomSha256,
  },
  bundledBom: {
    path: "apple/GhostteaApp/Resources/Ghosttea-iOS.cdx.json",
    sha256: sha256(bomBytes),
  },
  notices: {
    path: "apple/GhostteaApp/Resources/THIRD-PARTY-NOTICES.txt",
    sha256: sha256(notice),
    componentCount: componentNotices.length,
    licenseDocumentCount: documents.length,
  },
};
writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
console.log(
  `Wrote iOS release resources for ${componentNotices.length} components and ${documents.length} unique license documents.`,
);

function addComponent(name, version, license, paths) {
  const documentHashes = [];
  for (const path of paths) {
    const absolutePath = path.startsWith("/") ? path : resolve(root, path);
    const text = normalizeText(readFileSync(absolutePath, "utf8"));
    const hash = sha256(text);
    documentHashes.push(hash);
    const existing = documentsByHash.get(hash);
    if (existing) {
      existing.usedBy.add(`${name} ${version}`);
    } else {
      documentsByHash.set(hash, {
        hash,
        fileNames: new Set([basename(absolutePath)]),
        text,
        usedBy: new Set([`${name} ${version}`]),
      });
    }
    documentsByHash.get(hash).fileNames.add(basename(absolutePath));
  }
  componentNotices.push({
    name,
    version,
    license,
    documents: [...new Set(documentHashes)].sort(),
  });
}

function findLicenseFiles(directory, depth = 0) {
  if (depth > 5) return [];
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === ".git" || entry.name === "target") continue;
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...findLicenseFiles(path, depth + 1));
    } else if (entry.isFile() && /^(LICENSE|LICENCE|COPYING|NOTICE)([-._].*)?$/i.test(entry.name)) {
      files.push(path);
    }
  }
  return files.sort();
}

function renderNotice(components, documents, idByHash, bomHash) {
  const lines = [
    "GHOSTTEA iOS THIRD-PARTY NOTICES",
    "================================",
    "",
    "This file is generated from the reviewed iOS release dependency graph.",
    `CycloneDX SHA-256: ${bomHash}`,
    `Components: ${components.length}`,
    `Unique license documents: ${documents.length}`,
    "",
    "COMPONENT INDEX",
    "===============",
    "",
  ];
  for (const entry of components) {
    lines.push(`${entry.name} ${entry.version}`);
    lines.push(`  License: ${entry.license}`);
    lines.push(`  Documents: ${entry.documents.map((hash) => idByHash.get(hash)).join(", ")}`);
    lines.push("");
  }
  lines.push("LICENSE DOCUMENTS", "=================", "");
  for (const document of documents) {
    lines.push("=".repeat(80));
    lines.push(`${idByHash.get(document.hash)} · ${[...document.fileNames].sort().join(", ")}`);
    lines.push(`SHA-256: ${document.hash}`);
    lines.push(`Used by: ${[...document.usedBy].sort().join(", ")}`);
    lines.push("-".repeat(80), document.text.trimEnd(), "");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

function versionOf(name) {
  const matches = bom.components.filter((entry) => entry.name === name);
  if (matches.length !== 1) throw new Error(`Expected exactly one BOM component named ${name}.`);
  return matches[0].version;
}

function licenseOf(component) {
  return component.licenses.map((entry) => entry.expression ?? entry.license?.id ?? entry.license?.name).join(" AND ");
}

function normalizeText(value) {
  const lines = value.replaceAll("\r\n", "\n").split("\n");
  return `${lines
    .map((line) => line.trimEnd())
    .join("\n")
    .trimEnd()}\n`;
}

function readJSON(path) {
  return JSON.parse(readFileSync(resolve(root, path), "utf8"));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
