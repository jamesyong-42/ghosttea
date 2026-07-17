# GhostteaKit

This directory is the Apple-side Phase 0 integration package for the iOS terminal project described in [`draft/ios-terminal-design.md`](../../draft/ios-terminal-design.md).

It proves the pinned upstream `libghostty-vt`, shared Rust text engine, and
production `ghosttea-core` model on Apple targets. `GhostteaCore` is the safe
Swift boundary over the versioned `ghosttea-ffi` C ABI and its ordered effect
arena. The package also contains the host-neutral, demand-driven
`GhostteaTransport` contract and a pinned libssh2/OpenSSL nonblocking candidate.
The raw Ghostty, Rust, and libssh2 APIs are explicitly not application
contracts.

`GhostteaCredentials` defines the first persistent-secret boundary. It stores
opaque credential references in Apple's device-only, non-synchronizing
data-protection Keychain. The SSH adapter resolves password, private-key, and
passphrase bytes only during authentication and passes private keys to
libssh2's in-memory API without a filesystem path. The policy and
remaining product integration work are recorded in
[`Compatibility/credential-security-policy.md`](Compatibility/credential-security-policy.md).

## Build and test

From the repository root on Apple Silicon macOS:

```sh
npm run bootstrap:ghostty-vt:apple
npm run build:ghostty-vt:apple
npm run bootstrap:ssh:apple
npm run build:ssh:apple
npm run build:font-parity:apple
npm run build:ghosttea-core:apple
npm run check:ssh:apple
npm run test:ghostty-vt:apple
npm run test:font-parity:apple-runtime
npm run test:ghosttea-core:ffi
npm run test:ghosttea-core:apple-runtime
npm run test:ghosttea-frame:apple-runtime
npm run test:ssh:fixture
npm run test:ssh:fixture:candidate
npm run test:ssh:fixture:swift
npm run bench:ghostty-vt:apple:matrix
```

Xcode 26 installs its Metal compiler as an optional component. If `xcrun metal`
reports a missing toolchain, install the pinned Xcode component once:

```sh
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer \
  xcodebuild -downloadComponent MetalToolchain
```

The Ghostty build uses a repository-pinned Zig archive and Ghostty commit. The
SSH candidate build uses pinned OpenSSL and libssh2 commits. Both produce and
validate macOS, iOS device, and iOS simulator slices. Before SwiftPM resolves
the package, `compose-ghosttea-apple-native.mjs` combines the VT, SSH, Rust
font-fixture, and production core libraries into one generated XCFramework with
separate `GhosttyVt`, `LibSSH2Candidate`, `GhostteaFontFixtureNative`, and
`GhostteaCoreNative` Clang modules. This avoids Xcode's flattened-header
collision when an application links multiple static binary targets. The test script runs
the Swift proofs on macOS and cross-compiles the relevant targets for the arm64
iOS simulator and device SDKs.

`GhostteaFontProof` loads the five SHA-256-locked font resources from its Swift
package bundle and runs the Rust shaping/rasterization fixture through the C ABI.
The runtime script compares its normalized geometry and glyph bitmap hashes with
the desktop golden on macOS and an iPhone simulator. Pass `--device` directly to
`scripts/test-font-parity-apple-runtime.mjs` to include a connected, unlocked,
signed physical iPhone run.

`GhostteaCore` loads those same package resources and owns runtime and terminal
handles through Swift reference types and a terminal actor. Each update owns a
single aligned native arena whose descriptors retain the core's exact effect
order; callers may copy payloads or borrow them for the duration of a closure.
`npm run test:ghosttea-core:ffi` checks the public header, malformed arguments,
panic poisoning, exact direct-Rust parity, repeated ownership lifecycles, strict
Clippy, and an AddressSanitizer build. The Apple runtime runner checks the same
reply, logical snapshot, accessibility text, and TRF1 frame through Swift on
macOS and iOS. Add `--device` to the underlying runner for physical-device
evidence.

