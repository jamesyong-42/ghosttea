# Swift rendering and replication performance plan

**Status:** physical-device benchmark validated; first clean baseline pending

**Recorded:** 2026-07-20

This document translates the retained desktop and native optimizations in
[`docs/rendering-performance-audit.md`](../../../docs/rendering-performance-audit.md)
and
[`docs/truffle-transport-performance.md`](../../../docs/truffle-transport-performance.md)
into an iOS plan. The goal is not merely a high frame rate in an isolated Metal
demo. The iOS app must preserve exact TRF1 pixels and terminal behavior while a
desktop demo and one or more Apple presentations attach to the same Truffle
session.

Release qualification remains governed by
[`release-hardening.md`](release-hardening.md). The device/toolchain, SSH,
physical-matrix, jetsam, and account-owned release items recorded there are
deferred release gates; they do not block this optimization work.

## Performance boundary

The shared Rust terminal and replica model remain the semantic authority. Swift
owns retained TRF1 presentation state, accessibility state, UIKit invalidation,
Metal geometry and uploads, and the Apple Truffle client. An optimization is
acceptable only when it preserves:

- byte-identical native TRF1 for the existing fixtures;
- identical rendered pixels between the optimized and forced-reference paths;
- ordered Truffle snapshot, patch, control, resize, and resync semantics;
- Unicode, combining, wide-character, color-glyph, cursor, selection, and
  accessibility behavior; and
- bounded memory and zero GPU submissions while a surface is suspended.

The current Apple hot path is:

```text
Truffle JSON or SSH bytes
  -> shared Rust logical/terminal model
  -> TRF1 Data
  -> decode every section into Swift values
  -> transactional RetainedTRF1State copy/update
  -> accessibility snapshot and UIKit invalidation
  -> scan all visible glyphs and synchronize per-view atlases
  -> rebuild six expanded Float vertex arrays for all rows
  -> allocate one MTLBuffer per non-empty category
  -> clear and redraw the complete drawable
  -> one command-buffer commit per MTKView
```

## What the desktop work teaches us

The recent desktop/native work is a strong guide because it measured retained
changes and removed neutral or harmful experiments:

| Desktop/native result                                                                                                                                            | Swift implication                                                                                                                                                                                                                           |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cursor-only invalidation, display-aligned flushing, batched GPU submission, and rounded resize comparison reduced redundant work.                                | Keep the event-driven `MTKView`, but measure draw coalescing, cursor damage, and effective physical-size changes explicitly.                                                                                                                |
| Instanced rectangles/glyphs reduced vertex uploads by 73-78%; R8 monochrome atlases reduced a 2048-square atlas from 16 MiB to 4 MiB.                            | Swift already uses `r8Unorm`, but still expands every quad to six vertices and allocates transient buffers. Port instancing, not the atlas-format change.                                                                                   |
| Preserving dirty rows enabled row-band work and pixel-hash validation.                                                                                           | Swift already returns `changedRows` from retained-state apply but discards it at the view boundary. Carry damage into render preparation.                                                                                                   |
| A narrow second-sighting repeated-row geometry cache helped; persistent per-row GPU regions were neutral, regressed typing CPU, and raised memory risk.          | Start with a bounded CPU cache/admission policy. Do not begin with per-row persistent Metal allocations.                                                                                                                                    |
| One-pass classification for simple rows removed expensive segmentation work while Unicode retained a correctness fallback.                                       | Swift receives already-shaped glyphs; its analogous hot loop is repeated style resolution, atlas lookup, quad expansion, and whole-row traversal. Preserve a simple linear path for small rows and add indexing only when density earns it. |
| Clone-free replica patching and reusable contiguous buffers reduced apply/decode work.                                                                           | Remove the full `RetainedTRF1State` transactional copy only after all validation can complete before mutation; reuse decode and upload storage where ownership permits.                                                                     |
| `compact-json-v1` cut truecolor source bytes 79%, decode time 82%, and end-to-end replica wall time 53% before later native gains.                               | The Apple compact-port client currently stays on legacy JSON. Add negotiated compact-state support and a Swift decoder before tuning around avoidable JSON volume.                                                                          |
| Color-only shape reuse, second-sighting shared row-shape caching, and adaptive TRF1 style indexing produced large native gains without changing wire/TRF1 bytes. | These shared Rust improvements benefit iOS after rebuilding the Apple native artifacts. Add Apple regression/performance coverage rather than duplicating them in Swift.                                                                    |

