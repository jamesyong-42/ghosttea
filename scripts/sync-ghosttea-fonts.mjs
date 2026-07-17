import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const lock = JSON.parse(readFileSync(join(root, "native/fonts.lock.json"), "utf8"));
const vendor = join(root, "native/vendor/ghostty");
const output = join(root, "native/build/ghosttea-fonts");

function capture(command, args, cwd = root) {
  return execFileSync(command, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }).trim();
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

if (!existsSync(join(vendor, ".git"))) {
  throw new Error("Pinned Ghostty sources are missing. Run `npm run bootstrap:ghostty-vt` first.");
}
if (capture("git", ["rev-parse", "HEAD"], vendor) !== lock.source.commit) {
  throw new Error(`Ghostty source is not at locked font commit ${lock.source.commit}.`);
}

rmSync(output, { recursive: true, force: true });
mkdirSync(output, { recursive: true });

const manifestFonts = [];
for (const font of lock.fonts) {
  const source = join(vendor, font.path);
  if (!existsSync(source)) throw new Error(`Missing locked font ${font.path}.`);
  const digest = sha256(source);
  if (digest !== font.sha256) throw new Error(`Digest mismatch for locked font ${font.path}.`);
  const filename = basename(font.path);
  cpSync(source, join(output, filename));
  manifestFonts.push({ role: font.role, filename, sha256: digest });
}

for (const [name, relativePath] of Object.entries({
  "OFL-1.1.txt": lock.license.text,
  "FONT-NOTICES.md": lock.license.notices,
})) {
  const source = join(vendor, relativePath);
  if (!existsSync(source)) throw new Error(`Missing font license material ${relativePath}.`);
  cpSync(source, join(output, name));
}

writeFileSync(
  join(output, "manifest.json"),
  `${JSON.stringify(
    {
      schemaVersion: lock.schemaVersion,
      source: lock.source,
      license: lock.license.id,
      metrics: lock.metrics,
      fallbackPolicy: lock.fallbackPolicy,
      fonts: manifestFonts,
    },
    null,
    2,
  )}\n`,
);

console.log(`Synced ${manifestFonts.length} locked fonts to ${output}`);
