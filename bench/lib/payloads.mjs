/**
 * Synthetic VT payloads shared across terminald / xterm targets.
 * Markers are ASCII so they survive both binary frames and xterm buffer dumps.
 */

const RESET = "\u001b[0m";
const CLEAR = "\u001b[2J\u001b[H";

export const MARKERS = {
  floodDone: "BENCH_FLOOD_DONE",
  denseDone: "BENCH_DENSE_DONE",
  unicodeDone: "BENCH_UNICODE_DONE",
  scrollDone: "BENCH_SCROLL_DONE",
  interruptReady: "BENCH_INTERRUPT_READY",
  interruptAck: "BENCH_INTERRUPT_ACK",
};

/** Dense SGR-colored cells, similar in spirit to vtebench dense_cells. */
export function denseCellsPayload({ rows = 40, cols = 120, passes = 40 } = {}) {
  const lines = [];
  for (let pass = 0; pass < passes; pass += 1) {
    for (let row = 0; row < rows; row += 1) {
      let line = "";
      for (let col = 0; col < cols; col += 1) {
        const fg = 30 + ((row + col + pass) % 8);
        const bg = 40 + ((row + col + pass * 3) % 8);
        const ch = String.fromCharCode(33 + ((row * cols + col + pass) % 94));
        line += `\u001b[${fg};${bg}m${ch}`;
      }
      lines.push(`${line}${RESET}`);
    }
  }
  lines.push(MARKERS.denseDone);
  return Buffer.from(`${CLEAR}${lines.join("\n")}\n`, "utf8");
}

/** Long scrolling plain-text flood (cat-like). */
export function scrollingPayload({ lines = 20_000, width = 80 } = {}) {
  const chunks = [];
  for (let index = 0; index < lines; index += 1) {
    const body = `flood-line-${String(index).padStart(6, "0")}-${"x".repeat(Math.max(0, width - 20))}`;
    chunks.push(body.slice(0, width));
  }
  chunks.push(MARKERS.floodDone);
  return Buffer.from(`${chunks.join("\n")}\n`, "utf8");
}

/** Unicode / wide / combining-ish mix. */
export function unicodePayload({ lines = 4_000 } = {}) {
  const samples = ["日本語", "한글", "😀", "e\u0301", "世界", "∑", "αβγ", "👨‍💻", "ffi", "→"];
  const chunks = [];
  for (let index = 0; index < lines; index += 1) {
    const cell = samples[index % samples.length];
    chunks.push(`u-${index} ${cell} ${cell}${cell}`);
  }
  chunks.push(MARKERS.unicodeDone);
  return Buffer.from(`${chunks.join("\n")}\n`, "utf8");
}

/** Repeatedly replaces one fixed row without scrolling the viewport. */
export function sparseRowPayload({ frames = 180, row = 10, width = 100 } = {}) {
  const cursor = `\u001b[${row};1H`;
  const chunks = [];
  for (let frame = 0; frame < frames; frame += 1) {
    const prefix = `sparse-${String(frame).padStart(6, "0")}-`;
    chunks.push(`${cursor}${prefix}${"x".repeat(Math.max(0, width - prefix.length))}`);
  }
  return Buffer.from(chunks.join(""), "utf8");
}

/** Static renderer features kept on screen while one distant row is replaced. */
export function visualFixturePayload({ frames = 60, row = 10, width = 100 } = {}) {
  const fixture = [
    CLEAR,
    "\u001b[2;3H\u001b[31;44m╭────────────╮\u001b[0m",
    "\u001b[3;3H\u001b[32;45m│ ░▒▓ █ ▄▀▐ │\u001b[0m",
    "\u001b[4;3H\u001b[33;46m╰────────────╯\u001b[0m",
    "\u001b[6;3H日本語 e\u0301 😀 👨‍💻 ffi →",
    "\u001b[8;3H\u001b[1;3;4;9;38;5;208mstyled decorations\u001b[0m",
  ].join("");
  return Buffer.concat([Buffer.from(fixture, "utf8"), sparseRowPayload({ frames, row, width })]);
}

/** Alternate-screen style full redraws (scroll / clear cycles). */
export function scrollRegionPayload({ frames = 200, rows = 40, cols = 100 } = {}) {
  const chunks = [CLEAR];
  for (let frame = 0; frame < frames; frame += 1) {
    chunks.push("\u001b[H");
    for (let row = 0; row < rows; row += 1) {
      const ch = String.fromCharCode(65 + ((frame + row) % 26));
      chunks.push(`${ch.repeat(cols)}\n`);
    }
  }
  chunks.push(MARKERS.scrollDone);
  return Buffer.from(chunks.join(""), "utf8");
}

export function payloadCatalog(scale = 1) {
  const s = Math.max(0.25, scale);
  return {
    dense: denseCellsPayload({
      rows: Math.round(30 * Math.min(s, 1.5)),
      cols: Math.round(100 * Math.min(s, 1.5)),
      passes: Math.round(24 * s),
    }),
    scrolling: scrollingPayload({
      lines: Math.round(12_000 * s),
      width: 80,
    }),
    unicode: unicodePayload({
      lines: Math.round(3_000 * s),
    }),
    sparse: sparseRowPayload({
      frames: Math.max(60, Math.round(180 * s)),
      row: 10,
      width: 100,
    }),
    visual: visualFixturePayload({
      frames: Math.max(30, Math.round(60 * s)),
      row: 10,
      width: 100,
    }),
    scrollRegion: scrollRegionPayload({
      frames: Math.round(120 * s),
      rows: 30,
      cols: 90,
    }),
  };
}
