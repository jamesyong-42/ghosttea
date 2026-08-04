import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const lock = JSON.parse(readFileSync(join(root, "native/fonts.lock.json"), "utf8"));
const vendor = join(root, "native/vendor/ghostty");
const output = join(root, "native/build/ghosttea-fonts");
const appleResources = join(root, "apple/GhostteaKit/Sources/GhostteaFontProof/Resources");
const appleFonts = join(appleResources, "Fonts");

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
mkdirSync(appleFonts, { recursive: true });

const manifestFonts = [];
for (const font of lock.fonts) {
  const source = font.bundledPath ? join(root, font.bundledPath) : join(vendor, font.path);
  if (!existsSync(source)) throw new Error(`Missing locked font ${font.path}.`);
  const digest = sha256(source);
  if (digest !== font.sha256) throw new Error(`Digest mismatch for locked font ${font.path}.`);
  const filename = basename(font.path);
  cpSync(source, join(output, filename));
  cpSync(source, join(appleFonts, filename));
  manifestFonts.push({ role: font.role, filename, sha256: digest });
}

const licenseSource = join(vendor, lock.license.text);
if (!existsSync(licenseSource)) {
  throw new Error(`Missing font license material ${lock.license.text}.`);
}
cpSync(licenseSource, join(output, "OFL-1.1.txt"));
cpSync(licenseSource, join(appleResources, "OFL-1.1.txt"));

const noticesSource = join(vendor, lock.license.notices);
if (!existsSync(noticesSource)) {
  throw new Error(`Missing font license material ${lock.license.notices}.`);
}
const additions = (lock.additionalNotices ?? [])
  .map((notice) => `- ${notice.name} (${notice.license})\n  - ${notice.copyright}\n  - ${notice.repository}`)
  .join("\n");
const notices = `${readFileSync(noticesSource, "utf8").trimEnd()}\n${
  additions ? `\n## Ghosttea fallback additions\n\n${additions}\n` : ""
}`;
writeFileSync(join(output, "FONT-NOTICES.md"), notices);
writeFileSync(join(appleResources, "FONT-NOTICES.md"), notices);

cpSync(join(root, "native/ghosttea/fixtures/phase2/font-parity.json"), join(appleResources, "font-parity.json"));

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

console.log(`Synced ${manifestFonts.length} locked fonts to ${output} and Apple resources`);
