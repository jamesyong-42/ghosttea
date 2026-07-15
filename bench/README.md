# Terminal benchmark harness

Reproducible comparison of:

| Target               | What is measured                                                                                                                         |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| **terminald**        | Real PTY → `libghostty-vt` → native text engine → TRF1 frames over UDS (the Electron sidecar hot path without UI/GPU)                    |
| **node-pty → xterm** | **Primary baseline**: real PTY via `node-pty`, shell `cat`s the same payload, bytes feed `@xterm/xterm` `write` (classic Electron embed) |
| **xterm write-only** | Decomposition only (parser cost without PTY) — labeled as secondary                                                                      |
| **Native Ghostty**   | Manual only — same byte payloads via `workloads/manual-cat.sh`                                                                           |

### Fair comparison rule

```text
terminald:   PTY → ghostty-vt → shape → TRF1 frames
node-pty+xterm: PTY → shell cat → onData → xterm.write(parse)
```

Same grid size, same payload files, same markers. Do **not** compare terminald
to pure `xterm.write` when arguing product performance — that omits PTY cost
and is only useful to split “who spent time where.”

This is **not** a claim that the Electron app is faster than Ghostty. It quantifies:

1. How expensive the **sidecar path** is vs a classic **xterm.js** embed.
2. Whether **control stays responsive under flood** (the architecture’s product bet).
3. A fair **manual** cross-check against native Ghostty using identical dumps.

## Quick start

```sh
# From repo root (release terminald binary recommended)
cargo build --release --manifest-path native/terminald/Cargo.toml
npm install
npm run bench
```

Options:

```sh
node bench/run.mjs --targets=terminald,xterm --scale=1 --json=bench/results.json
node bench/run.mjs --targets=terminald --scale=0.5
TERMINALD_BIN=./native/terminald/target/release/terminald npm run bench
```

## Cases

| Case                       | Intent                                                         |
| -------------------------- | -------------------------------------------------------------- |
| dense                      | Colored cells (vtebench-ish pressure on SGR + redraw)          |
| scrolling                  | Large plain-text flood (`cat`-like)                            |
| unicode                    | Wide chars / emoji / combining samples                         |
| scroll-region              | Full viewport redraw loops                                     |
| control RTT under flood    | `get-session` latency while output is flooding (**terminald**) |
| interrupt under flood      | Ctrl+C → ACK while Python floods stdout (**terminald**)        |
| event-loop lag under write | `setImmediate` lag during xterm `write` (**xterm**)            |
| multi-session              | N concurrent floods                                            |

## Interpreting results

**Apples and oranges by design (and labeled as such):**

- `terminald` does **more** work than pure `terminal.write`: PTY, VT, HarfBuzz shaping, glyph raster cache, binary frame encode, UDS.
- Pure xterm numbers are **parse/buffer only** — no GPU, no Electron, often no PTY.
- If terminald **wins or ties** wall clock anyway, the native core is paying for itself.
- If xterm pure-parse is faster but **event-loop lag / multi-session** is worse, that matches the architectural thesis.

**Expected qualitative order (end-to-end pixels):**

```text
native Ghostty  ≥  electron-ghostty (terminald + WebGPU)  ≫  node-pty + xterm under flood
```

**Expected qualitative order (this harness):**

```text
terminald control-under-flood  ≫  xterm event-loop under write
terminald multi-session        often better wall/CPU than N × xterm
pure xterm parse               may beat terminald wall time on single stream
```

## Native Ghostty manual protocol

```sh
# Inside Ghostty:
time BENCH_SCALE=1 ./bench/workloads/manual-cat.sh scrolling
time BENCH_SCALE=1 ./bench/workloads/manual-cat.sh dense

# Same commands in Terminal.app / Kitty for a third baseline.
# Also try typing or Ctrl+C mid-dump and note whether input is delayed.
```

Record wall time and a subjective responsiveness note. There is no stable public
API to automate Ghostty’s GUI from this repo.

## Electron UI / WebGPU tax (not automated yet)

This harness stops at **frame bytes on the UDS**. The remaining tax in the full app is:

```text
UDS frame → utility bridge → MessagePort → worker decode → WebGPU submit
```

To measure that later:

1. Chrome DevTools Performance while flooding in `npm run dev`
2. Worker-side timestamps around `applyFrame` / `flush`
3. Optional: expose a hidden `bench-mark` IPC that echoes RTT through the full stack

## JSON schema

`--json=path` writes:

```json
{
  "generatedAt": "...",
  "meta": { "host", "node", "platform", "scale", "cols", "rows", "targets" },
  "results": {
    "terminald": { "cases": { ... } },
    "xterm": { "cases": { ... } },
    "comparisons": [ { "case", "terminaldMs", "xtermMs", "speedupVsXterm", "note" } ]
  }
}
```

## Caveats

- Numbers are **machine-local** and vary with thermal state, font discovery, and release vs debug `terminald`.
- Prefer a **release** `terminald` binary (`cargo build --release`).
- **`posix_spawnp failed`**: almost always means `node-pty`'s `spawn-helper` is not
  executable. `npm run bench` runs `scripts/fix-node-pty.mjs` automatically; you can
  also run it after any reinstall: `node scripts/fix-node-pty.mjs`.
- Do not treat a single run as truth — use `--scale` sweeps and a few repeats when publishing.

## Example commands

```sh
# Full primary comparison (terminald vs node-pty→xterm)
cargo build --release --manifest-path native/terminald/Cargo.toml
TERMINALD_BIN=./native/terminald/target/release/terminald npm run bench:json

# Only the classic embed stack
node bench/run.mjs --targets=xterm --scale=1

# Larger flood
node bench/run.mjs --scale=2 --json=bench/results.json
```
