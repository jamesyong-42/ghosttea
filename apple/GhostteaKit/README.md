# GhostteaKit

This directory is the Apple-side Phase 0 integration package for the iOS terminal project described in [`draft/ios-terminal-design.md`](../../draft/ios-terminal-design.md).

It proves the pinned upstream `libghostty-vt`, shared Rust text engine, and
production `ghosttea-core` model on Apple targets. `GhostteaCore` is the safe
Swift boundary over the versioned `ghosttea-ffi` C ABI and its ordered effect
arena. The package also contains the host-neutral, demand-driven
`GhostteaTransport` contract and the pinned libssh2/OpenSSL nonblocking SSH
implementation selected by the Phase 0 gate.
`GhostteaSession` is the production orchestration boundary that binds any such
transport to one core terminal while preserving effect, input, resize, and
lifecycle ordering.
The raw Ghostty, Rust, and libssh2 APIs are explicitly not application
contracts.

`GhostteaCredentials` defines the first persistent-secret boundary. It stores
opaque credential references in Apple's device-only, non-synchronizing
data-protection Keychain. The SSH adapter resolves password, private-key, and
passphrase bytes only during authentication and passes private keys to
libssh2's in-memory API without a filesystem path. The policy and
remaining product integration work are recorded in
[`Compatibility/credential-security-policy.md`](Compatibility/credential-security-policy.md).

`GhostteaSession` owns generation-checked connection and read tasks above the
transport-neutral reconnect policy. Inbound data is pulled in bounded chunks,
so a slow terminal or awaited host event naturally withholds further SSH window
demand. Terminal replies and user input share one bounded, strictly sequenced
writer. Core effects reach the host in their original order, while route
changes, background suspension, explicit disconnect, clean exit, and late task
completion remain generation-safe. PTY resize is sent before the matching core
resize and full frame. The first replay tests cover clean drain/exit, native
terminal replies, ordered input, resize propagation, and explicit reconnect.

`GhostteaSSHConfiguration` and `GhostteaSSHTransport` are the production SSH
entry points; the older candidate names remain for compatibility fixtures and
the device harness. `GhostteaSSHSessionFactory` installs SSH-specific, redacted
failure handling and separates transient network failures from authentication,
host-key, credential, and remote-command failures that require user action.
Passwords, private keys, and passphrases resolve from the Keychain only when
authentication begins. The known-host path helper creates an app-private
Application Support directory with complete file protection on iOS, while the
native store retains atomic OpenSSH-format updates. Shell, named tmux, and
named Zellij attach profiles request a PTY and quote session names as single
shell arguments.

The iOS harness now binds that production session directly to the shared core
and Metal terminal surface. Session state, TRF1 frames, hardware/software/mouse
input, scrollback, selection, route changes, and app suspension all cross the
same `GhostteaSession` actor used by product code. Its automatic shell gate
connects to the disposable fixture, emits styled output, exits cleanly, and
validates the marker through native terminal accessibility text before passing.
The dedicated device runner installs a signed build, starts the fixture, waits
for the app's process result, and removes its temporary Keychain credential
before exit.

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
npm run test:ios:production-session
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

The first native-input slice keeps UIKit above the terminal encoding boundary.
`GhostteaHardwareKeyEvent` maps Apple HID usages to desktop-compatible DOM codes
and carries printable text, unshifted layout identity, modifiers, and
down/repeat/up actions. `GhostteaTerminalInputEncoder` sends terminal keys to
the shared Ghostty-backed `GhostteaCore.encodeKey`, while handling the same
small application-binding layer as desktop and exposing configurable Option
behavior. The Metal view can become first responder on tap and reports hardware
presses through `onHardwareKeyEvent`; returning `false` preserves UIKit's normal
responder chain, and responder loss releases handled held keys.

The next native-input slice makes that same Metal view a deliberately small
`UITextInput` document. The document contains only the active marked-text
composition; terminal history remains native-model state and is never mirrored
into UIKit. Committed Unicode is emitted once through `onSoftwareInputEvent`,
while Return, backward delete, and paste reuse the Ghostty-backed key and paste
encoders. Newlines are normalized into ordered Return events, including CRLF,
and terminal bracketed-paste mode therefore applies equally to software paste
and Command-V.

