# iOS terminal memory-pressure contract

**Status:** renderer recovery, scrollback compression, cold-session LRU,
aggregate physical-footprint enforcement, signed-device over-soft recovery,
and an abrupt process-death restoration gate implemented; compact-device and
real system pressure/jetsam qualification remain open

**Implemented:** 2026-07-18

## Scope

This contract covers reconstructible terminal presentation memory owned by
`GhostteaTerminalMetalView`. It does not claim that the application can ignore
whole-process memory growth, jetsam, or an unbounded number of inactive
sessions.

One live surface currently owns two fixed-size Metal glyph atlases:

- a 2,048-square `r8Unorm` alpha atlas (4 MiB); and
- a 2,048-square `rgba8Unorm` color atlas (16 MiB).

TRF1 retained state also owns CPU-side glyph pixels, style definitions, and
per-row glyph/style render records. These are authoritative only for drawing;
the terminal model or desktop Truffle producer can reproduce them in a full
frame.

## Warning transaction

`UIApplication.didReceiveMemoryWarningNotification` executes one ordered
transaction on the main actor:

1. Preserve frame/session sequencing, row text, cursor, scrollbar, terminal
   modes, accessibility text, and view-owned selection.
2. Discard CPU glyph pixels, style definitions, and row glyph/style records.
3. Mark retained state as awaiting a full snapshot. Incremental frames cannot
   repopulate partially evicted catalogs and are classified as
   `needsFullRefresh`.
4. Destroy the Metal renderer, pipelines, and both atlases. Resident atlas
   bytes become zero immediately.
5. Ask the host for one full refresh and suppress event-driven drawing while
   that refresh is outstanding. This prevents a memory warning from
   immediately reallocating the 20 MiB atlases.
6. Apply the next valid full snapshot atomically, clear the resync state, and
   lazily recreate GPU resources on the subsequent draw.

The production hosts close the callback loop at their authority boundary:

- a Truffle surface calls `GhostteaTerminalAttachment.requestSnapshot()`, so
  the desktop-authoritative session sends a new full frame; and
- a direct SSH surface calls `GhostteaSession.refresh()`, so its local core
  emits a new full frame without transport replay.

Neither path reconnects, changes input authority, or sends terminal bytes to
the remote program. If a surface is detached while recovery is outstanding,
normal attach/foreground snapshot behavior supplies the eventual full frame.

## Inactive scrollback compression

The production core now exposes Ghostty's full scrollback compression through
one serialized path:

```text
Ghostty C API -> C shim -> Rust adapter/model -> ghosttea-ffi -> Swift actor
```

`GhostteaTerminal.compressScrollbackFull()` emits no terminal effects and
changes only Ghostty's storage representation. Adapter, FFI, and Swift tests
fill a terminal with 2,000 deterministic lines and require select-all content
and scrollbar state to remain identical across compression.

The application-owned SSH model observes the UIKit memory-warning notification
once, independently of its number of scenes. It protects every pane in the
selected tab and compresses hidden-tab terminals in stable workspace order.
The synchronous Ghostty scan runs behind each terminal actor; the main actor
awaits it and no active terminal shares that serialization boundary. A failed
compression records only an audited diagnostic code.

This implements the compression step before whole-session eviction. Ghostty
still has no runtime trim operation, so compression cannot enforce the resident
session cap by itself.

## Resident-session cap and cold rehydration

The SSH workspace now separates durable layout identity from its live resource
registry. A pane may retain its session ID, profile binding, grid, and workspace
position while its native terminal, transport actor, last frame, and scrollback
are absent. The coordinator exposes explicit eviction and rehydration operations
that never mutate the workspace document.

After compressing hidden terminals, a warning applies the Phase 0 device-tier
target: four resident sessions on devices with at most 4 GiB of physical
memory, and eight on larger devices. `GhostteaWorkspaceSessionResidency`
selects only hidden-tab sessions, oldest access generation first with workspace
order as a stable tie-breaker. Every pane in the selected tab remains protected
even when that tab alone exceeds the target.

Eviction disconnects the SSH transport, releases the factory's stable-ID claim,
drops the terminal and cached frame, and retains only secret-free reconstruction
metadata. Selecting the cold tab or explicitly reconnecting its pane allocates a
fresh terminal and transport under the same session ID and a fresh native
handle. Rehydration is demand-paused and reports `Reconnect available`; it never
silently opens a new remote shell. Concurrent callers share one rehydration task,
and rehydration waits for eviction teardown to complete before reusing the
stable identity.

Package tests require the coordinator document to remain byte-for-byte equal
across eviction and rehydration, selected panes to be excluded from LRU output,
deterministic oldest-first candidates, and a rehydrated factory resource to use
the original workspace identity with new terminal and session actors.

## Aggregate physical-footprint enforcement

`GhostteaWorkspaceMemoryBudget` is the production source of the Phase 0 compact
and standard policies. The Phase 0 proof imports those values rather than
maintaining a second copy. The app also applies the tier's 3/5 MB initial
scrollback allocation to every newly created and rehydrated terminal.

