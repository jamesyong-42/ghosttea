import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MARKERS, payloadCatalog } from "../lib/payloads.mjs";
import { nowMs, summarize } from "../lib/stats.mjs";
import { TerminaldHarness } from "../lib/terminald-client.mjs";

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

/**
 * Feed a payload by writing a temp file and cat'ing it inside the PTY.
 * This exercises real PTY + parser + shape + frame encode.
 */
async function runPayloadThroughPty(harness, payload, marker, { cols, rows }) {
  const dir = mkdtempSync(join(tmpdir(), "eg-bench-payload-"));
  const file = join(dir, "payload.bin");
  try {
    writeFileSync(file, payload);
    const session = await harness.createAttachedSession({ cols, rows });
    // Drain any startup frames so marker wait is clean.
    await harness.sampleDuring(50);
    const started = nowMs();
    const waitPromise = harness.waitForMarker(session.handle, marker, { timeoutMs: 60_000 });
    await harness.sendText(session.id, `cat ${shellQuote(file)}; printf '\\n'\r`);
    const wait = await waitPromise;
    const totalMs = nowMs() - started;
    await harness.terminate(session.id);
    return {
      bytesIn: payload.byteLength,
      ms: totalMs,
      markerMs: wait.ms,
      frames: wait.frames,
      frameBytes: wait.bytes,
      sequenceGaps: wait.sequenceGaps,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function controlRttUnderFlood(harness, { cols, rows, samples = 40 }) {
  const session = await harness.createAttachedSession({ cols, rows });
  // Continuous flood that lasts long enough for RTT samples.
  await harness.sendText(session.id, `i=0; while [ $i -lt 200000 ]; do printf 'flood-%s\\n' "$i"; i=$((i+1)); done\r`);
  // Warm a bit so the flood is actually running.
  await harness.sampleDuring(100);
  const rtts = [];
  for (let index = 0; index < samples; index += 1) {
    const start = nowMs();
    await harness.request("get-session", { sessionId: session.id });
    rtts.push(nowMs() - start);
  }
  await harness.interrupt(session.id);
  await harness.terminate(session.id);
  return summarize(rtts);
}

async function interruptUnderFlood(harness, { cols, rows, iterations = 12 }) {
  // Measure control-plane latency for interrupt while a shell flood is in flight.
  // (End-to-end SIGINT semantics vary by line discipline; the product-critical
  // property is that interrupt is not blocked behind frame generation.)
  const session = await harness.createAttachedSession({ cols, rows });
  await harness.sendText(session.id, `i=0; while [ $i -lt 500000 ]; do printf 'flood-%s\\n' "$i"; i=$((i+1)); done\r`);
  await harness.sampleDuring(150);
  const samples = [];
  for (let index = 0; index < iterations; index += 1) {
    const start = nowMs();
    await harness.interrupt(session.id);
    samples.push(nowMs() - start);
  }
  await harness.terminate(session.id);
  return summarize(samples);
}

async function multiSessionFlood(harness, { sessions = 8, cols, rows, payload }) {
  const dir = mkdtempSync(join(tmpdir(), "eg-bench-multi-"));
  const file = join(dir, "payload.bin");
  writeFileSync(file, payload);
  const created = [];
  try {
    for (let index = 0; index < sessions; index += 1) {
      created.push(await harness.createAttachedSession({ cols, rows }));
    }
    // Start all waits before kicking cats so demux subscribers are armed.
    const started = nowMs();
    const waits = created.map((session) =>
      harness.waitForMarker(session.handle, MARKERS.floodDone, { timeoutMs: 120_000 }),
    );
    await Promise.all(created.map((session) => harness.sendText(session.id, `cat ${shellQuote(file)}\r`)));
    await Promise.all(waits);
    const ms = nowMs() - started;
    for (const session of created) {
      await harness.terminate(session.id);
    }
    return { sessions, ms, bytesIn: payload.byteLength * sessions };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export async function runTerminaldBench({ scale = 1, cols = 120, rows = 40 } = {}) {
  const payloads = payloadCatalog(scale);
  const harness = await TerminaldHarness.start();
  const results = {
    target: "terminald",
    binary: process.env.GHOSTTEAD_BIN ?? process.env.TERMINALD_BIN ?? "auto",
    cases: {},
  };

  try {
    console.error("[bench:terminald] dense cells…");
    results.cases.dense = await runPayloadThroughPty(harness, payloads.dense, MARKERS.denseDone, {
      cols,
      rows,
    });

    console.error("[bench:terminald] scrolling flood…");
    results.cases.scrolling = await runPayloadThroughPty(harness, payloads.scrolling, MARKERS.floodDone, {
      cols,
      rows,
    });

    console.error("[bench:terminald] unicode…");
    results.cases.unicode = await runPayloadThroughPty(harness, payloads.unicode, MARKERS.unicodeDone, { cols, rows });

    console.error("[bench:terminald] scroll-region redraws…");
    results.cases.scrollRegion = await runPayloadThroughPty(harness, payloads.scrollRegion, MARKERS.scrollDone, {
      cols,
      rows,
    });

    console.error("[bench:terminald] control RTT under flood…");
    results.cases.controlRttUnderFlood = await controlRttUnderFlood(harness, { cols, rows });

    console.error("[bench:terminald] interrupt under flood…");
    results.cases.interruptUnderFlood = await interruptUnderFlood(harness, { cols, rows });

    console.error("[bench:terminald] multi-session flood…");
    results.cases.multiSession = await multiSessionFlood(harness, {
      sessions: Math.max(2, Math.round(4 * scale)),
      cols,
      rows,
      payload: payloads.scrolling,
    });

    return results;
  } finally {
    harness.dispose();
  }
}
