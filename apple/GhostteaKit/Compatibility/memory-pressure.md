# iOS terminal memory-pressure contract

**Status:** renderer recovery, inactive scrollback compression, and bounded
cold-session eviction/rehydration implemented; aggregate byte budgeting remains
open

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

This slice closes Phase 9's renderer memory-pressure and atlas-eviction item.
It does not close the separate whole-application memory-budget deliverable.
Before release, the application still needs:

- an explicit aggregate CPU/GPU budget across all scenes and SSH/shared
  sessions, including enforcement based on measured process footprint rather
  than the resident-count cap alone;
- accounting for future decoded images and any shared shaping caches;
- compact-tier physical-device measurements for multiple active and background
  sessions; and
- a foreground/resync qualification after a real system memory warning and a
  jetsam recovery test from persisted, secret-free workspace state.

Until those gates exist, a memory warning is a safe presentation-cache release
mechanism, not evidence that the whole app is jetsam-proof.
