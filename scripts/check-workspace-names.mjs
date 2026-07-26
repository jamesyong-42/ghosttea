// Every workspace directory must be named after the crate or package it
// contains. A directory that drifts from its published name is invisible to the
// compiler and the registry, so nothing else in this repository catches it, and
// a reader who greps for a crate name simply does not find its source.
//
// Private applications under `apps/` are exempt: they are never published, and
// their directories are named for the product surface rather than the manifest.
import { readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const read = (path) => readFileSync(join(root, path), "utf8");
const readJSON = (path) => JSON.parse(read(path));
const failures = [];

// Cargo workspace members: the directory must match `[package] name`.
const members = [...read("Cargo.toml").matchAll(/^\s*"([^"]+)",\s*$/gm)]
  .map((match) => match[1])
  .filter((member) => member.startsWith("native/"));
if (members.length === 0) throw new Error("no Cargo workspace members were parsed from Cargo.toml");

for (const member of members) {
  const name = read(`${member}/Cargo.toml`).match(/^name\s*=\s*"([^"]+)"/m)?.[1];
  if (!name) throw new Error(`${member}/Cargo.toml declares no package name`);
  if (basename(member) !== name) {
    failures.push(`crate "${name}" lives in ${member}/ — rename the directory to ${dirname(member)}/${name}`);
  }
}

// npm workspaces under `packages/`: the directory must match the unscoped name.
const directories = readJSON("package.json")
  .workspaces.filter((pattern) => pattern.startsWith("packages/"))
  .flatMap((pattern) => {
    if (!pattern.endsWith("/*")) return [pattern];
    const parent = pattern.slice(0, -2);
    return readdirSync(join(root, parent), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => `${parent}/${entry.name}`);
  });
if (directories.length === 0) throw new Error("no npm workspace directories were resolved from package.json");

for (const directory of directories) {
  const manifest = readJSON(`${directory}/package.json`);
  const unscoped = manifest.name.replace(/^@[^/]+\//, "");
  if (basename(directory) !== unscoped) {
    failures.push(
      `package "${manifest.name}" lives in ${directory}/ — rename the directory to ${dirname(directory)}/${unscoped}`,
    );
  }
  // npm resolves this to a source URL on the registry page, so a stale value
  // sends readers of a published package to a path that no longer exists.
  const declared = manifest.repository?.directory;
  if (declared !== undefined && declared !== directory) {
    failures.push(`package "${manifest.name}" declares repository.directory ${declared} but lives in ${directory}`);
  }
}

if (failures.length > 0) {
  console.error("Workspace directories must be named after the crate or package they contain:\n");
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log(`Ghosttea workspace naming passed (${members.length} crates, ${directories.length} published packages)`);
