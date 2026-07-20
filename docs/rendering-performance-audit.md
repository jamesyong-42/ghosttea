# Per-pane rendering performance audit

Status: architectural audit plus measured optimization cycles.

The current per-pane canvas model is viable. All pane canvases in a renderer
window share one render worker and one WebGPU device, while each pane owns its
own canvas context and render resources. The largest performance opportunity is
not consolidating those canvases. It is retaining row-level damage through the
whole pipeline instead of turning small changes back into full-pane work.

None of the expected improvements below should be accepted from static analysis
alone. The rendering benchmark described in `bench/render/README.md` is the
qualification gate: capture a baseline, change one behavior, compare repeated
samples on the same machine, and reject changes that merely move cost between
latency, CPU, GPU backlog, and memory.

## Original hot path

```text
PTY output
  -> terminald 8 ms batch
  -> Ghostty VT dirty rows
  -> native snapshot and shaping
  -> TRF1 packet containing changed rows
  -> Electron bridge and renderer MessagePort
  -> render worker snapshot application
  -> worker 8 ms dirty timer
  -> complete pane geometry rebuild and upload
  -> terminal render pass into a pane scene texture
  -> complete pane CRT post-process pass into the canvas
```

This was the baseline at the start of the audit. The retained changes in the
measured log now preserve row damage through the worker and first WebGPU pass;
full-state native cloning and the full-pane post-process remain.

## Findings

### Row damage is discarded downstream

The Ghostty adapter identifies full versus damaged rows, the model shapes
updated rows, and the frame encoder transmits row replacements. In the render
worker, however, each incremental frame clones the outer viewport arrays and
every native glyph/style row. The dirty queue records only the session handle,
not the affected rows.

Every render then scans all visible glyphs, resolves every style, segments rows
for box/block characters, reconstructs JavaScript number arrays, converts them
to new `Float32Array`s, uploads all vertex buffers, clears the scene texture,
and redraws the entire pane. Cursor blink, focus, selection, and cursor activity
follow the same path.

Target architecture:

1. Preserve and union dirty rows in the worker.
2. Mutate canonical decoded rows in place.
3. Cache GPU-ready geometry per row and update only dirty buffer ranges.
4. Retain the per-pane scene texture and redraw damaged row bands with scissor
   rectangles and explicit row backgrounds.
5. Include old and new cursor rows plus selection deltas in damage.
6. Reserve full redraws for resize, theme/font changes, full snapshots, and
   device recovery.

Scrolling deserves an explicit workload: depending on how Ghostty reports a
scroll, it may legitimately damage most of the viewport. Row-ring or scroll
specialization should only follow measurements.

### Vertex construction and upload are oversized

The renderer expands each quad into six vertices. A rectangle occupies 144
bytes and a glyph 192 bytes before considering the temporary JavaScript
`number[]` representation. A representative 1440 x 900 CSS-pixel pane at DPR 2
with about 8,600 populated cells creates roughly 1.6 MiB of glyph vertices per
full frame, or about 94 MiB/s at 60 frames per second, excluding rectangles,
temporary allocation, and atlas traffic.

Instanced quads should generate corners from `vertex_index` and carry one packed
record per glyph or rectangle. Pixel/cell coordinates plus a viewport uniform
avoid rebuilding normalized coordinates on resize. A 32-40 byte glyph instance
would cut glyph upload volume by roughly five times. Fixed per-row regions then
allow `queue.writeBuffer` to update only changed rows.

### Input can trigger a redundant render

Text, paste, key, and interrupt operations all send `cursor-activity`. The
worker resets the blink timer and unconditionally marks the pane dirty. If the
cursor is already visible, no pixel changed, and the echoed PTY output commonly
causes a second render immediately afterward. Only a hidden-to-visible cursor
transition should invalidate the pane.

### Two independent timers can add latency

terminald batches PTY output for 8 ms and the worker waits another 8 ms before
flushing dirty panes. Their delays can accumulate and the worker timer is not
aligned to display refresh. Use worker `requestAnimationFrame`, with a timer
fallback, and encode all dirty panes on that tick. Since the panes share a
device, one command encoder and one `queue.submit` per worker flush should be
measured against the current submit-per-pane behavior.

