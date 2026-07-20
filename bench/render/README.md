# Electron per-pane rendering benchmark

This suite measures the complete desktop rendering path:

```text
payload file -> real PTY -> Ghostty VT -> native shaping -> TRF1 frame
  -> Electron bridge -> renderer MessagePort -> render worker -> WebGPU submit
  -> GPU queue idle
```

It complements the existing `bench/run.mjs` comparison, which intentionally
stops at terminald frame delivery and does not measure the Electron/WebGPU tax.

## Baseline workflow

Use an AC-powered, otherwise idle machine. Close other GPU-heavy applications,
keep the display configuration fixed, and do not compare results captured at
different DPR or refresh rates.

```sh
# Build release terminald, SDK packages, and the experiment app, then run
# one warmup and five measured repetitions per workload.
npm run bench:render -- --output=bench/render/results-baseline.json

# Make exactly one optimization, then capture another report.
npm run bench:render -- --output=bench/render/results-candidate.json

# Bootstrap the median difference. A result is only called improved/regressed
# when its 95% interval excludes zero and it exceeds the practical threshold.
npm run bench:render:compare -- \
  bench/render/results-baseline.json \
  bench/render/results-candidate.json
```

The default practical threshold is 3%. Change it with `--noise=5` when the
machine is noisy. Store a machine-specific baseline outside the ignored
`results*.json` paths if it is intended as long-lived evidence.

## Workloads

| Case              | Purpose                                                            |
| ----------------- | ------------------------------------------------------------------ |
| `idle-4`          | Four mounted panes, no output; detects idle/cursor/background work |
| `repaint-1`       | Repaints one unchanged populated row; isolates geometry reuse      |
| `typing-1`        | Paced input/local echo; exposes redundant input and cursor renders |
| `sparse-1`        | Replaces one row repeatedly; isolates persistent row-damage work   |
| `visual-1`        | Pixel fixture for box/block, Unicode, theme, selection, and damage |
| `scroll-1`        | One pane receiving a fast plain-text scrolling flood               |
| `dense-1`         | One pane with dense SGR foreground/background changes              |
| `doom-fire-1`     | Seeded full-screen half-block fire with frame-paced truecolor      |
| `unicode-1`       | Native shaping, rasterization, atlas, emoji/CJK/combining pressure |
| `redraw-1`        | Repeated cursor-home full-screen updates                           |
| `scroll-4`        | Four simultaneous PTYs and pane surfaces sharing the worker/device |
| `resize-1`        | Display-paced pane resizing and terminal reflow/resource churn     |
| `resize-jitter-1` | Subpixel layout jitter that should not rebuild GPU resources       |

Payload workloads are emitted by a small Node helper on a monotonic interval.
Most use fixed-size chunks; `doom-fire-1` preserves generated frame boundaries.
This prevents a fast `cat` from collapsing the whole input into a handful of
terminald batches and makes scheduling/render pressure repeatable. The pacing
configuration is embedded in each raw report.

