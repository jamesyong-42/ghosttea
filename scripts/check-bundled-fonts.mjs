// The parity fonts are committed rather than generated, because `GhostteaFonts`
// declares them as a `.process` resource and `GhostteaCore` depends on it: an
// empty directory fails SwiftPM at package-graph load for every product. That
// makes them the one class of binary in this tree whose bytes are a published
// contract, so verify them against the pin instead of trusting the checkout.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const lock = JSON.parse(readFileSync(join(root, "native/fonts.lock.json"), "utf8"));
const fontsDirectory = join(root, "apple/GhostteaKit/Sources/GhostteaFontProof/Resources/Fonts");

const problems = [];

if (!existsSync(fontsDirectory)) {
  problems.push(`${fontsDirectory} is missing; run \`npm run sync:fonts\`.`);
} else {
  const expected = new Map(lock.fonts.map((font) => [basename(font.path), font]));

  for (const [filename, font] of expected) {
    const path = join(fontsDirectory, filename);
    if (!existsSync(path)) {
      problems.push(`Missing bundled font ${filename} (role ${font.role}); run \`npm run sync:fonts\`.`);
      continue;
    }
    const digest = createHash("sha256").update(readFileSync(path)).digest("hex");
    if (digest !== font.sha256) {
      problems.push(
        `Bundled font ${filename} does not match native/fonts.lock.json: expected ${font.sha256}, got ${digest}.`,
      );
    }
  }

  // An unlocked font in this directory would ship in the package resource
  // bundle without appearing in the release BOM, so treat it as drift too.
  for (const filename of readdirSync(fontsDirectory)) {
    if (filename.endsWith(".ttf") && !expected.has(filename)) {
      problems.push(`Unlocked font ${filename} is present; remove it or add it to native/fonts.lock.json.`);
    }
  }
}

if (problems.length > 0) {
  console.error(problems.map((problem) => `- ${problem}`).join("\n"));
  process.exit(1);
}

console.log(`verified ${lock.fonts.length} bundled fonts against native/fonts.lock.json`);