## Current Swift audit

### Retained state

`RetainedTRF1State.applyDecoded` decodes the complete frame and then assigns
`var next = self`. Mutating `next.rows`, glyph definitions, or style definitions
can trigger copy-on-write storage proportional to retained state even when a
patch changes one row. The method also searches the section array repeatedly
and uses `changedRows.contains` while applying accessibility-only rows.

The transactional guarantee is valuable and must stay. The cheaper shape is:

1. index and decode the sections once;
2. validate row counts, bounds, duplicate rows, revisions, definitions, and all
   fallible conversions without mutating retained state;
3. reserve dictionary/row capacity as needed; and
4. perform a nonthrowing commit that mutates only changed rows and new
   definitions.

A compact row bitset or `Set<UInt16>` should replace repeated linear membership
checks. Benchmarks must attribute envelope/section decode separately from the
retained-state commit so a codec win is not confused with a state-copy win.

### Damage and UIKit work

`RetainedTRF1ApplyResult.applied` contains `changedRows`, but
`GhostteaTerminalMetalView.apply` ignores it and requests an undifferentiated
draw. Cursor movement, selection changes, focus, blink, marked text, theme,
atlas reset, viewport scroll, resize, and full snapshots also need explicit
damage categories. Damage must be unioned until a successful submission; it
must never be overwritten by a later event.

The view also constructs an accessibility snapshot on every accepted frame and
can rebuild UIKit accessibility elements even when VoiceOver is not running.
Readable retained text is still mandatory, but presentation objects can be
updated only for changed rows and coalesced for VoiceOver. Page-scroll
announcements, focus, cursor, selection, and VoiceOver enable/disable transitions
remain forced update points.

`layoutSubviews`, safe-area changes, and `drawableSizeWillChange` all enter
`geometryDidChange`. Cache the effective rounded physical size, scale, content
insets, and grid. Rebuild geometry or notify resize only when the corresponding
effective value changes; UIKit callback count is not itself render damage.

### Metal geometry and uploads

Every draw currently:

- scans all rows to build a sorted set of visible glyph IDs;
- resolves the same style definitions in the background, glyph, and decoration
  passes;
- expands each rectangle and glyph quad into six vertices held in `[Float]`;
- allocates up to six new shared `MTLBuffer` objects; and
- clears and redraws the entire drawable.

The first GPU change should use packed rectangle and glyph instances. The Metal
vertex shader can derive the six quad corners from `vertex_id`; Swift uploads
one instance and calls `drawPrimitives(..., instanceCount:)`. Dynamic data
should come from a bounded triple-buffered upload arena whose slots are reused
only after their command buffer completes. Tiny overlays may use `setVertexBytes`
when measurement shows it wins. Buffer high-water capacity and bytes uploaded
must be visible in diagnostics.

Style definitions should be resolved once per state/theme generation. Row
geometry should be built or refreshed only for damaged rows and placed in a
bounded CPU cache. Use the desktop-proven second-sighting admission rule for
repeated rows; a one-off scroll flood must not fill the cache.

Row damage does **not** make a presented `CAMetalDrawable` safely persistent.
Its prior contents cannot be assumed after presentation. The first retained
implementation should therefore cache/reuse geometry and reduce CPU/upload
work while still composing a complete drawable. A later experiment may compare:

- drawing all cached row instances into the drawable each frame; and
- updating damaged bands in a persistent scene texture, then blitting that
  texture to the drawable.

The scene-texture candidate costs roughly four bytes per physical pixel and
must include rotation, scale, background, selection, cursor, atlas-reset, and
memory-warning invalidation. It is retained only if device traces show a clear
CPU/GPU/energy win within the whole-app memory budget.

### Atlas ownership

Swift already uses a 4 MiB `r8Unorm` alpha atlas, which matches the retained
desktop format improvement. It also eagerly allocates a 16 MiB color atlas for
every `GhostteaMetalRenderer`, and each `GhostteaTerminalMetalView` constructs
its own Metal runtime and renderer. Eight visible surfaces can therefore reserve
about 160 MiB in atlas textures before drawable, geometry, native terminal, and
scrollback memory.

Make the color atlas lazy first; terminals without color glyphs should pay zero
color-atlas bytes. Sharing atlases is a later experiment. Glyph IDs alone are
not a safe process-global key because local and remote runtimes can have
independent catalogs with colliding IDs. A shared pool requires either an
explicit catalog namespace in TRF1 or a content-addressed glyph key that includes
format, dimensions, and pixel identity. It must also support per-presentation
eviction and the existing full-snapshot recovery transaction.

