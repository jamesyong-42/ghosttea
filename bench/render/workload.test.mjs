import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { sparseRowPayload, visualFixturePayload } from "../lib/payloads.mjs";

test("sparse row payload emits one fixed-size cursor update per frame", () => {
  const payload = sparseRowPayload({ frames: 3, row: 10, width: 100 });
  assert.equal(payload.byteLength, 3 * 107);
  assert.equal(payload.toString("utf8").split("\u001b[10;1H").length - 1, 3);
});

test("visual fixture preserves renderer features around sparse updates", () => {
  const payload = visualFixturePayload({ frames: 2, row: 10, width: 100 }).toString("utf8");
  assert.match(payload, /╭─+/);
  assert.match(payload, /░▒▓ █ ▄▀▐/);
  assert.match(payload, /日本語 e\u0301 😀/);
  assert.equal(payload.split("\u001b[10;1H").length - 1, 2);
});

test("paced workload waits for its gate and reproduces payload bytes exactly", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ghosttea-render-workload-test-"));
  const path = join(directory, "payload.bin");
  const payload = Buffer.from("first\n\u001b[31msecond\u001b[0m\n日本語\n", "utf8");
  writeFileSync(path, payload);
  try {
    const child = spawn(process.execPath, [join(import.meta.dirname, "workload.mjs"), path, "3", "1"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    const chunks = [];
    child.stdout.on("data", (chunk) => chunks.push(chunk));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(chunks.length, 0);
    child.stdin.end("go\n");
    const exitCode = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", resolve);
    });
    assert.equal(exitCode, 0);
    assert.deepEqual(Buffer.concat(chunks), payload);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
