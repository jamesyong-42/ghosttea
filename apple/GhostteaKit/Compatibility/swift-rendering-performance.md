# Swift rendering and replication performance plan

**Status:** clean physical-device baseline complete; optimizations 1-2 accepted

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
Truffle negotiated state or SSH bytes
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
| `compact-json-v1` cut truecolor source bytes 79%, decode time 82%, and end-to-end replica wall time 53% before later native gains.                               | Negotiate the same codec on Apple and measure its Swift decoder on a physical device before tuning around avoidable JSON volume.                                                                                                             |
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

The production Apple raw-stream client and compact listener now negotiate
`compact-json-v1` through optional hello fields without changing the protocol
major version. An old client that omits its offer receives JSON; an old server
that omits its selection makes the new client fall back to JSON. Control
messages remain JSON. The exact Swift tuple decoder is locked to a shared
Rust-produced fixture covering snapshot, patch, control-changed, truecolor,
Unicode/combining/wide text, null optionals, malformed flags/colors, and size
limits.

The physical-device `doom-fire-truffle-1` case proves the complete receive
path. JSON and compact bytes decode to equal logical messages, then independent
native replicas must emit byte-identical incremental and full-refresh TRF1;
final pixels must also match. This makes state bytes and decoder time causal
measurements rather than assuming semantic parity.

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

### DOOM Fire physical-device baseline

`doom-fire-1` is now a first-class iOS renderer case. It ports the exact seeded
xorshift, palette interpolation, packed upper-half-block simulation, SGR
encoding, and warmup behavior from `bench/lib/payloads.mjs`. A three-frame
cross-language vector checks frame byte lengths and the complete payload FNV-1a
hash before a device run can begin. The iOS case uses the shared seed
`0x0d00f1ee`, adapted to the harness terminal as 100 columns by 29 packed fire
rows plus one row of headroom.

A clean five-sample Release run on the iPhone 14 Pro at revision `d032e6c`
processed all 180 frames per sample with nominal thermal state, Low Power Mode
off, no failures, and identical final pixel hashes/counts. Median evidence was:

| Metric | Result |
| --- | ---: |
| VT source bytes | 15,476,316 |
| TRF1 bytes | 23,047,044 |
| active operation wall time | 1,120.5 ms |
| operation p99 | 6.83 ms |
| native feed total | 314.3 ms |
| retained frame decode total | 85.1 ms |
| mesh build total | 676.2 ms |
| Metal submission total | 710.0 ms |
| GPU completion p99 | 1.80 ms |
| vertex uploads | 162.1 MiB |
| process footprint before / after | 77.0 / 65.8 MiB |

This establishes the high-churn renderer baseline. Slice 2 additionally runs
the same truecolor/fire state shape through legacy JSON and negotiated compact
Truffle messages so codec bytes and Swift decode/publication time are measured
separately from VT parsing and Metal work.

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
builds pass. A clean complete 11-case, 55-sample baseline was captured from
revision `5af4b27` on an iPhone 14 Pro at 120 Hz with Low Power Mode off,
nominal thermal state, and no correctness failures. This completes the Slice 1
development gate. The 60 Hz device matrix and longer Instruments/energy runs
remain deferred release-qualification work rather than blockers for measured
Swift optimization.

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
Blink-hidden one-off frames skip the cursor buffer unless the repeated geometry
is being admitted to cache, so changing typing and scrolling workloads retain
their original allocation counts.

The complete clean-revision candidate preserved every workload, frame, TRF1,
and pixel invariant. It reduced unchanged-repaint active time by 97.2%,
operation p99 by 96.2%, mesh time by 99.5%, uploads by 99.2%, and Metal buffer
allocations by 98.9%. Resize jitter active time fell 76.1%, with the same 99.2%
upload and 98.9% allocation reductions.

That cross-revision comparison initially reported small typing and
multi-surface footprint flags. Revision `975603e` therefore added an explicit
forced-reference switch and comparator allowance for only that declared
configuration difference. Cache-off and cache-on were then run back-to-back in
fresh processes from the same signed Release binary on the same iPhone 14 Pro,
with five nominal samples per case. The causal A/B result was:

| Workload | Cache off | Cache on | Result |
| --- | ---: | ---: | --- |
| unchanged repaint active time | 741.9 ms | 26.0 ms | 96.5% faster |
| resize-jitter active time | 741.7 ms | 177.9 ms | 76.0% faster |
| typing active time | 758.4 ms | 750.6 ms | 1.0% lower; statistically neutral |
| four-surface scroll active time | 742.1 ms | 744.2 ms | 0.3% higher; statistically neutral |
| eight-surface scroll active time | 977.5 ms | 971.1 ms | 0.7% lower; statistically neutral |

Typing and scroll retained byte-identical uploads and identical allocation,
draw, frame, and atlas-residency counts. Their process footprints were also
neutral (typing +0.3%, four-surface -0.8%, eight-surface -1.6%). The earlier
flags were therefore process/build-order variance, not cache cost. Identical
geometry reuse is accepted and remains enabled by default; the forced-reference
path stays available for future pixel and performance qualification.

### Slice 2: compact Truffle state on Apple

- Extend optional handshake negotiation on the compact listener and Swift
  client.
- Implement and fixture-test `compact-json-v1` decode in Swift with JSON
  fallback.
- Add cursor-based reusable receive buffering after the codec result is known.

Exit gate: the iOS app and desktop demo remain attached to the same session;
JSON and compact paths produce identical logical revisions, TRF1 bytes, and
pixels; truecolor state bytes/decode time materially improve.

Implementation status: optional codec negotiation, legacy fallback, the exact
Swift compact decoder, shared Rust fixture, production decode/publication
metrics, and loopback attachment coverage are complete. A same-signed-binary,
fresh-process A/B at revision `1da30a3` ran five measured Release samples per
codec on an iPhone 14 Pro (`iPhone15,2`, iOS 26.5.2, 120 Hz). Each sample
processed 45 full-grid DOOM Fire logical updates with nominal thermal state,
Low Power Mode off, no failures, and identical TRF1/pixel/frame invariants.

| Metric | JSON | `compact-json-v1` | Result |
| --- | ---: | ---: | ---: |
| source state bytes | 27,923,919 | 5,545,858 | 80.1% lower |
| state decode total | 646.27 ms | 290.59 ms | 55.0% faster |
| active operation wall | 1,569.25 ms | 1,213.50 ms | 22.7% faster |
| operation p50 | 34.60 ms | 26.71 ms | 22.8% faster |
| operation p99 | 44.92 ms | 37.07 ms | 17.5% faster |
| replica publication | 756.46 ms | 757.93 ms | neutral (+0.2%) |
| TRF1 bytes | 5,712,984 | 5,712,984 | identical |
| vertex uploads | 39.8 MiB | 39.8 MiB | identical |
| resident atlas | 20 MiB | 20 MiB | identical |

Bootstrap 95% intervals fully exclude zero for the payload, decode, active,
p50, and p99 improvements. Replica publication, TRF1 apply, mesh build, Metal
submission, buffer allocations, draw calls, atlas residency, and process
footprint are neutral. Slice 2 is accepted. Cursor-based receive-buffer reuse
remains a separate measured experiment; it is not needed to establish the
codec win.

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
