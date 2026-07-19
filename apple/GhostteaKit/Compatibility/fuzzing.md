# iOS native-boundary fuzzing

**Status:** deterministic mutation smoke gates and ASan campaign/evidence runner
implemented; mandatory release-duration evidence remains release-candidate work.

The two hostile-input boundaries are different and are tested independently:

- `ghosttea-ffi` accepts versioned C structures, byte views, terminal input,
  dimensions, coordinates, JSON, and enum-like integers from Swift; and
- `GhostteaFrame` accepts TRF1 envelopes and section payloads received from the
  local core or a desktop-authoritative Truffle session.

Neither gate treats a rejected input as a failure. A failure is a panic/crash,
hang, poisoned handle, invalid owned-buffer triple, effect descriptor outside
its arena, unordered effect sequence, unbounded allocation, or acceptance that
bypasses a structural invariant.

## Stable smoke gates

Run both gates on Apple Silicon with the combined native XCFramework available:

```sh
npm run test:fuzz:smoke
```

They can also be run independently:

```sh
npm run test:fuzz:ffi
npm run test:fuzz:trf1
```

The Rust test uses fixed seed `0x4754454146464931` for 256 stateful operations
across feed, resize, scroll, scroll-to, paste, key, mouse, selection,
accessibility, focus, and alternate-scroll calls. It mixes valid and invalid
render requests, UTF-8 and arbitrary bytes, floating-point bit patterns,
versioned structure sizes, terminal replies, and frame-producing operations.
Every successful update is checked for ordered effects and in-arena payloads;
every rejected call must zero its owned output; no input may return the panic
status or poison the terminal.

The Swift test uses fixed seed `0x5452463146555A5A`. It executes 4,096 mutated
or generated envelopes up to 4 KiB plus 4,096 independent section payloads up
to 2 KiB. Mutations include truncation, valid magic/version with hostile table
bytes, count/length/offset corruption, arbitrary UTF-8, reserved bits, glyph
dimensions/pixel lengths, floats, cursor values, scrollbar arithmetic, and
unknown section kinds. Every envelope that passes the outer decoder is routed
through every applicable section decoder.

Both are ordinary tests, so `cargo test --workspace` and
`swift test --package-path apple/GhostteaKit` retain them even if the convenience
script changes. Fixed seeds make failures reproducible in CI and release
evidence; a minimized failure must be added as a named regression before its
fix is merged.

## First retained finding: impossible selection coordinates

The initial FFI campaign found that `u32::MAX` selection rows could enter
Ghostty's selection formatter and keep a model operation busy for more than a
minute. `TerminalModel` now obtains the retained terminal row count from the
Ghostty adapter and rejects non-select-all endpoints outside that grid before
formatting. The exact maximum-coordinate call is retained ahead of the random
state machine and must return promptly with an empty owned output.

This validation also protects desktop IPC and Truffle callers because they
converge on the same model boundary. `selectAll` remains independent of caller
coordinates and continues to cover retained scrollback.

## Release-candidate campaign

The deterministic smoke gate is intentionally bounded and does not substitute
for a timed sanitizer campaign. Before a release candidate:

1. run the full FFI and Swift suites under AddressSanitizer on the locked
   release toolchain;
2. extend each fixed seed with the checked-in TRF1 golden, production full and
   incremental frames, terminal replies, logical snapshot/patch JSON, and every
   previously minimized failure;
3. run at least one hour per boundary on the release commit, with peak memory
   and per-input timeout enforced;
4. rerun on the exact release archive's native libraries rather than a stale
   debug build; and
5. attach toolchain, seed/corpus hashes, duration, executions, peak memory,
   crash/hang count, and minimized-regression references to release evidence.

Any crash, panic, sanitizer finding, handle poisoning, owned-buffer invariant
failure, input exceeding its time/memory budget, or non-reproducible minimized
case blocks release. Corpus bytes must never contain production terminal data,
credentials, hostnames, or private keys.

The campaign runner makes this procedure executable:

```sh
# Short development qualification; always marked release-ineligible.
npm run test:fuzz:sanitizer

# Clean locked-toolchain release-profile run, one hour per boundary.
npm run test:fuzz:sanitizer:release
```

Both boundaries run under AddressSanitizer with abort-on-finding behavior and a
15-minute per-iteration timeout that includes an isolated cold compiler build.
LeakSanitizer is disabled: enabling `detect_leaks` hangs after the completed
mixed Rust/Zig/C test process on the locked macOS toolchain, while the existing
address sanitizer exits normally. Leak qualification must use Instruments on
the signed application and is not reported as part of this ASan evidence.
The runner hashes the exact FFI source/header/locks and
Swift TRF1 decoder/test corpus, records the immutable source revision and
Xcode/Swift/Rust identities, and emits iteration count, logical executions,
elapsed time, peak resident bytes, and zero-valued crash/hang/finding counters
only after success. The default evidence path is
`native/build/ios-fuzz-campaign/evidence.json`; it contains repository-relative
paths and no terminal or connection data.

`--release` fails unless the tracked worktree is clean, the locked toolchain
gate passes, and each boundary is requested for at least 3,600 seconds. Its
release-profile sanitizer evidence must be retained beside the exact archive
provenance; it does not make a differently built archive eligible by itself.

The runner always uses the locked Xcode toolchain (`DEVELOPER_DIR` +
`XcodeDefault.xctoolchain` `swiftc`/`clang` and the matching macOS SDK), not
whatever `swiftc` happens to be first on `PATH`. It collects evidence in this
order:

1. Apple-clang one-line ASan runtime preflight (isolates OS/Xcode capability).
2. Rust FFI AddressSanitizer campaign (LLVM/Rust runtime; independent of Apple
   clang ASan).
3. Zero-input Swift TRF1 ASan preflight, then the real decoder probe.

On macOS 26.4+ with Xcode 26.3 or older, Apple's AddressSanitizer runtime can
hang in shadow initialization (`FindDynamicShadowStart` /
`InitializeShadowMemory`) before `main` for both C and Swift. Apple documents
this as radar **171762808** and the workaround is **Xcode 26.4+**. The campaign
classifies that hang, still records any completed Rust FFI boundary, writes
`status: blocked` / `releaseEligible: false`, and never claims Swift TRF1 ASan
coverage. LeakSanitizer remains disabled separately: enabling `detect_leaks`
hangs after completed mixed Rust/Zig/C tests on the locked macOS toolchain.

**Unblock for release:** install and review-lock Xcode ≥26.4 (or a later fixed
release) in `ios-toolchain.lock.json`, re-run
`npm run test:fuzz:sanitizer:release` on a clean tree, and retain the resulting
evidence beside archive provenance.
