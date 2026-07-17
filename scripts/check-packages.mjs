import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const fixture = mkdtempSync(join(tmpdir(), "ghosttea-package-check-"));
const cache = join(fixture, "npm-cache");

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    ...options,
  }).trim();
}

const npmPackages = [
  "@vibecook/ghosttea-protocol",
  "@vibecook/ghosttea-frame",
  "@vibecook/ghosttea",
  "@vibecook/ghosttea-electron",
  "@vibecook/ghosttea-react",
];

const rustPackages = ["ghosttea-vt-sys", "ghosttea-text", "ghosttea-vt", "ghosttea"];
const publishableRustLeaves = ["ghosttea-vt-sys", "ghosttea-text"];
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
const nativeArtifact = JSON.parse(
  readFileSync(join(root, "native/terminald/crates/ghostty-vt-sys/artifacts.json"), "utf8"),
).targets["aarch64-apple-darwin"];

try {
  const tarballs = new Map();
  for (const workspace of npmPackages) {
    const output = run("npm", [
      "pack",
      "--json",
      "--cache",
      cache,
      "--pack-destination",
      fixture,
      "--workspace",
      workspace,
    ]);
    const packResult = JSON.parse(output);
    const packed = Array.isArray(packResult) ? packResult[0] : packResult.name ? packResult : packResult[workspace];
    if (!packed || packed.name !== workspace) throw new Error(`npm packed the wrong workspace for ${workspace}`);
    const paths = new Set(packed.files.map((file) => file.path));
    for (const required of ["LICENSE", "README.md", "dist/index.js", "dist/index.d.ts", "package.json"]) {
      if (!paths.has(required)) throw new Error(`${workspace} tarball is missing ${required}`);
    }
    const packageSpecific =
      workspace === "@vibecook/ghosttea-electron"
        ? [
            "dist/main.js",
            "dist/main.d.ts",
            "dist/preload.js",
            "dist/types.js",
            "dist/automation.js",
            "dist/automation.d.ts",
            "dist/bridge-entry.js",
          ]
        : workspace === "@vibecook/ghosttea-react"
          ? [
              "dist/styles.css",
              "dist/workspace.css",
              "dist/workspace/index.js",
              "dist/workspace/index.d.ts",
              "dist/terminal-render.worker.js",
            ]
          : [];
    for (const required of packageSpecific) {
      if (!paths.has(required)) throw new Error(`${workspace} tarball is missing ${required}`);
    }
    if ([...paths].some((path) => path.startsWith("src/") || path.includes(".test."))) {
      throw new Error(`${workspace} tarball contains source or test files`);
    }
    tarballs.set(workspace, join(fixture, packed.filename));
  }

  writeFileSync(
    join(fixture, "package.json"),
    JSON.stringify(
      {
        name: "ghosttea-external-consumer-fixture",
        private: true,
        type: "module",
        dependencies: Object.fromEntries([...tarballs].map(([name, tarball]) => [name, `file:./${basename(tarball)}`])),
      },
      null,
      2,
    ),
  );
  writeFileSync(
    join(fixture, "smoke.mjs"),
    [
      'import { ControlClient } from "@vibecook/ghosttea";',
      'import { FRAME_MAGIC } from "@vibecook/ghosttea-frame";',
      'import { PROTOCOL_MAJOR } from "@vibecook/ghosttea-protocol";',
      'import { GhostteaAutomationClient } from "@vibecook/ghosttea-electron/automation";',
      'import { existsSync, readFileSync } from "node:fs";',
      'import { join } from "node:path";',
      'if (typeof ControlClient !== "function" || typeof GhostteaAutomationClient !== "function" || FRAME_MAGIC !== 0x31465254 || PROTOCOL_MAJOR !== 1) {',
      '  throw new Error("installed Ghosttea packages expose an invalid runtime API");',
      "}",
      'for (const file of ["@vibecook/ghosttea-electron/dist/bridge-entry.js", "@vibecook/ghosttea-react/dist/terminal-render.worker.js"]) {',
      '  if (!existsSync(join("node_modules", file))) throw new Error(`installed Ghosttea package is missing ${file}`);',
      "}",
      'const worker = readFileSync(join("node_modules", "@vibecook/ghosttea-react/dist/terminal-render.worker.js"), "utf8");',
      'if (/^\\s*import\\s/m.test(worker)) throw new Error("Ghosttea render worker is not a self-contained browser artifact");',
      'console.log("external npm consumer fixture passed");',
      "",
    ].join("\n"),
  );
  run(
    "npm",
    ["install", "--ignore-scripts", "--legacy-peer-deps", "--offline", "--no-audit", "--no-fund", "--cache", cache],
    { cwd: fixture },
  );
  process.stdout.write(run(process.execPath, ["smoke.mjs"], { cwd: fixture }) + "\n");

  for (const crate of rustPackages) {
    const files = new Set(
      run("cargo", ["package", "--list", "--allow-dirty", "--offline", "--package", crate]).split("\n"),
    );
    for (const required of ["Cargo.toml", "LICENSE", "README.md"]) {
      if (!files.has(required)) throw new Error(`${crate} package is missing ${required}`);
    }
    if (crate === "ghosttea-vt-sys") {
      for (const required of ["artifacts.json", "build.rs", "src/ghostty_shim.c", "src/ghostty_shim.h"]) {
        if (!files.has(required)) throw new Error(`${crate} package is missing ${required}`);
      }
    }
    if (crate === "ghosttea-vt" && [...files].some((file) => file.endsWith(".c") || file === "build.rs")) {
      throw new Error("ghosttea-vt package still owns native build implementation");
    }
  }

  const rustCrates = join(fixture, "rust-crates");
  mkdirSync(rustCrates);
  for (const crate of publishableRustLeaves) {
    run("cargo", ["package", "--allow-dirty", "--no-verify", "--offline", "--package", crate]);
    run("tar", ["-xzf", join(root, `target/package/${crate}-${version}.crate`), "-C", rustCrates]);
  }

  const rustConsumer = join(fixture, "rust-consumer");
  mkdirSync(join(rustConsumer, "src"), { recursive: true });
  const cratePath = (name) => join(rustCrates, `${name}-${version}`).replaceAll("\\", "/");
  writeFileSync(
    join(rustConsumer, "Cargo.toml"),
    [
      "[package]",
      'name = "ghosttea-external-consumer"',
      'version = "0.0.0"',
      'edition = "2024"',
      'rust-version = "1.85"',
      "",
      "[dependencies]",
      `ghosttea-vt-sys = { path = ${JSON.stringify(cratePath("ghosttea-vt-sys"))} }`,
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(rustConsumer, "src/main.rs"),
    [
      "fn main() {",
      "    let _native_link_contract = std::any::TypeId::of::<ghosttea_vt_sys::LinkContract>();",
      "}",
      "",
    ].join("\n"),
  );
  run("cargo", ["build", "--offline"], {
    cwd: rustConsumer,
    env: {
      ...process.env,
      CARGO_TARGET_DIR: join(fixture, "rust-target"),
      GHOSTTEA_GHOSTTY_VT_BUNDLE: join(root, "artifacts/ghostty-vt", nativeArtifact.filename),
    },
  });
  console.log("external Rust consumer fixture passed");
  console.log("Ghosttea package layouts passed");
} finally {
  rmSync(fixture, { recursive: true, force: true });
}
