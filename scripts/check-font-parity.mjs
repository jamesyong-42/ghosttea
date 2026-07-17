import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const fontDirectory = join(root, "native/build/ghosttea-fonts");
const expectedPath = join(root, "native/terminald/fixtures/phase2/font-parity.json");

const result = spawnSync(
  "cargo",
  [
    "run",
    "--quiet",
    "-p",
    "ghosttea-text",
    "--features",
    "fixture",
    "--example",
    "shaping_fixture",
    "--",
    fontDirectory,
  ],
  { cwd: root, encoding: "utf8" },
);
if (result.error) throw result.error;
if (result.status !== 0) throw new Error(result.stderr || "font fixture generator failed");

const expected = JSON.parse(readFileSync(expectedPath, "utf8"));
const actual = JSON.parse(result.stdout);
assert.deepEqual(actual, expected, "locked font shaping or glyph bitmap fixture changed");
console.log("Ghosttea locked font parity fixture passed");