### The per-pane post-process is unconditional

Each pane owns an RGBA scene texture and always performs a terminal pass plus a
full-resolution CRT sampling pass. A 1440 x 900 pane at DPR 2 uses about 19.8
MiB for that intermediate texture alone.

With the effect enabled, incremental scene updates still reduce CPU work,
geometry upload, and the first pass, although the final post-process remains a
full-pane operation. With the effect disabled, benchmark direct rendering
against persistent-scene-plus-blit: direct rendering removes the texture and
sample pass, while the retained scene can be cheaper for sparse updates. Do not
assume one path wins for every workload.

### Atlas memory and uploads

Three eager 2048 x 2048 RGBA atlases consume about 48 MiB. Monochrome Alpha8
glyphs are expanded to RGBA in JavaScript before upload.

Candidates:

- use `r8unorm` for the monochrome atlas;
- allocate the fallback atlas lazily;
- batch missing glyph uploads;
- use paged or LRU/clock eviction instead of clearing a shared atlas;
- release or centralize retained glyph pixel buffers once recovery no longer
  depends on every snapshot keeping them.

### Repeated renderer CPU work

Each render scans all native glyph rows to collect atlas definitions, segments
row text multiple times for box/block lookup, resolves styles repeatedly, and
tests selection membership per glyph. Cursor-only frames repeat all of it.
Per-row geometry keyed by row revision, theme generation, and selection
generation removes most of this work. Box/block classification and resolved
style tables can be cached separately.

### Resize churn

ResizeObserver reports floating-point CSS dimensions. The renderer compares
those values before rounding to physical pixels, so insignificant layout
changes can reconfigure the context and recreate the scene texture even when
the physical dimensions did not change. Quantize first, coalesce to a display
frame, and use `devicePixelContentBoxSize` where available.

Divider dragging also causes frequent terminal-grid resizes and native reflow.
Measure throttling grid changes to display cadence and visually retaining the
old texture during a drag before committing the final size.

### Native full-state cloning

Although frames contain dirty rows, the VT adapter deep-clones cached terminal
rows/cells, `TerminalModel` constructs a complete logical snapshot, and shaped
rows are copied into a new viewport vector. Prefer immutable `Arc`-backed rows
or a snapshot delta, direct encoder access to cached shaped rows, and full
logical materialization only for new subscribers or explicit resynchronization.

### Text-engine serialization and nonlinear loops

One shared `Mutex<TextEngine>` serializes shaping and rasterization across
sessions. Existing wait/hold counters are not surfaced by the desktop app. In
addition, graphemes search style spans and shaped glyphs search grapheme/cluster
collections repeatedly. Monotonic span cursors and precomputed cluster-to-cell
mappings make these walks linear.

Longer term, separate concurrent per-session/per-thread shaping contexts from a
synchronized global glyph ID/catalog. The shared GPU atlas requires stable
glyph IDs, but shaping itself should not necessarily serialize all active panes.

### Protocol and transport copies

The encoder searches row cells for each glyph's style, and accessibility text
duplicates row text for desktop renderers that do not consume the accessibility
section. The JavaScript decoder creates an object per glyph/style and copies
each glyph pixel payload.

terminald broadcasts `Vec<u8>` frames globally; each renderer connection can
clone a packet before filtering subscriptions. Use `Arc<[u8]>` as an immediate
improvement and per-session fanout as the scalable design. Renderer windows
should subscribe only to mounted session handles. The Electron bridge should
replace repeated `Buffer.concat` and packet slicing with a chunk queue/ring
parser.

Fully occluded tabs currently avoid GPU rendering but continue to receive and
decode subscribed frames. A grace-period unsubscribe plus full refresh on
visibility restoration is worth measuring for background energy usage.

## Measurement requirements

Every optimization must be evaluated across at least:

- idle panes and cursor blinking;
- typing/local echo;
- localized sparse updates;
- seeded, frame-paced full-screen truecolor animation;
- single-pane scrolling flood;
- simultaneous multi-pane flood;
- full-screen redraw/control-sequence workload;
- Unicode, emoji, CJK, combining text, and box drawing;
- selection drag and scrollback;
- live resize;
- DPR 1 and DPR 2 where the machine permits;
- 60 Hz and high-refresh displays where available.

