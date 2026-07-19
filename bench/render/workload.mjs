#!/usr/bin/env node
import { closeSync, openSync, readSync, statSync } from "node:fs";

const [path, chunkArgument = "8192", intervalArgument = "8"] = process.argv.slice(2);
if (!path) throw new Error("Usage: workload.mjs payload-path [chunk-bytes] [interval-ms]");
const chunkBytes = Math.max(1, Number(chunkArgument));
const intervalMs = Math.max(0, Number(intervalArgument));
if (!Number.isSafeInteger(chunkBytes) || !Number.isFinite(intervalMs)) throw new Error("Invalid workload pacing");

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
  const file = openSync(path, "r");
  const length = statSync(path).size;
  const buffer = Buffer.allocUnsafe(Math.min(chunkBytes, Math.max(1, length)));
  try {
    let offset = 0;
    let deadline = performance.now();
    while (offset < length) {
      const read = readSync(file, buffer, 0, Math.min(buffer.length, length - offset), offset);
      if (read === 0) break;
      await write(buffer.subarray(0, read));
      offset += read;
      deadline += intervalMs;
      const remaining = deadline - performance.now();
      if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
    }
  } finally {
    closeSync(file);
  }
}

await main();
