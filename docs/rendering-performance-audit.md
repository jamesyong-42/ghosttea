# Per-pane rendering performance audit

Status: architectural audit, before performance instrumentation or optimization.

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

## Current hot path

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

Damage starts narrow, but full-state cloning and full rendering widen it again
at both ends of the pipeline.

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
