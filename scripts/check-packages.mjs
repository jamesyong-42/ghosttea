import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

const npmPackages = ["@vibecook/ghosttea-protocol", "@vibecook/ghosttea-frame", "@vibecook/ghosttea"];

const rustPackages = ["ghosttea-text", "ghosttea-vt", "ghosttea"];

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
    const [packed] = JSON.parse(output);
    if (!packed || packed.name !== workspace) throw new Error(`npm packed the wrong workspace for ${workspace}`);
    const paths = new Set(packed.files.map((file) => file.path));
    for (const required of ["LICENSE", "README.md", "dist/index.js", "dist/index.d.ts", "package.json"]) {
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
      'if (typeof ControlClient !== "function" || FRAME_MAGIC !== 0x31465254 || PROTOCOL_MAJOR !== 1) {',
      '  throw new Error("installed Ghosttea packages expose an invalid runtime API");',
      "}",
      'console.log("external npm consumer fixture passed");',
      "",
    ].join("\n"),
  );
  run("npm", ["install", "--ignore-scripts", "--offline", "--no-audit", "--no-fund", "--cache", cache], {
    cwd: fixture,
  });
  process.stdout.write(run(process.execPath, ["smoke.mjs"], { cwd: fixture }) + "\n");

  for (const crate of rustPackages) {
    const files = new Set(run("cargo", ["package", "--list", "--allow-dirty", "--package", crate]).split("\n"));
    for (const required of ["Cargo.toml", "LICENSE", "README.md"]) {
      if (!files.has(required)) throw new Error(`${crate} package is missing ${required}`);
    }
  }
  console.log("Ghosttea package layouts passed");
} finally {
  rmSync(fixture, { recursive: true, force: true });
}
