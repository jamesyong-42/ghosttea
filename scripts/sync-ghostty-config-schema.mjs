import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const lock = JSON.parse(readFileSync(resolve(root, "native/ghostty-config.lock.json"), "utf8"));
const args = process.argv.slice(2);
const check = args.includes("--check");
const sourceArgument = valueAfter("--source") ?? process.env.GHOSTTY_CONFIG_SOURCE;
if (!sourceArgument) {
  throw new Error("Pass --source PATH (or GHOSTTY_CONFIG_SOURCE) pointing to the released Ghostty source checkout.");
}
const sourceRoot = resolve(sourceArgument);

const commit = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: sourceRoot,
  encoding: "utf8",
}).trim();
requireEqual(commit, lock.ghostty.commit, "Ghostty config source commit");
const tagCommit = execFileSync("git", ["rev-parse", `${lock.ghostty.tag}^{commit}`], {
  cwd: sourceRoot,
  encoding: "utf8",
}).trim();
requireEqual(tagCommit, lock.ghostty.commit, "Ghostty config release tag");

const status = execFileSync("git", ["status", "--porcelain"], {
  cwd: sourceRoot,
  encoding: "utf8",
});
if (status.trim()) throw new Error(`Ghostty config source checkout is dirty: ${sourceRoot}`);

const buildManifest = source("build.zig.zon");
const version = buildManifest.match(/^\s*\.version\s*=\s*"([^"]+)"/m)?.[1];
requireEqual(version, lock.ghostty.version, "Ghostty config source version");

for (const [name, entry] of Object.entries(lock.sources)) {
  requireEqual(sha256(source(entry.path)), entry.sha256, `Ghostty ${name} source digest`);
}

const configSource = source(lock.sources.config.path);
const configFields = configSource.split("\npub fn deinit", 1)[0];
const knownKeys = [...configFields.matchAll(/^(?:@"([^"]+)"|([A-Za-z][A-Za-z0-9_]*))\s*:/gm)]
  .map((match) => match[1] ?? match[2])
  .filter((key) => !key.startsWith("_"))
  .sort();
const knownKeysText = `${knownKeys.join("\n")}\n`;
requireEqual(knownKeys.length, lock.generated.knownKeys.count, "Ghostty known-key count");
requireEqual(sha256(knownKeysText), lock.generated.knownKeys.sha256, "Ghostty known-key digest");

const x11ColorsText = source(lock.sources.x11Colors.path);
requireEqual(sha256(x11ColorsText), lock.generated.x11Colors.sha256, "Ghostty X11 color digest");

const defaults = {
  scrollbackBytes: integerDefault(configSource, "scrollback-limit"),
  fontSize: fontSizeDefaults(configSource),
  foreground: colorDefault(configSource, "foreground"),
  background: colorDefault(configSource, "background"),
  paddingX: paddingDefault(configSource, "window-padding-x"),
  paddingY: paddingDefault(configSource, "window-padding-y"),
};
requireEqual(defaults, lock.defaults, "projected Ghostty defaults");

const outputs = [
  [lock.generated.knownKeys.path, knownKeysText],
  [lock.generated.x11Colors.path, x11ColorsText],
];
for (const [path, expected] of outputs) {
  const absolute = resolve(root, path);
  if (check) {
    requireEqual(readFileSync(absolute, "utf8"), expected, `${path} generated content`);
  } else {
    writeFileSync(absolute, expected);
  }
}

console.log(
  `${check ? "Verified" : "Generated"} Ghostty ${lock.ghostty.version} config schema at ${commit}: ${knownKeys.length} keys and pinned X11 colors.`,
);

function valueAfter(flag) {
  const index = args.indexOf(flag);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value.`);
  return value;
}

function source(path) {
  return readFileSync(resolve(sourceRoot, path), "utf8");
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function integerDefault(text, key) {
  const escaped = escapeRegExp(key);
  const value = text.match(new RegExp(`^@"${escaped}": usize = ([0-9_]+)`, "m"))?.[1];
  if (!value) throw new Error(`Could not extract Ghostty default for ${key}.`);
  return Number(value.replaceAll("_", ""));
}

function fontSizeDefaults(text) {
  const match = text.match(
    /^@"font-size": f32 = switch \(builtin\.os\.tag\) \{\s*.*?\.macos => ([0-9.]+),\s*else => ([0-9.]+),\s*\}/ms,
  );
  if (!match) throw new Error("Could not extract Ghostty font-size defaults.");
  return { macos: Number(match[1]), other: Number(match[2]) };
}

function colorDefault(text, key) {
  const escaped = escapeRegExp(key);
  const match = text.match(
    new RegExp(
      `^${escaped}: Color = \\.\\{ \\.r = (0x[0-9A-Fa-f]+), \\.g = (0x[0-9A-Fa-f]+), \\.b = (0x[0-9A-Fa-f]+) \\}`,
      "m",
    ),
  );
  if (!match) throw new Error(`Could not extract Ghostty color default for ${key}.`);
  return match.slice(1).map((value) => Number.parseInt(value, 16));
}

function paddingDefault(text, key) {
  const escaped = escapeRegExp(key);
  const match = text.match(
    new RegExp(`^@"${escaped}": WindowPadding = \\.\\{ \\.top_left = ([0-9.]+), \\.bottom_right = ([0-9.]+) \\}`, "m"),
  );
  if (!match) throw new Error(`Could not extract Ghostty padding default for ${key}.`);
  return [Number(match[1]), Number(match[2])];
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function requireEqual(actual, expected, description) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${description} drifted: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}.`);
  }
}
