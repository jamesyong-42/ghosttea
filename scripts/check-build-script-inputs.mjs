// A build script's own outputs must never be declared as its inputs.
//
// Cargo compares every `cargo:rerun-if-changed` path against the build unit's
// `output` file and re-runs the script when one is newer. That reference is
// written before the script finishes populating `OUT_DIR`, so a declared path
// under `OUT_DIR` is unconditionally newer than it: the unit invalidates itself
// on every build, re-downloads and re-extracts the Ghostty VT artifact, and
// drags every crate that links ghosttea through a full recompile behind it.
//
// This shipped in 0.9.2 and no test caught it, because a build from this
// checkout resolves `Prefix::Repository` and never touches the download path
// where the bug lives. Only consumers saw it. So the check is source-level:
// `ghosttea-vt-sys`'s build script routes every path declaration through its
// `rerun_if_changed` guard, which drops anything under `OUT_DIR`, and a raw
// `println!` of a dynamic path would bypass that guard.
//
// Literal declarations are exempt. A path Cargo resolves relative to the
// manifest directory — `artifacts.json`, the shim sources — cannot name
// `OUT_DIR` and needs no guard.
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const script = "native/ghosttea/crates/ghosttea-vt-sys/build.rs";
const source = readFileSync(join(root, script), "utf8");
const failures = [];

// The guard is what makes the declarations safe; without it there is nothing to
// route through and every check below is vacuous.
const guard = source.match(/fn rerun_if_changed\(path: &Path, out: &Path\) \{([\s\S]*?)\n\}/);
if (!guard) {
  failures.push(`${script} declares no rerun_if_changed(path, out) guard`);
} else if (!guard[1].includes("path.starts_with(out)")) {
  failures.push(`${script}: rerun_if_changed no longer rejects paths under OUT_DIR`);
}

// Every remaining emission must be a literal. The guard owns the only dynamic
// one, so remove its body before looking.
const outsideGuard = guard ? source.replace(guard[0], "") : source;
for (const [, declared] of outsideGuard.matchAll(/println!\(\s*"cargo:rerun-if-changed=([^"]*)"/g)) {
  if (declared.includes("{")) {
    failures.push(
      `${script} declares an interpolated path directly: "cargo:rerun-if-changed=${declared}" — ` +
        `route it through rerun_if_changed(path, out) so an OUT_DIR path cannot be declared`,
    );
  }
}

// Opportunistic: any build already on disk proves the property directly. A
// checkout that has not built the crate simply contributes no units, which is
// why the source check above carries the guarantee on its own.
const units = [];
for (const target of readdirSync(root, { withFileTypes: true })) {
  if (!target.isDirectory() || !target.name.startsWith("target")) continue;
  for (const profile of readdirSync(join(root, target.name), { withFileTypes: true })) {
    const builds = join(root, target.name, profile.name, "build");
    let entries;
    try {
      entries = readdirSync(builds, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.name.startsWith("ghosttea-vt-sys-")) continue;
      const unit = join(builds, entry.name);
      let emitted;
      try {
        emitted = readFileSync(join(unit, "output"), "utf8");
      } catch {
        continue;
      }
      units.push(unit);
      const out = join(unit, "out");
      for (const [, declared] of emitted.matchAll(/^cargo:rerun-if-changed=(.*)$/gm)) {
        if (declared.startsWith(out)) {
          failures.push(`${unit} declared its own output as an input: ${declared}`);
        }
      }
    }
  }
}

if (failures.length > 0) {
  console.error("A build script's outputs must never be declared as its inputs:\n");
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log(
  `Ghosttea build-script inputs passed (${script} guarded${units.length > 0 ? `, ${units.length} built unit(s) verified` : ""})`,
);