Record input bytes, received frames, dirty rows, frame bytes, worker decode and
render CPU distributions, renders and panes per flush, generated vertices,
uploaded bytes, end-to-idle time, GPU queue drain, process CPU, resident memory,
backend/adapter identity, device scale factor, refresh rate, and thermal state.

Use a warmup followed by multiple measured repetitions. Preserve raw samples
and machine metadata in JSON. Compare baseline and candidate distributions, not
one best run, and flag changes below a configurable noise threshold as
inconclusive.

## Proposed order after the baseline exists

1. Remove redundant cursor renders and physical-pixel resize churn.
2. Subscribe only mounted sessions and reduce broadcast/parser copies.
3. Align worker flushing to display frames and batch pane submissions.
4. Preserve dirty rows and cache per-row geometry.
5. Convert rectangles/glyphs to packed instances.
6. Partially update persistent pane scenes.
7. Improve atlas formats, allocation, upload batching, and eviction.
8. Remove native full-grid clones and linearize shaping/encoding walks.
9. Reduce text-engine lock scope and introduce concurrent shaping contexts.

This ordering is provisional. Benchmark evidence can and should reorder it.

## Measured optimization log

The first cycle ran on an Apple M1 Max at DPR 2 and 120 Hz with the native
WebGPU backend, nominal thermal state, one warmup, and five measured repetitions
per steady-state workload. Raw reports are intentionally ignored local
artifacts under `bench/render/results*.json`; each report records its exact Git
revision and worktree exceptions.

Retained changes:

1. Cursor activity now redraws only when it reveals a focused blinking cursor.
   In the typing workload, render CPU moved from 174.2 ms to 156.5 ms and
   arrival-to-render p99 from 26.93 ms to 11.53 ms. The CPU interval crossed
   zero, while the latency improvement was statistically supported.
2. Worker flushes use `requestAnimationFrame` with an 8 ms timer fallback.
   Arrival-to-render p99 improved by roughly 20-34% in typing, single-pane
   scroll, dense, redraw, and four-pane scroll. At 120 Hz, live resize rendered
   more intermediate sizes than the old timer; this is smoother but costs more
   work, so resize invalidation is handled independently.
3. Dirty panes in one worker flush share a command encoder and queue submission.
   Four-pane scrolling retained about 295 pane renders but reduced submissions
   to about 104, equal to flush count. Electron CPU improved 10.5%. The reported
   per-pane arrival p99 rose 12% because batch completion is now timestamped
   after the last pane is encoded; end-to-idle was unchanged.
4. Resize invalidation compares DPR and rounded physical dimensions. A new
   `resize-jitter-1` workload oscillates by 0.2 CSS pixels without changing the
   DPR-2 canvas. It fell from 180 renders/submissions and 51.5 ms render CPU to
   zero, reduced Electron CPU 61.5%, and improved end-to-idle 17.3% across seven
   measured repetitions.
5. Rectangle and glyph quads are instanced. Glyph instances contain bounds, UV
   bounds, and color; rectangle instances contain three corners so rotated
   segments used by rounded box drawing remain exact. Against the pre-instance
   renderer, vertex uploads fell 73-78%, while render CPU improved 18% for
   typing, 29% for scrolling, 41% for dense output, 31% for redraw, and 34% for
   four-pane scrolling.
6. The monochrome glyph atlas is `r8unorm` and consumes 4 MiB instead of 16 MiB.
   A cold Unicode run with the same 39 atlas upload calls transferred 15,968
   bytes instead of 47,648 bytes, a deterministic 66.5% overall reduction after
   retaining RGBA color glyphs. The single cold timing sample is not treated as
   latency evidence.
7. Incremental frame application now structurally shares unchanged glyph/style
   rows, and each style ID is resolved once per render. The isolated deltas were
   mostly below the confidence threshold; redraw render CPU improved 5%, and
   typing Electron CPU improved 12.8%. The change remains useful groundwork for
   row-revision geometry caching.
