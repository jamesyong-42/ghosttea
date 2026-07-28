// `npm publish` happily packs a platform package whose binary was never
// staged — `files` patterns do not fail on absence — and a published package
// that resolves to nothing is the worst version of this failure, because it
// looks like a successful release until a consumer spawns it. Every
// binary-carrying package runs this from `prepublishOnly` so such a publish
// fails closed instead.
//
// The executable bit matters as much as existence: actions/download-artifact
// drops POSIX mode bits, so a staging step that forgot to restore them would
// ship a daemon macOS cannot spawn. Artifacts that are loaded rather than
// spawned (`.node`) are exempt.
//
// Platform-suffixed packages must also carry their `os`/`cpu` gates by the
// time they publish. The committed manifests deliberately omit them — npm
// refuses to install a workspace whose gate does not match the development
// machine — and `stage-published-binaries.mjs` injects them, so their absence
// here means staging never ran.
import { readFileSync, statSync } from "node:fs";

const relative = process.argv[2];
if (!relative) {
  console.error("usage: node require-staged-binary.mjs <path relative to the package being published>");
  process.exit(1);
}

const manifest = JSON.parse(readFileSync("package.json", "utf8"));
const platformSuffix = manifest.name.match(/-(darwin|win32|linux)-(arm64|x64)$/);
if (platformSuffix && (!Array.isArray(manifest.os) || !Array.isArray(manifest.cpu))) {
  console.error(
    `${manifest.name} has no os/cpu gate; staging injects it, so this publish did not run the release staging step.`,
  );
  process.exit(1);
}

let stats;
try {
  stats = statSync(relative);
} catch {
  console.error(
    `${relative} is not staged. The release workflow stages it from the validate builds before publishing; see PUBLISHING.md.`,
  );
  process.exit(1);
}
if (!stats.isFile() || stats.size === 0) {
  console.error(`${relative} is staged but empty, which can only be a broken artifact handoff.`);
  process.exit(1);
}
const needsExecutableBit = !relative.endsWith(".exe") && !relative.endsWith(".node") && process.platform !== "win32";
if (needsExecutableBit && (stats.mode & 0o111) === 0) {
  console.error(
    `${relative} is staged without an executable bit; staging must restore what the artifact upload dropped.`,
  );
  process.exit(1);
}
console.log(`${relative} is staged (${stats.size} bytes)`);
