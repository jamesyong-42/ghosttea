import { createRequire } from "node:module";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { MARKERS, payloadCatalog } from "../lib/payloads.mjs";
import { measureEventLoopLag, nowMs, summarize } from "../lib/stats.mjs";

const require = createRequire(import.meta.url);

async function ensureNodePtyHelpers() {
  // Make spawn-helper executable; npm sometimes installs it as 0644 → posix_spawnp failed.
  const fixUrl = pathToFileURL(join(import.meta.dirname, "../../scripts/fix-node-pty.mjs")).href;
  await import(fixUrl);
}

function loadXterm() {
  try {
    return require("@xterm/xterm");
  } catch {
    try {
      return require("xterm");
    } catch (error) {
      throw new Error(
        "xterm baseline requires @xterm/xterm. Install with: npm install -D @xterm/xterm",
        { cause: error },
      );
    }
  }
}

function loadNodePty() {
  try {
    return require("node-pty");
  } catch (error) {
    throw new Error("node-pty baseline requires node-pty. Install with: npm install -D node-pty", {
      cause: error,
    });
  }
}

function createTerminal({ cols, rows }, XTerm) {
  return new XTerm.Terminal({
    cols,
    rows,
    allowProposedApi: true,
    scrollback: 10_000,
    convertEol: true,
  });
}

function writeAll(terminal, payload) {
  return new Promise((resolve) => {
    terminal.write(payload, () => resolve());
  });
}

