// Stage what the validate jobs built into the packages that publish it.
//
// The publish job runs on one platform, so every binary arrives as a workflow
// artifact from the job that could build it. actions/download-artifact writes
// each artifact into a directory named after it and drops POSIX mode bits on
// the way through, so staging is three copies, a chmod, and a refusal to
// continue when anything is missing: a release with a hole in it must stop
// before the first `npm publish`, not after.
//
// The daemon packages also gain their `os`/`cpu` gates here rather than in
// the committed manifests, because npm refuses to install a workspace whose
// platform gate does not match the development machine — a committed
// `os: ["win32"]` would break `npm ci` everywhere but Windows. The fields
// exist only in what is published, which is the only place they mean
// anything, and `require-staged-binary.mjs` fails the publish if they are
// missing.
import { chmodSync, copyFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const downloads = process.argv[2];
if (!downloads) {
  console.error("usage: node stage-published-binaries.mjs <download-artifact root>");
  process.exit(1);
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const staged = [
  {
    artifact: join(downloads, "ghosttead-darwin-arm64", "ghosttead"),
    package: join(root, "packages", "ghosttead-darwin-arm64"),
    binary: join("bin", "ghosttead"),
    executable: true,
    platform: { os: ["darwin"], cpu: ["arm64"] },
  },
  {
    artifact: join(downloads, "ghosttead-win32-x64", "ghosttead.exe"),
    package: join(root, "packages", "ghosttead-win32-x64"),
    binary: join("bin", "ghosttead.exe"),
    executable: true,
    platform: { os: ["win32"], cpu: ["x64"] },
  },
  {
    artifact: join(downloads, "ghosttea-native-tabs", "ghosttea_native_tabs.node"),
    package: join(root, "packages", "ghosttea-native-tabs"),
    binary: join("prebuilds", "ghosttea_native_tabs.node"),
    executable: false,
    platform: null,
  },
];

for (const entry of staged) {
  let stats;
  try {
    stats = statSync(entry.artifact);
  } catch {
    console.error(`${entry.artifact} was not downloaded; refusing to publish a release with a missing binary`);
    process.exit(1);
  }
  if (!stats.isFile() || stats.size === 0) {
    console.error(`${entry.artifact} is empty; refusing to publish a release with a broken binary`);
    process.exit(1);
  }
  const destination = join(entry.package, entry.binary);
  mkdirSync(dirname(destination), { recursive: true });
  copyFileSync(entry.artifact, destination);
  if (entry.executable) chmodSync(destination, 0o755);
  console.log(`staged ${destination} (${stats.size} bytes)`);

  if (entry.platform) {
    const manifestPath = join(entry.package, "package.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    writeFileSync(manifestPath, `${JSON.stringify({ ...manifest, ...entry.platform }, null, 2)}\n`);
    console.log(`gated ${manifestPath} to os=${entry.platform.os} cpu=${entry.platform.cpu}`);
  }
}
