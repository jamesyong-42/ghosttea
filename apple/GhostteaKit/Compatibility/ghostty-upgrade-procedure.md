# Ghostty upgrade procedure

This is the mandatory procedure for changing the Ghostty VT revision used by
the desktop runtime, GhostteaKit, and the production iOS app. A VT upgrade is
one atomic compatibility change: source pin, native artifacts, fonts, terminal
fixtures, release metadata, and device evidence move together. Never merge a
new VT source pin with an old binary or regenerate a golden merely to make a
test green.

Ghosttea's import schema has a separate released-source pin in
`native/ghostty-config.lock.json`. It intentionally does not follow an
unreleased VT snapshot: users migrate from released Ghostty configuration
files. Upgrade that pin only to an immutable release commit, review the config
source independently, and regenerate the source-derived files from a clean
checkout:

```sh
npm run sync:ghostty-config -- --source /path/to/released/ghostty --check
```

The generated compatibility inputs are
`native/ghosttea/crates/ghosttea-config/src/known-keys.txt`,
`native/ghosttea/crates/ghosttea-config/src/x11-rgb.txt`, and
`scripts/sync-ghostty-config-schema.mjs`. A config-pin change may be reviewed
separately from a VT upgrade, but each pin must remain internally consistent.

The offline drift gate is:

```sh
npm run check:ghostty-upgrade
```

It proves that the source, font, downloadable artifact, source BOM, bundled
BOM, runbook, and dynamic workflow artifact identity agree. It cannot approve
behavioral changes; the reviews and runtime gates below do that.

## 1. Prepare and review the upstream change

Start from clean Ghosttea and sibling Truffle worktrees. Record the old and new
full 40-character commits in the upgrade issue. Review every upstream commit
between them, with particular attention to `src/terminal`, `src/apprt`,
`src/font`, `include/ghostty`, `build.zig`, `build.zig.zon`, licenses, minimum
Apple versions, allocator ownership, and thread-safety assumptions.

Update only `native/ghostty.lock.json` first. Keep the Zig version and builder
image unchanged unless the new source requires a separately reviewed toolchain
change. Move the disposable ignored source checkout to the new pin, then let
both bootstrap commands verify it:

```sh
git -C native/vendor/ghostty fetch --depth=1 origin NEW_FULL_COMMIT
git -C native/vendor/ghostty checkout --detach NEW_FULL_COMMIT
npm run bootstrap:ghostty-vt
GHOSTTY_DEVELOPER_DIR=/Applications/Xcode_26.3.app/Contents/Developer \
  npm run bootstrap:ghostty-vt:apple
```

`native/vendor/ghostty` must have the expected `HEAD`, the expected origin, and
an empty status. Stop at **[STOP-SOURCE]** if the commit is not immutable and
reviewed, a dependency cannot be checksum-verified, a license changes, the
source needs an unrecorded patch, or either bootstrap selects a different
revision/toolchain.

## 2. Review the C ABI and wrapper boundary

Diff the new installed headers against the old artifact before adapting code.
Review all changes against:

- `native/ghosttea/crates/ghosttea-vt-sys/src/ghostty_shim.c`;
- `native/ghosttea/crates/ghosttea-vt-sys/build.rs`;
- the Rust ownership and panic boundary in `ghosttea-core` and `ghosttea-ffi`;
- the Swift ownership wrappers in GhostteaKit; and
- response ordering, resize, selection, accessibility, clipboard, mouse,
  keyboard, kitty graphics, and scrollback semantics.

Every allocation/free pair and borrowed lifetime must still be explicit. Stop
at **[STOP-ABI]** for an unexplained header diff, changed enum layout, ownership
ambiguity, possible unwind across FFI, post-panic reuse, or a new callback that
can enter the model concurrently. Adapt and test the wrapper; do not patch the
vendored checkout.

## 3. Rebuild the downloadable and Apple artifacts

Build the desktop/server artifact in the pinned container, normalize its Apple
archive metadata, and first package it as a diagnostic candidate:

```sh
npm run build:ghostty-vt
npm run normalize:ghostty-vt
npm run package:ghostty-vt -- --allow-mismatch
```

Review the candidate's `artifact.json`, SPDX document, headers, library hash,
size, and ABI diff. Update
`native/ghosttea/crates/ghosttea-vt-sys/artifacts.json` with the reviewed
release, filename, URL, SHA-256, size, library SHA-256, and header-tree SHA-256.
Then require a byte-identical rebuild and locked package result:

```sh
npm run build:ghostty-vt
npm run normalize:ghostty-vt
npm run package:ghostty-vt
```

Build and validate every Apple slice, then recompose the local combined binary
used by SwiftPM:

```sh
GHOSTTY_DEVELOPER_DIR=/Applications/Xcode_26.3.app/Contents/Developer \
  npm run build:ghostty-vt:apple
npm run check:ghostty-vt:apple
npm run test:ghostty-vt:apple
npm run test:ios:harness
```

The Apple build replaces `apple/GhostteaKit/Artifacts/ghostty-vt.xcframework`;
the test command composes `ghosttea-apple-native.xcframework`. Both are ignored
build outputs and must be rebuilt on a clean release machine, never copied from
an older pin. The side-by-side Xcode version and SDKs used by Zig are part of
`native/ghostty.lock.json`; do not use the moving default Xcode. Stop at
**[STOP-PACKAGING]** for a nondeterministic downloadable
bundle, hash/size mismatch, missing architecture, stale header, unexpected
symbol, invalid SPDX, or provenance subject that differs from the locked
artifact. The workflow resolves its attestation path from the artifact manifest
and must never contain a revision literal.