Marked text is drawn as a transient overlay at the retained terminal cursor,
with UIKit candidate and caret geometry anchored to the same position. UTF-16
selection is retained for UIKit, but deletion and character-range queries honor
composed character sequences so emoji and combining text are not split. Smart
quotes, smart dashes, autocorrection, spell checking, and autocapitalization
are disabled because terminal input must preserve user intent. The harness
preview exposes both hardware and software input callbacks and displays their
encoded bytes after its production TRF1 proof.

The terminal's configurable `inputAccessoryView` provides the default
`` Esc Tab Ctrl Alt ← ↓ ↑ → Home End PgUp PgDn | ~ ` `` row in a horizontally
scrollable native control. Ctrl and Alt are visible one-shot latches: the next
supported software-keyboard character, Return, Delete, or accessory key becomes
a normalized `GhostteaHardwareKeyEvent`, then the latch clears. Accessory
symbols carry their physical HID identity and intrinsic Shift modifier. This
keeps terminal modes and the Option-key policy in the shared input encoder;
the accessory view never constructs an escape sequence.

The pointer foundation retains TRF1's mouse-tracking flag and exposes a typed
press/release/motion model above `GhostteaCore.encodeMouse`. View coordinates
are normalized with the same screen, rounded cell, and content-padding geometry
as desktop, including iOS safe-area/content insets. Routing is explicit:
tracking applications own unmodified pointer input, while non-tracking sessions
and the Shift/force-local override belong to view-owned selection. The shared
Ghostty encoder remains the only component that emits mouse protocol bytes.
Gesture recognizers, wheel accumulation, and selection extraction build on this
boundary in the next slice.

The interaction slice installs indirect-pointer pan and hover recognizers plus
a direct-touch long-press selection recognizer. Active mouse-tracking sessions
receive normalized left press/motion/release and hover events; Shift or
`forceLocalSelection` keeps the same drag view-local. Wheel input uses desktop's
2× precise-device multiplier, retains sub-row remainder across events, and caps
remote wheel packets at 12 per update. Non-tracking wheel rows are returned to
the host for native terminal scrolling.

Local selections are stored in absolute scrollback coordinates, clipped back
to the current viewport for Metal rendering, and retained across scroll frames.
The host receives change and commit callbacks; committed extraction goes to
`GhostteaTerminal.selectionText` so wrapped rows, wide cells, and graphemes stay
native-model decisions. Zero-length clicks clear selection. Word/line expansion,
which is absent from the desktop demo, is not added as an iOS-only behavior.
Physical pointer and touch ergonomics remain release evidence.

Selection now also matches the desktop demo at viewport edges and in its edit
menu. While a local drag remains above or below the surface, a cancellable
40 ms task requests one native scroll row and advances the absolute focus when
the returned TRF1 scrollbar frame arrives. Responder loss, backgrounding, and
gesture completion stop the task. A secondary indirect-pointer click presents
UIKit's Copy, Select All, and Paste menu. Copy and completed non-empty drags ask
the host to extract native selection text; Select All highlights the entire
absolute row range and invokes the native `selectAll` extraction path. The
diagnostic harness writes only those user-invoked results to `UIPasteboard`.

The accessibility surface consumes TRF1's dedicated native accessibility rows,
not glyph geometry or an editable UIKit mirror. Each visible terminal row is a
stable `UIAccessibilityElement` with its absolute scrollback row, screen frame,
and frequently-updating static-text traits. The container supports VoiceOver
page scrolling through the host's native scroll callback, Escape-to-unfocus,
and Copy, Select All, and Paste custom actions. The public accessibility
snapshot keeps this row model inspectable without exposing renderer internals.
Automated simulator coverage proves the element tree and actions; physical
VoiceOver navigation and announcement pacing remain release evidence.

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
`LibSSH2Candidate`. The public `GhostteaSSH` implementation sees only opaque C
shim handles and implements `TerminalTransport`; app code enters it through the
production facade while compatibility fixtures retain the original candidate
names. The current evidence and known chained-MFA return-state ambiguity are recorded in
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
