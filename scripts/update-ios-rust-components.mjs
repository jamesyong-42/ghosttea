import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const target = "aarch64-apple-ios";
const rootPackageName = "ghosttea-ffi";
const outputPath = resolve(root, "apple/GhostteaKit/Compatibility/ios-rust-components.lock.json");

const metadataResult = spawnSync(
  "cargo",
  ["metadata", "--locked", "--format-version", "1", "--filter-platform", target],
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
const packagesByID = new Map(metadata.packages.map((entry) => [entry.id, entry]));
const nodesByID = new Map(metadata.resolve.nodes.map((entry) => [entry.id, entry]));
const roots = metadata.packages.filter((entry) => entry.name === rootPackageName);
if (roots.length !== 1) {
  throw new Error(`Expected exactly one ${rootPackageName} package, found ${roots.length}.`);
}

const selectedIDs = new Set();
const dependenciesByID = new Map();
const pending = [roots[0].id];
while (pending.length > 0) {
  const packageID = pending.shift();
  if (selectedIDs.has(packageID)) continue;
  selectedIDs.add(packageID);
  const node = nodesByID.get(packageID);
  if (!node) throw new Error(`Cargo metadata omitted resolve node ${packageID}.`);
  const dependencies = node.deps
    .filter((dependency) => dependency.dep_kinds.some((kind) => kind.kind !== "dev"))
    .map((dependency) => dependency.pkg);
  dependenciesByID.set(packageID, dependencies);
  pending.push(...dependencies);
}

const cargoLockText = readFileSync(resolve(root, "Cargo.lock"), "utf8");
const lockedPackages = parseCargoLock(cargoLockText);
const refByID = new Map(
  [...selectedIDs].map((packageID) => {
    const entry = packagesByID.get(packageID);
    if (!entry) throw new Error(`Cargo metadata omitted package ${packageID}.`);
    return [packageID, cargoRef(entry)];
  }),
);
const duplicateRefs = duplicates([...refByID.values()]);
if (duplicateRefs.length > 0) {
  throw new Error(`Cargo package references are not unique: ${duplicateRefs.join(", ")}`);
}

const components = [...selectedIDs]
  .filter((packageID) => packageID !== roots[0].id)
  .map((packageID) => {
    const entry = packagesByID.get(packageID);
    const locked = lockedPackages.find(
      (candidate) =>
        candidate.name === entry.name &&
        candidate.version === entry.version &&
        (candidate.source ?? null) === (entry.source ?? null),
    );
    if (!locked) {
      throw new Error(`Cargo.lock omitted ${entry.name}@${entry.version} (${entry.source ?? "workspace"}).`);
    }
    if (entry.source?.startsWith("registry+") && !locked.checksum) {
      throw new Error(`Registry crate ${entry.name}@${entry.version} has no Cargo.lock checksum.`);
    }
    return {
      ref: refByID.get(packageID),
      name: entry.name,
      version: entry.version,
      source: entry.source ?? "workspace",
      license: entry.license ?? "NOASSERTION",
      ...(locked.checksum ? { checksum: locked.checksum } : {}),
      dependencies: dependenciesByID
        .get(packageID)
        .filter((dependencyID) => selectedIDs.has(dependencyID))
        .map((dependencyID) => refByID.get(dependencyID))
        .sort(),
    };
  })
  .sort((left, right) => left.ref.localeCompare(right.ref));

const document = {
  schemaVersion: 1,
  target,
  root: {
    ref: refByID.get(roots[0].id),
    name: roots[0].name,
    version: roots[0].version,
    dependencies: dependenciesByID
      .get(roots[0].id)
      .map((dependencyID) => refByID.get(dependencyID))
      .sort(),
  },
  cargoLockSha256: sha256(cargoLockText),
  components,
};

writeFileSync(outputPath, `${JSON.stringify(document, null, 2)}\n`);
console.log(`Wrote ${components.length} transitive ${target} Rust components to ${outputPath}`);

function cargoRef(entry) {
  return `pkg:cargo/${entry.name}@${entry.version}`;
}

function duplicates(values) {
  const seen = new Set();
  const repeated = new Set();
  for (const value of values) {
    if (seen.has(value)) repeated.add(value);
    seen.add(value);
  }
  return [...repeated].sort();
}

function parseCargoLock(contents) {
  return contents
    .split(/^\[\[package\]\]$/m)
    .slice(1)
    .map((block) => ({
      name: tomlString(block, "name"),
      version: tomlString(block, "version"),
      source: tomlString(block, "source", false),
      checksum: tomlString(block, "checksum", false),
    }));
}

function tomlString(block, key, required = true) {
  const match = block.match(new RegExp(`^${key} = "([^"]+)"$`, "m"));
  if (!match && required) throw new Error(`Cargo.lock package omitted ${key}.`);
  return match?.[1];
}

function sha256(contents) {
  return createHash("sha256").update(contents).digest("hex");
}