## 4. Decide font changes explicitly

`native/fonts.lock.json` intentionally uses the same source commit as
`native/ghostty.lock.json`. Compare the five upstream font files, OFL text,
notices, metrics, and fallback policy. If their bytes did not change, update
only the font source commit and retain the reviewed hashes. If any byte or
license material changed, obtain product/legal review before changing its hash.

After the lock is correct:

```sh
npm run sync:fonts
npm run check:font-parity
npm run build:apple-native
npm run test:font-parity:apple-runtime
```

If shaping intentionally changes, generate the candidate from the
`ghosttea-text` `shaping_fixture` example into a temporary file, review every
metric/glyph/bitmap delta, and only then replace
`native/ghosttea/fixtures/phase2/font-parity.json` and resync resources. Stop
at **[STOP-FONTS]** for unlicensed bytes, a missing script/glyph, unexplained
metrics drift, fallback-policy drift, or a golden change without rendered
desktop and iOS evidence.

## 5. Hold terminal and TRF1 parity

The immutable compatibility inputs are
`native/ghosttea/fixtures/phase1/ansi-baseline.json` and
`apple/GhostteaKit/Sources/GhostteaTerminal/Resources/terminal-visual-golden.json`.
Run the exact model fixture whole-buffer, byte-by-byte, and with irregular chunk
patterns. Require ordered terminal replies and a byte-identical TRF1 frame for
every chunking. Exercise full and incremental frames, snapshot recovery,
Unicode, styled cells, scrollback, selection, accessibility rows, title,
clipboard, mouse modes, key encoding, resize, and graphics behavior.

```sh
cargo test -p ghosttea phase1_desktop_baseline_is_invariant_to_input_chunking
cargo test --workspace
swift test --package-path apple/GhostteaKit
npm test
```

A fixture may change only after the old/new logical model and rendered pixels
are captured side by side and the protocol compatibility impact is documented.
The Phase 1 TRF1 baseline must not change for an internal producer refactor. A
deliberate TRF1 format change requires decoder compatibility and desktop and
iOS migration evidence. Stop at **[STOP-PARITY]** for an unexplained cell,
reply, ordering, cursor, selection, accessibility, glyph, pixel, or TRF1 delta.

## 6. Rebuild release metadata

The exact source revision and any reviewed font/license changes must propagate
through `apple/GhostteaKit/Compatibility/ios-release.cdx.json`, the app-bundled
BOM, notices, and
`apple/GhostteaKit/Compatibility/ios-release-resources.lock.json`:

```sh
npm run update:ios-rust-components
node scripts/check-ios-release-bom.mjs --write
npm run update:ios-release-resources
npm run check:ios-release-bom
npm run check:ios-release-resources
npm run check:ghostty-upgrade
```

Review the generated diff; do not accept unrelated component or license drift.
Stop at **[STOP-PACKAGING]** if the source and bundled BOMs differ, notices omit
a component/license, output contains a machine-local path, or the Ghostty/font
versions are not the exact new commit.

## 7. Performance, device, and shared-session qualification

Compare the old and new builds on the same physical low-end qualification
device, iOS version, Xcode, power state, thermal state, fixture, and sample
duration. Capture feed latency, text-engine lock wait, frame rate, CPU, energy,
resident/peak memory, eight-session scrollback memory, active-SSH backpressure,
atlas occupancy/eviction, and reconnect/resync timing.

```sh
npm run bench:ghostty-vt:apple:matrix
npm run test:ios:device
npm run test:ios:performance
npm run test:ios:app:interop
npm run test:ios:app:restart
npm run test:ios:app:multiscene
npm run check:ios-beta-matrix
```

The production desktop demo and iOS app must concurrently attach to the same
Truffle session. Verify input from the controller, control handoff, resize,
selection, disconnect, foreground resync, and stale-generation recovery, then
also create an independent direct-SSH workspace. Stop at
**[STOP-PERFORMANCE]** for a regression outside the recorded release budgets
or unexplained lock contention. Stop at **[STOP-DEVICE]** for a crash, hang,
lost/duplicated input, broken background recovery, wrong control authority, or
any same Truffle session divergence.

## 8. Release evidence and merge

Run the complete repository gate, make a signed development archive, and
validate its evidence before requesting release-account qualification:

```sh
npm run check
npm run archive:ios:app
npm run validate:ios:release-artifact -- --archive native/build/ios-app/archive/Ghosttea.xcarchive
```

The upgrade review must attach old/new commits, upstream review notes, ABI
diff, artifact manifest and hashes, fixture diffs, performance comparison,
physical-device model/OS, desktop/iOS shared-session evidence, BOM/notices
diff, archive evidence hash, and every gate result. Merge the lock, wrappers,
manifests, intentional fixtures, metadata, and documentation in one commit (or
one inseparable reviewed series). Publish the `ghostty-vt-<revision>` release
only from that reviewed commit and verify its attestations.

## Rollback

**[ROLLBACK]** Revert the entire upgrade series: source/font locks, wrapper
changes, artifact manifest, intentional fixtures, BOM/notices/resource lock,
and evidence references. Rebuild ignored Apple outputs from the restored pin
and rerun `npm run check:ghostty-upgrade`, the parity tests, and affected device
gates. Never roll back only the source pin or only a binary. Do not delete the
failed upgrade evidence; retain it with the stop reason so the next attempt can
distinguish a known incompatibility from a new failure.
