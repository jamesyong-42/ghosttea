import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { doomFirePayload, sparseRowPayload, visualFixturePayload } from "../lib/payloads.mjs";

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

test("DOOM fire payload is finite, frame-paced, and deterministic", () => {
  const first = doomFirePayload({ frames: 3, rows: 4, cols: 8, seed: 42 });
  const repeated = doomFirePayload({ frames: 3, rows: 4, cols: 8, seed: 42 });
  const different = doomFirePayload({ frames: 3, rows: 4, cols: 8, seed: 43 });
  assert.deepEqual(first.frameByteLengths, repeated.frameByteLengths);
  assert.deepEqual(first.payload, repeated.payload);
  assert.equal(
    first.frameByteLengths.reduce((total, value) => total + value, 0),
    first.payload.byteLength,
  );
  assert.equal(first.payload.toString("utf8").split("\u001b[H").length - 1, 3);
  assert.equal(first.payload.toString("utf8").split("▀").length - 1, 3 * 4 * 8);
  assert.match(first.payload.toString("utf8"), /38;2;\d+;\d+;\d+m/);
  assert.match(first.payload.toString("utf8"), /48;2;\d+;\d+;\d+m/);
  assert.equal(first.payload.equals(different.payload), false);
});

test("paced workload waits for its gate and reproduces payload bytes exactly", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ghosttea-render-workload-test-"));
  const path = join(directory, "payload.bin");
  const payload = Buffer.from("first\n\u001b[31msecond\u001b[0m\n日本語\n", "utf8");
  writeFileSync(path, payload);
  try {
    const chunkSequence = [2, 5, payload.byteLength - 7].join(",");
    const child = spawn(
      process.execPath,
      [join(import.meta.dirname, "workload.mjs"), path, String(payload.byteLength), "1", chunkSequence],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
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

test("external terminal workload reports producer metrics and exact fire frames", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ghosttea-external-terminal-test-"));
  const metricsPath = join(directory, "metrics.json");
  const readyPath = join(directory, "ready.json");
  const gatePath = join(directory, "go");
  try {
    const child = spawn(
      process.execPath,
      [join(import.meta.dirname, "external-terminal-workload.mjs"), metricsPath, readyPath, gatePath, "2", "0"],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    const chunks = [];
    child.stdout.on("data", (chunk) => chunks.push(chunk));
    const deadline = performance.now() + 2_000;
    while (!existsSync(readyPath) && performance.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(existsSync(readyPath), true);
    assert.equal(chunks.length, 0);
    writeFileSync(gatePath, "go\n");
    const exitCode = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", resolve);
    });
    assert.equal(exitCode, 0);

    const expected = doomFirePayload({ frames: 2, rows: 39, cols: 120 });
    assert.deepEqual(Buffer.concat(chunks), expected.payload);
    const metrics = JSON.parse(readFileSync(metricsPath, "utf8"));
    assert.equal(metrics.frames, 2);
    assert.equal(metrics.payloadBytes, expected.payload.byteLength);
    assert.equal(Number.isSafeInteger(metrics.blockedWrites), true);
    assert.equal(Number.isFinite(metrics.drainWaitMs), true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
