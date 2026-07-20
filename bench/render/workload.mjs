#!/usr/bin/env node
import { closeSync, openSync, readSync, statSync, writeFileSync } from "node:fs";

const [path, chunkArgument = "8192", intervalArgument = "8", chunkSequenceArgument = "", completionPath = ""] =
  process.argv.slice(2);
if (!path) throw new Error("Usage: workload.mjs payload-path [chunk-bytes] [interval-ms] [chunk-byte-sequence]");
const chunkBytes = Math.max(1, Number(chunkArgument));
const intervalMs = Math.max(0, Number(intervalArgument));
if (!Number.isSafeInteger(chunkBytes) || !Number.isFinite(intervalMs)) throw new Error("Invalid workload pacing");
const chunkByteSequence = chunkSequenceArgument
  ? chunkSequenceArgument.split(",").map((value) => Number(value))
  : undefined;
if (chunkByteSequence?.some((value) => !Number.isSafeInteger(value) || value <= 0)) {
  throw new Error("Invalid workload chunk byte sequence");
}

async function waitForGate() {
  process.stdin.resume();
  await new Promise((resolve) => process.stdin.once("data", resolve));
  process.stdin.pause();
}

async function write(bytes) {
  if (process.stdout.write(bytes)) return;
  await new Promise((resolve) => process.stdout.once("drain", resolve));
}

async function main() {
  await waitForGate();
  const startedAt = Date.now();
  const started = performance.now();
  const file = openSync(path, "r");
  const length = statSync(path).size;
  if (chunkByteSequence && chunkByteSequence.reduce((total, value) => total + value, 0) !== length) {
    throw new Error("Workload chunk byte sequence does not match payload length");
  }
  const largestChunk = chunkByteSequence ? Math.max(...chunkByteSequence) : chunkBytes;
  const buffer = Buffer.allocUnsafe(Math.min(largestChunk, Math.max(1, length)));
  try {
    let offset = 0;
    let chunkIndex = 0;
    let deadline = performance.now();
    let chunks = 0;
    let stdoutBackpressureMs = 0;
    while (offset < length) {
      const target = chunkByteSequence?.[chunkIndex] ?? Math.min(buffer.length, length - offset);
      let filled = 0;
      while (filled < target) {
        const read = readSync(file, buffer, filled, target - filled, offset + filled);
        if (read === 0) break;
        filled += read;
      }
      if (filled === 0) break;
      const writeStarted = performance.now();
      await write(buffer.subarray(0, filled));
      stdoutBackpressureMs += performance.now() - writeStarted;
      offset += filled;
      chunkIndex += 1;
      chunks += 1;
      deadline += intervalMs;
      const remaining = deadline - performance.now();
      if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
    }
    if (completionPath) {
      writeFileSync(
        completionPath,
        `${JSON.stringify({
          schemaVersion: 1,
          payloadBytes: length,
          chunks,
          startedAt,
          completedAt: Date.now(),
          durationMs: performance.now() - started,
          stdoutBackpressureMs,
        })}\n`,
      );
    }
  } finally {
    closeSync(file);
  }
}

await main();
