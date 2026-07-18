# iOS terminal memory-pressure contract

**Status:** renderer eviction and full-snapshot recovery implemented; whole-app
session budgeting remains open

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
  sessions;
- an inactive-session policy with deterministic least-recently-used eviction
  or scrollback reduction rather than keeping every native terminal handle;
- accounting for future decoded images and any shared shaping caches;
- compact-tier physical-device measurements for multiple active and background
  sessions; and
- a foreground/resync qualification after a real system memory warning and a
  jetsam recovery test from persisted, secret-free workspace state.

Until those gates exist, a memory warning is a safe presentation-cache release
mechanism, not evidence that the whole app is jetsam-proof.