After renderer notification handlers release reconstructible caches, the
application-owned warning task compresses scrollback and enforces the resident
count target. It then samples Darwin `TASK_VM_INFO.phys_footprint`, which covers
the entire process rather than a sum of guessed Swift, native, transport, and
GPU allocations. If footprint still exceeds the tier's 96/160 MiB soft bound,
the app evicts the remaining hidden SSH sessions one at a time in LRU order and
resamples after each teardown. It stops immediately on reaching the soft bound.

Selected-tab SSH panes and active shared-session presentations remain protected.
If no reclaimable hidden session remains, an audited code distinguishes an
unsatisfied soft bound from the 128/224 MiB hard bound. Sampling failure is also
an audited code. Diagnostics contain no byte counts, session IDs, connection
metadata, or terminal content.

This is aggregate enforcement because its input is the whole process, including
all scenes and future decoded-image or shared-cache allocations. Its current
reclaim vocabulary is intentionally narrower: presentation caches release
themselves and the application may cold-evict hidden direct-SSH resources, but
it will not destroy a selected pane or active remote Truffle attachment.

## Diagnostics and invariants

`GhostteaTerminalSurfaceDiagnostics` exposes presentation-only counters:

- `residentAtlasBytes` is the current fixed GPU atlas allocation;
- `residentGlyphBytes` counts retained CPU glyph pixels;
- `reconstructibleBytesEvicted` accumulates released glyph-pixel bytes;
- `resourceEvictions` and `resourceRebuilds` count GPU transitions; and
- `fullRefreshRequests` counts resync requests.

These counters deliberately do not estimate Swift collection overhead,
terminal-core scrollback, transport buffers, decoded images, or total process
footprint. Whole-process resident-memory gates remain the source of truth for
those categories.

The deterministic retained-state test proves that eviction preserves row text,
rejects a subsequent incremental frame, and recovers only from a full frame.
The iOS harness posts duplicate real UIKit memory-warning notifications after
a live TRF1 render and requires the refresh request to remain coalesced:

```text
atlas:       20 MiB -> 0 -> 20 MiB
glyph bytes: nonzero -> 0 -> nonzero
refreshes:   exactly 1
evictions:   exactly 1
rebuilds:    exactly 2
```

Run the package, iOS SDK, and simulator runtime gates with:

```sh
npm run test:ghostty-vt:apple
npm run test:ios:harness
npm run test:ghosttea-frame:apple-runtime
```

The harness and production app both target iOS 18.1, the minimum supported by
the pinned TailscaleKit dependency.

## Work still required before release

This implementation closes Phase 9's in-app memory-policy logic. Before release,
the policy still needs qualification evidence:

- compact-tier physical-device measurements for multiple active and background
  sessions; and
- a foreground/resync qualification after a real system memory warning and a
  jetsam recovery test from persisted, secret-free workspace state.

The production-app Debug gate `npm run test:ios:app:memory-recovery` now closes
the deterministic over-soft item. It builds and signs the real app, uses an
isolated protected store, creates five demand-paused direct-SSH sessions, and
maps/touches Debug-only memory attributed evenly to the four hidden sessions.
It stops above the active policy's soft limit and below its hard limit, then
calls the exact production memory-warning handler. Passing requires:

- physical footprint at or below the tier's soft limit after recovery;
- exact oldest-first hidden-session eviction order;
- no selected-session eviction or workspace-document mutation;
- cold state only for evicted sessions and idle transport state for survivors;
- one typed eviction diagnostic per eviction and no sampling, eviction, or
  unsatisfied-budget diagnostic; and
- complete file protection plus secret-free workspace restoration bytes.

The host independently parses the numeric marker against the tier limits and
writes redacted, app-binary-hash-bound evidence under
`native/build/ios-memory-recovery/evidence.json`. On the first iPhone 14 Pro
(`iPhone15,2`) run with iOS 26.5.2, the standard-tier footprint moved from
194,085,904 bytes (185.1 MiB) to 152,273,936 bytes (145.2 MiB) after exactly
one hidden-session eviction, below the 160 MiB soft bound. The evidence hash
was `ae4a5acd050e87bb5b6d83f2ebfc185e5789675544d2e05444c841f266310ec8`;
the implementation run correctly records `sourceClean: false`, so it is
diagnostic qualification rather than release-candidate evidence.

The production-app Debug gate `npm run test:ios:app:process-restoration`
automates the safe precursor to that last item. It persists an isolated
demand-paused workspace, is killed by the host without a termination callback,
and on the next signed-device launch requires stable workspace identity, no
connection attempt, complete file protection, secret-free restoration JSON,
and a new `previousTerminationUnrecorded` diagnostic. It deliberately does not
label the host termination as jetsam or close the real system-pressure gate.
The first signed run passed on an iPhone 14 Pro (`iPhone15,2`) with iOS 26.5.2:
the host terminated the prepared app with signal 15, the next launch restored
the demand-paused workspace and emitted the pass marker, and the app exited
zero after deleting its isolated state.

Until the remaining gates exist, the production warning path has deterministic
whole-app recovery evidence on standard-tier hardware, but the app is not yet
qualified as compact-device or jetsam-proof.
