// Deterministic GitHub release notes for a version.
//
// Everything here is derived from files already in the repository: the prose
// from CHANGELOG.md, the shipped artifacts from the manifests that declare
// whether they publish, and the requirements from the versions the workspace
// already pins. Nothing is hand-maintained here, so these notes cannot claim a
// package that stopped shipping or a toolchain the workspace no longer asks for.
//
// The editorial sections of a release — what upgrading actually costs, what
// evidence qualified it — are not derivable and are not invented. A release is
// editable after the fact, unlike a registry version, so those are added by
// hand afterwards.
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const read = (path) => readFileSync(join(root, path), "utf8");
const readJSON = (path) => JSON.parse(read(path));

/** The body of one CHANGELOG entry, without its heading. */
export function changelogSection(changelog, version) {
  const lines = changelog.split("\n");
  const start = lines.findIndex((line) => new RegExp(`^## ${version.replace(/\./g, "\\.")}(\\s|$)`).test(line));
  if (start < 0) throw new Error(`CHANGELOG.md has no section for ${version}`);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith("## "));
  const body = (end < 0 ? rest : rest.slice(0, end)).join("\n").trim();
  if (body.length === 0) throw new Error(`The CHANGELOG.md section for ${version} is empty`);
  // A release heading is a level deeper in CHANGELOG.md than it should be on a
  // release page, where the version is already the title.
  return body.replace(/^### /gm, "## ");
}

/** Crates the workspace actually publishes, as opposed to its private targets. */
export function publishedCrates() {
  const members = [...read("Cargo.toml").matchAll(/^\s*"([^"]+)",\s*$/gm)]
    .map((match) => match[1])
    .filter((member) => member.startsWith("native/"));
  return members
    .map((member) => read(`${member}/Cargo.toml`))
    .filter((manifest) => !/^publish\s*=\s*false/m.test(manifest))
    .map((manifest) => manifest.match(/^name\s*=\s*"([^"]+)"/m)?.[1])
    .filter(Boolean)
    .sort();
}

/** npm packages the workspace actually publishes. */
export function publishedPackages() {
  return readdirSync(join(root, "packages"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => readJSON(`packages/${entry.name}/package.json`))
    .filter((manifest) => manifest.private !== true)
    .map((manifest) => manifest.name)
    .sort();
}

export function releaseNotes(version) {
  const crates = publishedCrates();
  const packages = publishedPackages();
  // `>=22` is how a package manifest states it; `22+` is how prose does.
  const node = (readJSON("package.json").engines?.node ?? "").replace(/^>=\s*/, "");
  const rust = read("Cargo.toml").match(/^rust-version\s*=\s*"([^"]+)"/m)?.[1] ?? "";
  const targets = Object.keys(readJSON("native/ghosttea/crates/ghosttea-vt-sys/artifacts.json").targets).sort();

  const list = (items) => items.map((item) => `- \`${item}\``).join("\n");

  return [
    "Ghosttea is a native Ghostty-powered terminal runtime and desktop experience for Electron applications.",
    "",
    `This release publishes ${packages.length} npm packages and ${crates.length} Rust crates under one shared version.`,
    "",
    changelogSection(read("CHANGELOG.md"), version),
    "",
    "## Packages",
    "",
    "npm:",
    "",
    list(packages),
    "",
    "crates.io:",
    "",
    list(crates),
    "",
    "Publish order is a dependency order rather than this one; it is recorded in `PUBLISHING.md`.",
    "",
    "## Requirements",
    "",
    `Node ${node}+ and Rust ${rust}+. Native Ghostty VT artifacts are published for ${targets
      .map((target) => `\`${target}\``)
      .join(" and ")}.`,
    "",
  ].join("\n");
}

// Importable for tests; prints when run directly.
if (process.argv[1] === import.meta.filename) {
  process.stdout.write(releaseNotes(process.argv[2] ?? readJSON("package.json").version));
}
