import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const build = join(root, "native/build/ghosttea-ffi-check");
const fonts = join(root, "native/build/ghosttea-fonts");
const headerDirectory = join(root, "native/terminald/crates/ghosttea-ffi/include");

function run(command, args, extraEnvironment = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    env: { ...process.env, ...extraEnvironment },
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run(process.execPath, [join(root, "scripts/sync-ghosttea-fonts.mjs")]);
mkdirSync(build, { recursive: true });
const headerProbe = join(build, "header-probe.c");
writeFileSync(
  headerProbe,
  [
    '#include "ghosttea.h"',
    '_Static_assert(GHOSTTEA_ABI_VERSION == 1, "unexpected ABI version");',
    '_Static_assert(sizeof(ghosttea_effect_t) == 16, "effect descriptor ABI drift");',
    "int main(void) { return ghosttea_abi_version() == GHOSTTEA_ABI_VERSION ? 0 : 1; }",
    "",
  ].join("\n"),
);
run("clang", ["-std=c11", "-Wall", "-Wextra", "-Werror", "-fsyntax-only", "-I", headerDirectory, headerProbe]);
run("cargo", ["test", "-p", "ghosttea-ffi", "--locked"]);
run("cargo", ["clippy", "-p", "ghosttea-ffi", "--all-targets", "--locked", "--", "-D", "warnings"]);
run("cargo", ["test", "-p", "ghosttea-ffi", "--test", "parity", "--locked", "--", "--ignored"], {
  GHOSTTEA_FONT_DIR: fonts,
});

if (process.platform === "darwin" && process.arch === "arm64") {
  run(
    "cargo",
    [
      "test",
      "-p",
      "ghosttea-ffi",
      "--target",
      "aarch64-apple-darwin",
      "--test",
      "parity",
      "--locked",
      "--",
      "--ignored",
    ],
    {
      CARGO_TARGET_DIR: join(root, "native/build/ghosttea-ffi-asan"),
      GHOSTTEA_FONT_DIR: fonts,
      RUSTC_BOOTSTRAP: "1",
      RUSTFLAGS: "-Zsanitizer=address",
    },
  );
}

console.log("Ghosttea production C ABI ownership, parity, and sanitizer gates passed.");
