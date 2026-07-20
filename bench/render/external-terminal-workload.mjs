#!/usr/bin/env node
import { existsSync, writeFileSync } from "node:fs";
import { doomFirePayload } from "../lib/payloads.mjs";

const [metricsPath, readyPath, gatePath, framesArgument = "180", intervalArgument = "16"] = process.argv.slice(2);
if (!metricsPath || !readyPath || !gatePath) {
  throw new Error("Usage: external-terminal-workload.mjs metrics-path ready-path gate-path [frames] [interval-ms]");
}

const frames = Number(framesArgument);
const intervalMs = Number(intervalArgument);
if (!Number.isSafeInteger(frames) || frames <= 0 || !Number.isFinite(intervalMs) || intervalMs < 0) {
  throw new Error("Invalid external terminal workload configuration");
}

const workload = doomFirePayload({ frames, rows: 39, cols: 120 });
writeFileSync(readyPath, `${JSON.stringify({ payloadBytes: workload.payload.byteLength, frames })}\n`);
while (!existsSync(gatePath)) await new Promise((resolve) => setTimeout(resolve, 10));

let offset = 0;
let blockedWrites = 0;
let drainWaitMs = 0;
let deadline = performance.now();
const startedAt = performance.now();
for (const frameBytes of workload.frameByteLengths) {
  const frame = workload.payload.subarray(offset, offset + frameBytes);
  const writeStartedAt = performance.now();
  if (!process.stdout.write(frame)) {
    blockedWrites += 1;
    await new Promise((resolve) => process.stdout.once("drain", resolve));
    drainWaitMs += performance.now() - writeStartedAt;
  }
  offset += frameBytes;
  deadline += intervalMs;
  const remaining = deadline - performance.now();
  if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
}
const elapsedMs = performance.now() - startedAt;

writeFileSync(
  metricsPath,
  `${JSON.stringify(
    {
      frames,
      payloadBytes: workload.payload.byteLength,
      elapsedMs,
      effectiveProducerFps: (frames * 1_000) / elapsedMs,
      blockedWrites,
      drainWaitMs,
      tty: { columns: process.stdout.columns ?? null, rows: process.stdout.rows ?? null },
    },
    null,
    2,
  )}\n`,
);