8. The worker now preserves and unions replacement-row damage, including both
   sides of a cursor move. Each pane retains its scene texture; incremental
   renders reset and redraw only damaged row bands plus one neighboring row for
   glyph overhang, while the existing CRT post-process still samples the full
   pane. Full snapshots, resize, theme/selection changes, visibility restore,
   renderer recovery, and explicit verification requests remain full redraws.
   A benchmark switch promotes every invalidation to full damage for controlled
   same-build A/B runs.
9. Repeated, unchanged partial repaints can reuse GPU-ready geometry. A new
   deterministic `repaint-1` case requests 180 redraws of one populated row
   without changing its content. Each pane keeps an eight-entry LRU keyed by
   session/layout epoch, damaged-row revisions, theme, selection, native versus
   fallback text mode, and atlas generations. Entries require a second sighting
   before allocating persistent GPU buffers, so one-off damage signatures do
   not accumulate resources. Full frames and content-revised rows use the
   original compact dynamic renderer directly; the cache reported zero hits and
   misses in the typing control.

The row-damage correctness gate captures the complete Electron window, hashes
its bitmap, forces a full redraw of every pane, and requires an exact SHA-256
match. Sparse, dense SGR, Unicode, repeated full-redraw, and a dedicated visual
fixture all matched. The visual fixture keeps styled box/block glyphs, wide and
combining text, a translucent custom theme, selection, cursor, and unchanged
rows resident while another row is updated; it completed 33 partial renders
before matching the forced full frame exactly.

On the isolated sparse workload, seven measured repetitions reduced median
worker render CPU from 30.7 ms to 17.6 ms (-42.7%, 95% interval entirely below
zero) and aggregate Electron CPU by 15.4%. End-to-idle was unchanged because
the payload is deliberately paced, and vertex upload volume was inconclusive.
In the eight-case control, typing render CPU improved 10.6%, vertex uploads
4.2%, and Electron CPU 11.5%. Scrolling, dense output, Unicode, repeated
full-screen redraw, multi-pane scrolling, and end-to-idle results were neutral.
A targeted seven-run scroll repeat also found the earlier memory-peak signal
inconclusive (+0.9%, 95% interval -5.2% to +8.9%), so no memory regression is
claimed.

Across the complete retained stack versus the original clean baseline, median
worker render CPU improved 33% for typing, 29% for scrolling, 41% for dense
output, 24% for Unicode, 33% for redraw, and 39% for four-pane scrolling.
Arrival-to-render p99 improved 23-87%, and vertex upload volume improved 65-75%.
End-to-idle is intentionally almost unchanged for paced workloads because the
payload duration and quiet window dominate it.

Process working-set measurements varied materially between fresh Electron runs
and are not used to claim a memory win. The explicit atlas allocation reduction
is deterministic, but the next harness iteration should add GPU allocation
counters and per-process lifetime normalization.

For the unchanged-row cache, seven clean measured repetitions reduced median
worker render CPU from 33.7 ms to 19.6 ms (-41.8%, supported) and vertex uploads
from 907,200 to 38,560 bytes (-95.7%, supported). Aggregate Electron CPU fell
14.5%; end-to-idle improved only 1.0% and is correctly classified as
inconclusive because the workload is paced. The cache stabilized at 178 hits
and two admission misses in every measured repetition. The five-run typing
control was neutral: render CPU moved from 103.2 ms to 102.1 ms (-1.1%) and
end-to-idle by -0.5%, with both confidence intervals crossing zero. The visual
fixture again produced identical partial and forced-full SHA-256 hashes.

The cache is deliberately narrow. Content-changing rows still allocate fresh
JavaScript arrays and rewrite compact buffers, while the CRT post-process
remains full-pane. Keeping separate cached and dynamic builders also grows the
minified worker bundle to 116.29 kB, so a future refactor should share geometry
construction without putting abstraction overhead back on the measured dynamic
hot path. The next row-oriented experiment is persistent per-row buffer regions
for genuinely revised content, qualified by the same typing control and
forced-full pixel gate rather than assuming fewer uploads improve latency.