Phase 4's decoder-first `GhostteaTerminal` slice validates TRF1 completely
before Metal sees any size, count, text, or pixel data. The
internal decoder preserves unknown section kinds for compatible extensions,
uses bounded zero-copy frame slices, and decodes every section currently
emitted by `ghosttea-core`. Its Apple runtime gate executes a production frame
on macOS and an arm64 iPhone Simulator; pass `--device` to the underlying
runner to include a signed physical iPhone.

`GhostteaTerminal` also owns retained frame state ahead of GPU resources.
The state machine matches desktop full/incremental sequence classification,
keeps glyph and style catalogs plus row revisions, rejects stale frames, and
enters an explicit full-refresh state after gaps or malformed input. State
replacement is atomic: Metal will never observe a partially decoded frame.

The first Metal resource slice owns one device and command queue plus bounded
2,048-square alpha (`r8Unorm`) and premultiplied-color (`rgba8Unorm`) glyph
atlases. Deterministic shelf placement caches glyph IDs, performs no second
upload for an unchanged visible set, and resets only when the complete visible
working set fits an empty atlas. A set that cannot fit fails before texture
mutation. The fixed resource footprint is 20 MiB; tests cover real production
glyphs, placement, reset, exhaustion, and malformed pixel storage on macOS, and
the automated iPhone Simulator harness executes the real texture upload path.

The first render-pass slice converts retained rows and styles into the same
ordered geometry used by the desktop demo: style backgrounds, view-owned
selection, alpha glyphs, premultiplied color glyphs, decorations, then cursor.
It preserves the desktop cell/origin constants and premultiplied blending,
rejects invalid geometry, renders to an offscreen `rgba8Unorm` target, and reads
pixels back for deterministic same-device verification. Styled ANSI text and a
color emoji exercise every pipeline on macOS and iPhone Simulator. Runtime MSL
compilation was the initial bring-up mechanism and has since been replaced by
the packaged library described below. Offscreen readback remains for the proof;
drawable screenshot goldens remain.

On iOS, `GhostteaTerminalMetalView` is the first public presentation surface.
It is an event-driven `MTKView`: continuous drawing is paused, accepted frames,
drawable-size changes, selection/focus changes, and cursor blink
transitions request individual draws. Full/incremental/stale classification
stays inside the view's retained state, with a callback when the core must send
a full refresh. Drawable submission does not wait on the main run loop. App
backgrounding and memory warnings discard the reconstructible renderer and its
20 MiB atlases while keeping logical terminal state; foreground drawing lazily
rebuilds those resources. The harness embeds the surface as a visible preview
after its renderer fixture runs.

`GhostteaTerminalLayout` converts point-space bounds into a clamped terminal
grid using the desktop demo's 7.83-by-19 cell metrics and two-point padding.
`GhostteaTerminalMetalView` combines UIKit safe-area insets with explicit host
content insets, uses that same value for both Metal's content origin and grid
calculation, and emits a deduplicated `onGridSizeChange` callback on layout,
safe-area, and drawable-size changes. The controller can route that callback to
the production core and SSH PTY without putting transport I/O in the view.

`GhostteaResizeCoordinator` owns that controller-side transaction. It
coalesces layout bursts, resizes the PTY before the core model, advances the
layout epoch, and publishes only a full frame for the newest requested size. A
core failure attempts to roll the PTY back to the last committed grid. The
Metal view can bind its deduplicated grid callback directly to this coordinator
while frame application remains an explicit commit handler owned by the host.

The surface owns the desktop-compatible cursor blink state machine. It uses a
600 ms one-shot task, resets visible on cursor activity or restored
focus/visibility, and schedules only for a visible blinking cursor in a focused,
visible surface. Background/GPU suspension and scene occlusion cancel the task;
`setTerminalVisible(_:)` lets a multi-scene host report per-scene visibility,
and `noteCursorActivity()` restarts the interval after local input. Each toggle
requests one Metal draw rather than enabling a display link.