function spawnShell(pty, { cols, rows, cwd = process.cwd() } = {}) {
  const shellCandidates = ["/bin/zsh", "/bin/bash", "/bin/sh", process.env.SHELL].filter(Boolean);
  let lastError;
  for (const shell of shellCandidates) {
    try {
      return pty.spawn(shell, [], {
        name: "xterm-256color",
        cols,
        rows,
        cwd,
        env: {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          HOME: process.env.HOME,
          TERM: "xterm-256color",
          LANG: process.env.LANG ?? "en_US.UTF-8",
        },
      });
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError ?? new Error("node-pty spawn failed for all shells");
}

/**
 * Full embed path: node-pty shell → cat payload → xterm.write(onData).
 * This is the fair comparison against terminald's PTY session path.
 */
async function ptyPayloadToMarker({ cols, rows, payload, marker }, XTerm, pty) {
  const terminal = createTerminal({ cols, rows }, XTerm);
  const tmp = mkdtempSync(join(tmpdir(), "eg-xterm-pty-"));
  const file = join(tmp, "payload.bin");
  writeFileSync(file, payload);

  try {
    const child = spawnShell(pty, { cols, rows, cwd: tmp });
    let buffer = "";
    let bytesOut = 0;
    let chunks = 0;
    const lagSamples = [];

    const markerSeen = new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error(`node-pty+xterm timeout waiting for ${marker}`)),
        90_000,
      );
      child.onData((data) => {
        chunks += 1;
        bytesOut += typeof data === "string" ? Buffer.byteLength(data) : data.byteLength;
        buffer += data;
        // Keep only a tail for marker search to avoid O(n²) string growth.
        if (buffer.length > marker.length + 64 * 1024) {
          buffer = buffer.slice(-(marker.length + 32 * 1024));
        }
        const writeStart = nowMs();
        terminal.write(data, () => {
          lagSamples.push(nowMs() - writeStart);
        });
        if (buffer.includes(marker)) {
          clearTimeout(timeout);
          resolve();
        }
      });
      child.onExit(({ exitCode }) => {
        if (!buffer.includes(marker)) {
          clearTimeout(timeout);
          reject(new Error(`pty exited (${exitCode}) before marker ${marker}`));
        }
      });
    });

    const quoted = `'${file.replaceAll("'", `'\\''`)}'`;
    const started = nowMs();
    child.write(`cat ${quoted}; printf '\\n'; exit\r`);
    await markerSeen;
    const ms = nowMs() - started;

    try {
      child.kill();
    } catch {
      // ignore
    }
    terminal.dispose();
    return {
      ms,
      bytesIn: payload.byteLength,
      bytesOut,
      chunks,
      writeLag: summarize(lagSamples),
      path: "node-pty→xterm",
    };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * Concurrent PTY sessions each feeding their own xterm Terminal.
 */
async function multiPtyFlood({ sessions, cols, rows, payload, marker }, XTerm, pty) {
  const tmp = mkdtempSync(join(tmpdir(), "eg-xterm-multi-"));
  const file = join(tmp, "payload.bin");
  writeFileSync(file, payload);
  const quoted = `'${file.replaceAll("'", `'\\''`)}'`;
  const terminals = [];
  const children = [];

  try {
    for (let index = 0; index < sessions; index += 1) {
      terminals.push(createTerminal({ cols, rows }, XTerm));
      children.push(spawnShell(pty, { cols, rows, cwd: tmp }));
    }

    const started = nowMs();
    const waits = children.map((child, index) => {
      const terminal = terminals[index];
      let buffer = "";
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error(`multi pty timeout on session ${index}`)),
          120_000,
        );
        child.onData((data) => {
          buffer += data;
          if (buffer.length > marker.length + 64 * 1024) {
            buffer = buffer.slice(-(marker.length + 32 * 1024));
          }
          terminal.write(data);
          if (buffer.includes(marker)) {
            clearTimeout(timeout);
            resolve();
          }
        });
        child.onExit(({ exitCode }) => {
          if (!buffer.includes(marker)) {
            clearTimeout(timeout);
            reject(new Error(`multi pty ${index} exited (${exitCode}) early`));
          }
        });
        child.write(`cat ${quoted}; printf '\\n'; exit\r`);
      });
    });

    await Promise.all(waits);
    const ms = nowMs() - started;
    return { sessions, ms, bytesIn: payload.byteLength * sessions, path: "node-pty→xterm" };
  } finally {
    for (const child of children) {
      try {
        child.kill();
      } catch {
        // ignore
      }
    }
    for (const terminal of terminals) terminal.dispose();
    rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * Control-plane analogue: event-loop lag while node-pty is flooding xterm.
 */
async function eventLoopUnderPtyFlood({ cols, rows }, XTerm, pty) {
  const terminal = createTerminal({ cols, rows }, XTerm);
  const child = spawnShell(pty, { cols, rows });
  // Continuous flood.
  child.write(`while true; do printf 'flood-%s\\n' "$$"; done\r`);

  // Let the flood warm up.
  await new Promise((resolve) => setTimeout(resolve, 150));
  child.onData((data) => {
    terminal.write(data);
  });

  const samples = [];
  for (let index = 0; index < 40; index += 1) {
    samples.push(await measureEventLoopLag(0));
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  try {
    child.kill();
  } catch {
    // ignore
  }
  terminal.dispose();
  return summarize(samples);
}

async function parsePayload(terminal, payload) {
  const started = nowMs();
  await writeAll(terminal, payload);
  return { ms: nowMs() - started, bytesIn: payload.byteLength, path: "xterm-write-only" };
}

export async function runXtermBench({ scale = 1, cols = 120, rows = 40, withPty = true } = {}) {
  await ensureNodePtyHelpers();
  const XTerm = loadXterm();
  const payloads = payloadCatalog(scale);
  const results = {
    target: "node-pty+xterm",
    cases: {},
  };

  if (withPty) {
    const pty = loadNodePty();
    // Sanity: if spawn still fails, fail loudly with fix instructions.
    try {
      const probe = spawnShell(pty, { cols: 40, rows: 10 });
      probe.kill();
    } catch (error) {
      throw new Error(
        `node-pty spawn failed (${error instanceof Error ? error.message : error}). ` +
          `Try: node scripts/fix-node-pty.mjs && chmod +x node_modules/node-pty/prebuilds/*/spawn-helper`,
        { cause: error },
      );
    }

    console.error("[bench:xterm] node-pty→xterm dense…");
    results.cases.ptyDense = await ptyPayloadToMarker(
      { cols, rows, payload: payloads.dense, marker: MARKERS.denseDone },
      XTerm,
      pty,
    );

    console.error("[bench:xterm] node-pty→xterm scrolling…");
    results.cases.ptyScrolling = await ptyPayloadToMarker(
      { cols, rows, payload: payloads.scrolling, marker: MARKERS.floodDone },
      XTerm,
      pty,
    );

    console.error("[bench:xterm] node-pty→xterm unicode…");
    results.cases.ptyUnicode = await ptyPayloadToMarker(
      { cols, rows, payload: payloads.unicode, marker: MARKERS.unicodeDone },
      XTerm,
      pty,
    );

    console.error("[bench:xterm] node-pty→xterm scroll-region…");
    results.cases.ptyScrollRegion = await ptyPayloadToMarker(
      { cols, rows, payload: payloads.scrollRegion, marker: MARKERS.scrollDone },
      XTerm,
      pty,
    );

    console.error("[bench:xterm] event-loop lag under node-pty flood…");
    results.cases.eventLoopUnderPtyFlood = await eventLoopUnderPtyFlood({ cols, rows }, XTerm, pty);

    console.error("[bench:xterm] multi node-pty→xterm…");
    results.cases.multiPty = await multiPtyFlood(
      {
        sessions: Math.max(2, Math.round(4 * scale)),
        cols,
        rows,
        payload: payloads.scrolling,
        marker: MARKERS.floodDone,
      },
      XTerm,
      pty,
    );
  }

  // Secondary: pure parse (no PTY) for decomposition.
  console.error("[bench:xterm] pure write/parse scrolling (decomposition)…");
  {
    const terminal = createTerminal({ cols, rows }, XTerm);
    results.cases.scrollingParse = await parsePayload(terminal, payloads.scrolling);
    terminal.dispose();
  }

  console.error("[bench:xterm] pure write/parse dense (decomposition)…");
  {
    const terminal = createTerminal({ cols, rows }, XTerm);
    results.cases.denseParse = await parsePayload(terminal, payloads.dense);
    terminal.dispose();
  }

  results.markers = MARKERS;
  return results;
}
