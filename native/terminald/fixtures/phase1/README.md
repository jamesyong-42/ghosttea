# Phase 1 desktop parity baseline

`ansi-baseline.json` freezes the desktop output immediately before extracting
`ghosttea-core`. The test feeds its exact bytes through the real Ghostty VT,
captures the logical snapshot and terminal-generated reply, and encodes the
snapshot as TRF1 with fixed identity/sequence metadata.

The same golden frame must result when input arrives as one buffer, one byte at
a time, or two irregular chunk patterns. It covers styled cells, Unicode,
cursor state, mouse tracking, OSC 52 clipboard data, title metadata, scrollbar
state, accessibility rows, and a dynamic-color terminal reply.

Glyph definitions and instances are intentionally empty so this first baseline
does not depend on whichever system font happens to be installed. Phase 2 must
add a shaped-frame golden after the bundled parity font and its license are
selected.

Run the gate with:

```sh
cargo test -p ghosttea phase1_desktop_baseline_is_invariant_to_input_chunking
```

Do not update `expectedFrameHex` during the core extraction. A later update
requires an intentional TRF1 change with corresponding decoder, compatibility,
and parity review.