`GhostteaSceneAttachmentRegistry` supplies the iOS v1 presentation boundary:
one generation-checked attachment token per session, explicit transfer to a
new scene, stale-detach rejection, and per-scene visibility changes. Scene
disconnection drops only presentation ownership; it never destroys the
app-owned session. `GhostteaSceneLifecycleState` separately computes the
aggregate app phase so one background window cannot suspend work still visible
in another active scene. A future simultaneous multi-presentation release can
replace this registry without changing the shared terminal model.

Renderer shaders live as Metal source in the package and are compiled ahead of
time by the local `GhostteaMetalCompilerPlugin`. The plugin declares its AIR and
target-specific `GhostteaTerminal.metallib` outputs as package resources; the
renderer loads that library by URL and has no runtime-source compilation
fallback. This keeps simulator, physical-device, and macOS libraries separate
while making a missing build toolchain or packaged function a build/test
failure.

The initial visual-conformance gate uses the same styled Unicode/emoji TRF1
fixture at 787 by 574 pixels. Same-device runs retain an exact FNV-1a pixel
hash. Cross-device runs compare a 96-by-64 horizontal and vertical perceptual
edge map, mean RGBA channels, and non-background pixel count with explicit
tolerances stored beside the golden. `GhostteaVisualGoldenRecorder` reproduces
the 2.6 KB JSON fixture from the production model and Metal renderer. The
macOS and iPhone Simulator outputs are currently byte-identical; a physical
iPhone and the desktop WebGPU renderer remain required visual-parity evidence.
Regenerate the golden intentionally from the repository root with:

```sh
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer \
  xcrun swift run --package-path apple/GhostteaKit \
  GhostteaVisualGoldenRecorder \
  apple/GhostteaKit/Sources/GhostteaTerminal/Resources/terminal-visual-golden.json
```

The conformance test loads a JSON fixture, feeds it as one buffer, one byte at
a time, and patterned chunks, then compares state, visible text, and ordered
terminal replies. The memory matrix measures macOS physical footprint for one,
four, and eight raw VT sessions before and after upstream scrollback
compression. The iOS harness adds compact/standard whole-process budgets and a
foreground/background compression gate. Standard-tier physical-device evidence
is recorded; compact-device, renderer, active-transport, jetsam, and energy
measurements remain.

No package source should import `GhosttyVt` outside the `GhosttyVtProof` target. This keeps the unstable upstream API from leaking into future app code.

Likewise, only `CGhostteaSSH` and the isolated `GhostteaSSHProbe` may import
`LibSSH2Candidate`. The public `GhostteaSSH` candidate sees only opaque C shim
handles and implements `TerminalTransport`; it is not yet a selected production
transport. The current evidence and known chained-MFA return-state ambiguity are recorded in
[`Compatibility/ssh-candidate-decision.md`](Compatibility/ssh-candidate-decision.md).
The adapter uses one deadline across cancellable Apple DNS-SD resolution and
TCP connect, plus an independent SSH-handshake deadline. Its local
banner-blackhole fixture proves that a stalled handshake observes both its
deadline and Swift task cancellation; the iPhone resolves the Mac's Bonjour
hostname through the same connector.
The candidate connection also exposes diagnostic flow-control metrics. The
live flood gate requires its delivered-byte counters to remain unchanged while
terminal demand is paused. It applies the same invariant to raw encrypted
socket receives, then verifies exact delivery while reporting the libssh2
receive window and socket-wait count.
Strict known-host verification is the default. An opt-in async responder may
make an explicit accept-once decision for unknown or changed keys after showing
the host, port, algorithm, and SHA-256 fingerprint. It may instead atomically
insert or replace the OpenSSH entry while preserving file permissions; the
future app integration owns the confirmation UI.