### Truffle replication

The production Apple path dials the raw compact listener on port 9421. That
listener currently returns no selected state codec, and Swift always decodes
state messages with `JSONDecoder`. The Rust QUIC peer path can negotiate
`compact-json-v1`, but that optimization does not currently reach the iOS app.

Extend the optional hello fields without changing protocol major version, teach
the compact listener to negotiate the same codec, and implement the exact tuple
schema in Swift. An old client continues to omit the offer and receives JSON;
an old server omits the selection and the new client falls back to JSON. Golden
fixtures must be generated from Rust and decoded in Swift for snapshot, patch,
control-changed, truecolor, Unicode, null optionals, malformed tuples, and size
limits. Source bytes, logical revisions, emitted TRF1 bytes, and final pixel
hashes must match the JSON path.

After codec parity, evaluate reusable receive storage. `readExactly` currently
copies a prefix into new `Data` and calls `removeFirst`; the attachment then
copies the state payload again before `JSONDecoder`. A bounded cursor-based
buffer can compact only when needed and expose a validated slice for immediate
decode. It must retain pull-based reads so transport backpressure remains
lossless.

## Measurement contract

Optimization starts by extending the existing opt-in performance recorder and
device harness. Production recording remains disabled by default and accepts
numeric values only. Add bounded attribution for:

- Truffle state bytes, state decode, and replica publication;
- TRF1 envelope/section decode and retained-state commit;
- accessibility snapshot/update work;
- glyph visibility scan and atlas upload bytes/reset count;
- row mesh build, cache hit/admission/eviction counts, and style resolution;
- Metal buffer allocations, allocated capacity, uploaded bytes, encode time,
  command-buffer commits, draw calls, and GPU completion time; and
- full-row, damaged-row, cursor-only, selection-only, and geometry-only frames.

Use deterministic versions of the desktop workloads: typing, sparse output,
scroll, dense output, truecolor/DOOM-fire-like updates, Unicode/combining/wide
text, resize jitter, and one/four/eight concurrent visible surfaces. Exercise
both local SSH models and a desktop-authoritative Truffle session. Physical
evidence should cover at least one 60 Hz device and one 120 Hz device; longer
CPU, GPU, thermal, and energy traces remain release gates.

For every optimization, render the same frame sequence through the candidate
and forced-reference path into offscreen textures and compare hashes. Include
incremental/full snapshot chunking, atlas reset, selection and cursor movement,
rotation, safe-area changes, background/foreground, and memory warning/resync.
Record median and p99 across repeated clean runs, source/TRF1/upload bytes,
process physical footprint, and thermal state. Retain a change only when the
target metric improves beyond normal variance with no practical regression in
latency, memory, energy, or correctness.

## Implementation order

### Slice 1: baseline and native artifact refresh

- Rebuild the Apple native artifacts from the current Rust revision so row-shape
  reuse, the bounded shared shape cache, and adaptive TRF1 style indexing are
  present on device.
- Add the workloads and detailed numeric counters above.
- Capture clean simulator controls and physical 60/120 Hz baselines before
  changing Swift behavior.

Exit gate: reproducible reports with exact frame/pixel invariants and enough
attribution to distinguish transport, native model, Swift apply, mesh build,
upload, and GPU time.

Implementation status: the Apple native artifacts now rebuild from the current
Rust revision, and `bench/ios-render` automates signed Release-device warmups,
repetitions, workload selection, detailed numeric attribution, renderer and
memory counters, thermal/Low-Power checks, final pixel proofs, retained JSON,
and strict baseline comparison. Host comparator tests and generic Release iOS
builds pass. The runner has also passed a short smoke and the complete 11-case,
55-sample suite on an iPhone 14 Pro at 120 Hz with Low Power Mode off, nominal
thermal state, and no correctness failures. The full report is retained as a
dirty-worktree baseline candidate; after these harness changes land, rerun the
same suite from the clean revision to produce the comparator-eligible Slice 1
baseline.

### Measured optimization 1: identical geometry reuse

The renderer can retain one encoded geometry entry per surface after the exact
same key is observed twice consecutively. Its key covers the terminal
session/epoch/frame sequence, viewport, scale, theme, content insets, selection,
focus, and both atlas reset generations. Subsequent
identical redraws reuse immutable Metal buffers; any input that can affect
pixels or atlas coordinates invalidates the entry. One-off changing frames are
never admitted. The cache remains strictly bounded and is released with the
renderer during suspension or memory pressure.

