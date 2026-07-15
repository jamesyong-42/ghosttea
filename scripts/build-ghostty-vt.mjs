import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const lock = JSON.parse(readFileSync(join(root, "native/ghostty.lock.json"), "utf8"));
const vendor = join(root, "native/vendor/ghostty");
const zigRoot = join(root, `.tools/zig-aarch64-linux-${lock.zig.version}`);
const zig = join(zigRoot, "zig");
const output = join(root, "native/build/ghostty");

function capture(command, args, cwd = root) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr || `${command} failed`);
  return result.stdout.trim();
}

if (!existsSync(join(vendor, ".git")) || !existsSync(zig)) {
  throw new Error("Ghostty sources or Zig are missing. Run `npm run bootstrap:ghostty-vt` first.");
}
if (capture("git", ["rev-parse", "HEAD"], vendor) !== lock.ghostty.commit) {
  throw new Error(`Ghostty source is not at locked commit ${lock.ghostty.commit}`);
}
if (capture("git", ["status", "--porcelain"], vendor) !== "") {
  throw new Error("Ghostty source has local changes; refusing a non-reproducible build.");
}

mkdirSync(output, { recursive: true });
const certCandidates = ["/etc/ssl/cert.pem", "/etc/ssl/certs/ca-certificates.crt"];
const cert = certCandidates.find(existsSync);
if (!cert) throw new Error("A host CA certificate bundle is required for Zig dependency downloads.");

const args = [
  "run",
  "--rm",
  "--platform",
  lock.builder.platform,
  "--user",
  `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`,
  "-v",
  `${vendor}:/src:ro`,
  "-v",
  `${zigRoot}:/zig:ro`,
  "-v",
  `${output}:/out`,
  "-v",
  `${cert}:/etc/ssl/certs/ca-certificates.crt:ro`,
  "-w",
  "/src",
  lock.builder.image,
  "/zig/zig",
  "build",
  "--cache-dir",
  "/out/cache",
  "--global-cache-dir",
  "/out/global",
  "--prefix",
  "/out/install",
  "-Demit-lib-vt",
  "-Doptimize=ReleaseFast",
  `-Dtarget=${lock.builder.target}`,
];
const result = spawnSync("docker", args, { cwd: root, stdio: "inherit" });
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);

const library = join(output, "install/lib/libghostty-vt.a");
if (!existsSync(library)) throw new Error("Ghostty build completed without libghostty-vt.a");
const licenseDirectory = join(output, "install/share/licenses/ghostty");
mkdirSync(licenseDirectory, { recursive: true });
copyFileSync(join(vendor, "LICENSE"), join(licenseDirectory, "LICENSE"));
console.log(`Built ${library}`);