`doom-fire-1` is an independently implemented, finite, seeded adaptation of the
classic fire simulation, inspired by
[DOOM-fire-zig](https://github.com/const-void/DOOM-fire-zig). It follows that
program's terminal stress shape—two simulated pixels per `▀` cell with changing
foreground and background colors—but does not vendor its GPL-3.0 source or
palette. The benchmark needs neither Zig nor network access at runtime.
Every raw report records the pinned upstream revision alongside the seed and
exact generated frame byte lengths.

Select a subset while developing:

```sh
npm run bench:render -- \
  --cases=scroll-1,scroll-4 \
  --iterations=7 \
  --warmup=1 \
  --scale=1 \
  --output=bench/render/results.json
```

`--no-build` reuses the current release daemon and Electron build. It is useful
for harness debugging, but optimization evidence should normally use the full
build path so stale bundles cannot contaminate a comparison.

Use `--verify-pixels` with payload cases to hash the final Electron frame,
force a full redraw of every pane, and require the second frame to match
exactly. `visual-1` is intended for this gate. Use `--force-full-rendering` to
turn every invalidation into a full redraw for a controlled A/B measurement of
row-damage rendering.

Tracked worktree changes invalidate comparison reports. Untracked files are
also rejected unless they are explicitly acknowledged; the exception remains
visible in raw metadata:

```sh
npm run bench:render -- \
  --allow-untracked=pnpm-lock.yaml,pnpm-workspace.yaml \
  --output=bench/render/results-baseline.json
```

## Recorded evidence

Each measured repetition preserves raw data rather than only a headline FPS:

- payload bytes and wall-clock start-to-GPU-idle time;
- TRF1 frames/bytes, full versus incremental frames, decoded rows, and new
  glyph definitions;
- worker frame-application and render CPU samples;
- dirty-to-render and frame-arrival-to-render distributions;
- flushes, render calls, and panes per flush;
- canvas pixel-frames, passes, draw calls, vertices, vertex bytes, geometry-cache
  hits/misses, and atlas upload bytes/calls;
- final `GPUQueue.onSubmittedWorkDone()` drain time;
- 100 ms Electron process CPU and resident-set samples, including the GPU and
  utility processes;
- Electron/Chromium versions, GPU feature status/info, display scale/frequency,
  OS/CPU, Git revision/dirty state, and thermal state.

`gpuQueueDrainMs` is backlog-at-settle, not render-pass GPU duration. It catches
the important failure mode where CPU submission looks fast while GPU work piles
up, without adding timestamp queries to every measured frame. A separate
timestamp-query diagnostic can be added later for pass attribution; it should
not silently change the default workload's command stream.

Electron's process sampler does not include the separately spawned terminald
process. End-to-idle time still covers terminald work, and `bench/run.mjs`
isolates the native sidecar path. Renderer changes should use this suite; native
parser/shaping/encoding changes should run both suites so cost cannot disappear
across the process boundary.

## Honest comparison rules

1. Compare the same case list, dimensions, scale, warmup, repetition count,
   Electron version, display, and machine.
2. Reject runs that fall back to Canvas2D, time out waiting for idle, encounter
   device loss, or reach serious/critical thermal state.
3. Prefer five or more repetitions. Seven to eleven are better for small
   changes.
4. Look at end-to-idle, render CPU, arrival latency, Electron process CPU, GPU
   drain, and memory together. For native changes, also run the sidecar suite;
   moving work between processes is not a win.
5. Treat `inconclusive` as the correct result when noise is larger than the
   effect. Never select the best run from a batch.
6. Keep payload bytes fixed. If an optimization changes protocol semantics or
   rendered output, validate correctness separately before comparing speed.
7. Run one optimization per candidate commit and retain both raw JSON files
   with the commit hashes in any performance report.

## Harness checks

```sh
npm run test:bench:render
npm run check --workspace @vibecook/ghosttea-react
npm run check --workspace ghosttea-desktop-experiment
```

The statistical comparison code has deterministic unit coverage. The actual
render suite must run in a visible Electron window because hidden/headless
Chromium can throttle or select a different rendering path.

## External terminal smoke comparison

`external-terminal-workload.mjs` emits the exact seeded `doom-fire-1` frame
sequence to its stdout, paced one frame at a time. It is a low-level helper for
running the workload inside another terminal emulator without involving
Ghosttea's PTY or renderer:

```sh
node bench/render/external-terminal-workload.mjs \
  /tmp/terminal-metrics.json /tmp/terminal-ready /tmp/terminal-go
```

The helper first writes the ready file, then waits for the gate file. This lets
a recorder start after the terminal reaches exactly 120 columns by 40 rows.
Its metrics distinguish producer throughput and stdout backpressure from
visible rendering; accepting 62.5 frame writes per second does not prove that a
terminal displayed 62.5 distinct frames.

See [macOS terminal comparison](./macos-terminal-comparison.md) for the first
single-sample smoke run and its measurement limitations.
