import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const target = "aarch64-apple-darwin";
const manifest = JSON.parse(readFileSync(join(root, "native/terminald/crates/ghostty-vt-sys/artifacts.json"), "utf8"));
const artifact = manifest.targets[target];
if (!artifact) throw new Error(`No locked Ghostty VT artifact exists for ${target}`);

const outputDirectory = join(root, "artifacts/ghostty-vt");
const output = join(outputDirectory, artifact.filename);
const temporary = `${output}.download-${process.pid}`;
const maximumBytes = 64 * 1024 * 1024;

function verify(contents) {
  if (contents.length !== artifact.size) {
    throw new Error(`Ghostty VT artifact size mismatch: expected ${artifact.size}, received ${contents.length}`);
  }
  const checksum = createHash("sha256").update(contents).digest("hex");
  if (checksum !== artifact.sha256) {
    throw new Error(`Ghostty VT artifact checksum mismatch: expected ${artifact.sha256}, received ${checksum}`);
  }
}

if (existsSync(output)) {
  verify(readFileSync(output));
  console.log(`verified cached Ghostty VT artifact at ${output}`);
  process.exit(0);
}

const configuredBase = process.env.GHOSTTEA_GHOSTTY_VT_BASE_URL?.replace(/\/+$/, "");
const url = configuredBase ? `${configuredBase}/${artifact.filename}` : artifact.url;
const response = await fetch(url);
if (!response.ok) throw new Error(`Ghostty VT artifact download failed with HTTP ${response.status}`);
const declaredLength = Number(response.headers.get("content-length"));
if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
  throw new Error(`Ghostty VT artifact exceeds the ${maximumBytes}-byte download limit`);
}
const contents = Buffer.from(await response.arrayBuffer());
if (contents.length > maximumBytes) {
  throw new Error(`Ghostty VT artifact exceeds the ${maximumBytes}-byte download limit`);
}
verify(contents);

mkdirSync(outputDirectory, { recursive: true });
try {
  writeFileSync(temporary, contents, { flag: "wx" });
  renameSync(temporary, output);
} finally {
  rmSync(temporary, { force: true });
}
console.log(`downloaded and verified Ghostty VT artifact at ${output}`);