Cursor blink visibility is applied when encoding the cursor draw rather than
being part of the geometry key. Cursor geometry remains pixel-identical and is
still invalidated by cursor state, focus, viewport, theme, or frame changes, but
the normal blink timer no longer rebuilds and uploads the entire terminal mesh.

The first iPhone smoke reduced the scaled unchanged-repaint workload from about
15 ms to 1.3 ms and eliminated measured mesh construction, vertex uploads, and
buffer allocations after warmup. Cursor and typing workloads continued to miss
the cache and render normally. The complete clean-revision comparison is the
acceptance gate before retaining this optimization.

After bounded admission and cursor draw gating, a focused five-sample device
run measured unchanged-repaint active time at 32.9 ms for 120 draws with a
0.30 ms operation p99 and one 0.5 MiB admission upload. The committed baseline
measured 761.8 ms, 7.97 ms, and 58.9 MiB respectively. The full clean-revision
suite remains the final acceptance gate.

### Slice 2: compact Truffle state on Apple

- Extend optional handshake negotiation on the compact listener and Swift
  client.
- Implement and fixture-test `compact-json-v1` decode in Swift with JSON
  fallback.
- Add cursor-based reusable receive buffering after the codec result is known.

Exit gate: the iOS app and desktop demo remain attached to the same session;
JSON and compact paths produce identical logical revisions, TRF1 bytes, and
pixels; truecolor state bytes/decode time materially improve.

### Slice 3: retained-state and invalidation efficiency

- Decode/validate once and commit without a full retained-state copy.
- Preserve unioned row/cursor/selection/geometry damage through submission.
- Incrementally/coalesced accessibility work and effective-geometry guards.
- Cache resolved styles by state/theme generation.

Exit gate: malformed frames remain atomic and force resync, all existing tests
pass, and sparse/typing Swift CPU plus allocation counts improve.

### Slice 4: instanced Metal submission

- Replace six-vertex quad expansion with packed rectangle and glyph instances.
- Add bounded triple-buffered upload arenas and command-completion ownership.
- Retain one command buffer per surface draw and expose allocation/upload/draw
  counters.

Exit gate: identical pixel hashes, no in-flight buffer overwrite under 120 Hz
stress, materially fewer uploaded bytes/allocations, and no suspended GPU work.

### Slice 5: bounded row geometry reuse

- Refresh geometry for damaged rows only.
- Admit repeated rows on their second observation into a small bounded CPU
  cache; preserve a direct path for broad damage and one-off output.
- Compare full cached composition with a memory-accounted persistent scene
  texture; retain only the measured winner.

Exit gate: sparse, typing, scroll, dense, Unicode, and four/eight-surface tests
stay pixel exact; the candidate improves CPU/GPU or energy without an adverse
working-set signal.

### Slice 6: atlas and multi-surface policy

- Lazily allocate the color atlas and report real per-surface GPU residency.
- Prototype a catalog-safe shared atlas pool only after namespacing/content-key
  correctness is solved.
- Measure a display-linked multi-surface scheduler that coalesces work and, where
  Metal ownership permits, batches command encoding without coupling session
  ordering.

Exit gate: one/four/eight visible surfaces remain within the whole-app memory
policy, memory-warning recovery stays atomic, and batching shows a measured
latency/energy benefit without starving a pane.

## Explicit non-goals for the first pass

- Do not duplicate Rust shaping or adaptive TRF1 encoding logic in Swift.
- Do not rely on a presented drawable retaining its contents.
- Do not introduce unbounded frame, geometry, receive, or atlas caches.
- Do not key a process-global atlas by bare glyph ID.
- Do not retain persistent per-row Metal buffers merely because the desktop
  experiment existed; its measured result argues against that starting point.
- Do not trade ordered lossless state delivery for dropped intermediate patches.
  Coalescing requires a protocol-aware snapshot/resync design and is a separate
  experiment.

## Recommended first implementation

Begin with Slice 1 and Slice 2. The native changes are already measured, and
compact state encoding removes work before it reaches Swift. In parallel within
the baseline harness, add counters for the discarded `changedRows`, mesh build,
Metal allocation/upload bytes, and atlas residency. Those numbers will decide
whether Slice 3 or Slice 4 is the larger device-side win; current source review
suggests both are substantial, with eager per-view color atlases the most urgent
multi-pane memory issue.
