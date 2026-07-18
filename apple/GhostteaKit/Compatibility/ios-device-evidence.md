# Phase 0 iOS device evidence

This record captures reproducible physical-device observations from the
checked-in `apple/GhostteaHarness` diagnostic app. It does not contain device
serial numbers, UDIDs, credentials, or host-key material.

## 2026-07-16: Ghostty VT and scrollback memory

Environment:

- harness source: commit `8167f5f` (`feat: add iOS phase zero harness`);
- device: iPhone 14 Pro (`iPhone15,2`);
- operating system: iOS 26.5;
- reported physical memory: 5,662 MiB;
- toolchain: Xcode 26.1 with the iOS 26.1 SDK;
- connection: wired, paired, Developer Mode enabled;
- build: automatically signed Debug device build, installed and launched with
  Xcode's CoreDevice tooling.

The VT smoke test passed with the expected result:

```text
100x30, cursor 5,0, key [97]
```

The deterministic 80-column, 5,000-line memory matrix completed as follows.
Values are process physical-footprint deltas captured by the harness, not a
breakdown of every terminal-owned allocation.

| Sessions |  Empty |  Loaded | After full compression | Retained scrollback rows |
| -------: | -----: | ------: | ---------------------: | -----------------------: |
|        1 | 128 KB |  3.3 MB |               1,008 KB |                    4,977 |
|        4 | 512 KB | 13.5 MB |                 4.4 MB |        4,977 per session |
|        8 |   1 MB | 27.1 MB |                 6.6 MB |        4,977 per session |

All sessions reported full scrollback compression support. The loaded result
scaled approximately linearly to eight sessions, while compression reduced the
eight-session delta by about 76%. These measurements cover raw Ghostty VT state
only. They exclude the future Ghosttea model, TRF1 buffers, text shaping,
decoded images, Metal resources, transport state, and application UI budgets.

The physical-device VT build/run gate is satisfied. The same harness still
needs launch-server SSH, adverse-network transition, and complete terminal-stack
memory evidence before Phase 0 can close.

## 2026-07-16: password SSH command

The same signed harness connected over Wi-Fi to the repository's disposable
OpenSSH password fixture, exposed temporarily on the development Mac's trusted
LAN interface. The fixture was returned to its loopback-only default and shut
down immediately after the probe.

The device successfully completed all of the following:

- displayed the unknown Ed25519 host-key challenge before authentication;
- matched its SHA-256 fingerprint against an independently scanned value;
- applied an explicit accept-once decision without persisting the disposable
  fixture key;
- authenticated the `ghosttea` fixture account using the password method;
- executed the harness's default non-PTY command;
- drained the command output through the pull-based Swift transport; and
- observed a clean command exit.

Observed output:

```text
ghosttea-device-ok
Linux 361f033ac616 6.12.54-linuxkit #1 SMP Tue Nov 4 21:21:47 UTC 2025 aarch64 GNU/Linux
```

This satisfies the physical-device password-authentication and basic command
transport baseline. It does not replace representative launch-server coverage,
product credential UI, adverse-network transitions, or the stalled-reader
flow-control fixture already covered on macOS.

## 2026-07-16: data-protection Keychain

The signed harness exercised the production-shaped `GhostteaCredentials`
package against the real iOS Keychain. It generated a random opaque connection
UUID and random non-user secret bytes, then:

1. stored the secret as a device-only, non-synchronizing generic-password item;
2. loaded and compared the bytes exactly;
3. removed the item; and
4. verified that a subsequent load returned no item.

Observed result:

```text
Passed · device-only, non-synchronizing item removed
```

The test left no credential item behind and did not use the user's SSH
credentials. This satisfies the persistent Keychain storage boundary. Async
private-key/passphrase resolution through libssh2's in-memory key API now passes
the macOS OpenSSH fixture; exercising that path with a Keychain-backed key on a
physical device remains a production-promotion gate.

## 2026-07-16: on-demand password resolution

The harness was rebuilt to use `SSHCandidateAuthentication.passwordCredential`
instead of the legacy direct password-string case. Before starting the task it
cleared the editable UIKit field, stored password bytes under an opaque random
credential ID, and configured the transport with only that ID and an async
resolver. `GhostteaSSH` requested the bytes when authentication began and the
harness removed the Keychain item immediately after `connect()` returned.
Failure and cancellation paths perform the same idempotent removal.

The physical iPhone then repeated the independently verified accept-once flow,
password authentication, command execution, clean exit, and output drain:

```text
ghosttea-device-ok
Linux 9e1f3e1ac677 6.12.54-linuxkit #1 SMP Tue Nov 4 21:21:47 UTC 2025 aarch64 GNU/Linux
```

Because credential removal occurs before the harness begins reading command
output, this successful result also proves that immediate post-authentication
deletion succeeded. The disposable LAN fixture was shut down afterward.

## 2026-07-16: encrypted private-key resolution

The signed harness was rebuilt with its private-key diagnostic path and
connected over Wi-Fi to the disposable OpenSSH public-key fixture. Only the
public-key endpoint was temporarily bound to the development Mac's trusted LAN
interface. The generated encrypted Ed25519 fixture key was transferred through
Universal Clipboard and was not a user credential.

Before connecting, the harness cleared the editable private-key and passphrase
fields and stored their bytes as separate device-only, non-synchronizing
Keychain items under random opaque IDs. `GhostteaSSH` resolved both items only
when authentication began, passed the counted private-key bytes to libssh2's
in-memory API, and let its OpenSSL backend derive the public key. No private-key
path or temporary key file was created. The harness deleted both Keychain items
immediately after `connect()` returned and before reading command output.

The physical iPhone authenticated with the encrypted key and passphrase,
executed the default command, observed a clean exit, and drained:

```text
ghosttea-device-ok
Linux ea1647e1f80f 6.12.54-linuxkit #1 SMP Tue Nov 4 21:21:47 UTC 2025 aarch64 GNU/Linux
```

This closes the physical-device opaque private-key/passphrase resolver gate.
The LAN fixture was stopped and removed immediately after the probe, and the
disposable key was cleared from the Mac clipboard.

## 2026-07-16: route-loss cancellation and fresh reconnect

The harness ran a command that emitted a readiness marker and one heartbeat per
second through the disposable password fixture. After the connection was
established, Wi-Fi was disabled from Control Center, moving the phone away from
the fixture's LAN-only route. The user then explicitly cancelled the command.

The retained Swift task propagated cancellation into `GhostteaSSH`, whose
socket-wait cancellation handler called `shutdown(SHUT_RDWR)` before unwinding
the serialized session. The harness reported:

```text
Cancelled in 23 ms
```

This is below the one-second Phase 0 cancellation gate. It proves prompt
physical-device teardown when the active route disappears; it does not claim
that an ordinary SSH session survives a network transition.

The original fixture was removed. After Wi-Fi was restored, a fresh fixture
with a separately verified host key was started and accepted once. A new
connection authenticated through the opaque password resolver and drained:

```text
ghosttea-reconnect-ok
Linux 3caa85b42359 6.12.54-linuxkit #1 SMP Tue Nov 4 21:21:47 UTC 2025 aarch64 GNU/Linux
```

This satisfies the local physical-device route-loss cancellation and explicit
fresh-reconnect baseline. Automatic path monitoring, retry policy, UI state,
and representative launch-server behavior remain product gates. The second
fixture was stopped and removed immediately after the probe.

## 2026-07-16: keyboard-interactive challenge UI

The signed harness added a keyboard-interactive authentication mode backed by
the asynchronous `GhostteaSSH` responder. Only the test-only protocol-metadata
endpoint was temporarily exposed on the trusted LAN. Its fresh Ed25519
fingerprint was scanned independently on the Mac and supplied for the
accept-once decision.

The first physical attempt exposed a real presentation race: dismissing the
host-key sheet while presenting a separate authentication sheet left the
native callback waiting until the fixture rejected the exchange. The harness
was corrected to keep one continuous SSH-interaction sheet alive across the
host-key and authentication stages. The fixture's human-response allowance was
also made explicit, without adding a client-side authentication timeout.

The rebuilt harness then presented the metadata fixture's protocol name and
instruction, maintained prompt order, used a secure field for the no-echo
password prompt, and a visible field for the echo-on verification-code prompt.
Submitting `ghosttea-password` and `123456` authenticated successfully,
executed the configured non-PTY command, and drained:

```text
ghosttea-metadata-command-ok
```

This closes the diagnostic physical-device keyboard-interactive UI gate for a
two-prompt, mixed-echo challenge with nonempty name and instruction. Product UI
promotion, representative 2FA servers, and the explicit
public-key-plus-second-factor product policy remain open.

The rebuilt harness then repeated the flow against a fresh fixture and
independently supplied fingerprint. Instead of entering answers, the user
pressed **Cancel** on the authentication challenge. The sheet routed that
action through the SSH task-cancellation path; the suspended responder and
native callback worker unwound, and the harness reported:

```text
Cancelled in 162 ms
```

This is below the one-second Phase 0 gate and closes the diagnostic on-device
keyboard-interactive cancellation check. Each LAN fixture was stopped and
removed immediately after its probe.

## 2026-07-16: host-key persistence and replacement

The physical iPhone next exercised both persistent host-key decisions against
the disposable password endpoint. For the first fresh key, the user compared
the displayed Ed25519 fingerprint with the independently scanned value, chose
**Accept & Store**, authenticated, and completed the default command.

The fixture was then removed and recreated at the same host and port, producing
a different Ed25519 key. On the next connection the harness identified the
stored-key mismatch, displayed **Host key changed** with the red warning to
verify independently, and showed the newly scanned fingerprint. After the user
chose **Accept & Store**, authentication and command execution succeeded. A
third connection to the unchanged replacement fixture completed without any
host-key prompt, proving that the old entry was replaced and that the new entry
passed strict verification.

This closes the diagnostic physical-device unknown-key persistence,
changed-key warning/replacement, and strict-reconnect UI gate. Representative
launch-server host-key behavior and promotion into the production connection
UI remain open. Both disposable LAN fixtures were stopped and removed
immediately after their respective probes.

## 2026-07-16: command streams and typed termination

The harness command drain was corrected to consume
`SSHCandidateConnection.readCommandOutput`, preserving stdout and stderr as
distinct bounded streams instead of reading only the generic terminal stream.
The signed iPhone build then ran two deterministic commands through the
disposable password endpoint.

The first command emitted one line on each stream and exited with status 37.
The harness displayed `fixture-stdout` as stdout, `fixture-stderr` in its
separate stderr section, and reported `exit 37`. The second command terminated
its remote shell with `SIGTERM`; the harness reported `signal TERM` rather than
conflating the signal with exit zero.

This closes the physical-device separate command-stream, nonzero exit-status,
and remote-signal reporting checks. Those commands did not exercise shell input
half-close or PTY resize. The LAN fixture was stopped and removed immediately
after the probes.

## 2026-07-16: PTY resize and input half-close

The signed harness added two self-validating physical-device session modes. The
PTY probe requested an `xterm-256color` shell at 132 columns by 41 rows, waited
until the remote shell reported `INITIAL 41 132`, resized the live channel to
140 columns by 50 rows, and required `RESIZED 50 140` plus exit zero. The first
attempt established from the fixture that the PTY had resized correctly, but
Debian's interactive `dash` did not run the probe's `WINCH` trap. The probe was
corrected to poll `stty size`, avoiding shell-specific signal behavior while
still validating the actual remote PTY dimensions. The iPhone then displayed:

```text
INITIAL 41 132
RESIZED 50 140
```

The half-close probe opened a non-PTY `cat` command, wrote one fixed payload,
sent SSH input EOF without closing the output side, drained the byte-exact
echo, and required a clean exit zero. The iPhone displayed:

```text
ghosttea-half-close-device-ok
```

These results close the local physical-device PTY allocation, live resize,
input half-close, post-EOF output drain, and clean channel-close gates. The LAN
fixture was stopped and removed immediately after both successful probes.

## 2026-07-16: automatic path and background reconnect state

The signed harness next used the reusable `GhostteaTransport` reconnect reducer
and Network.framework observer on the same iPhone. Before connecting, the UI
reported `Satisfied · Wi-Fi` and lifecycle `Idle`. A long-lived command reached
the connected state through the LAN password fixture.

Without pressing **Cancel**, the user disabled Wi-Fi. Network.framework selected
the cellular route and the harness reported `Satisfied · Cellular · expensive`
plus lifecycle `Reconnect available`. The route event invalidated and cancelled
the active SSH generation before offering the explicit fresh-connection state;
it did not silently reuse the old ordinary SSH session. After Wi-Fi restoration,
the user reloaded the disposable credential, explicitly ran a fresh bounded
command, and confirmed it passed.

A separate long-lived connection exercised application suspension. Sending the
app to the background tore down the active generation. Reopening the app showed
`Reconnect available`; no connection started automatically. This closes the
local physical-device automatic selected-route, background teardown, stale-task
isolation, and explicit-reconnect state gates. Representative launch-server
transitions remain open. The LAN fixture was stopped and removed immediately
after the probes.

The workflow was then promoted into `npm run test:ios:device`. The runner
discovers a single paired physical iOS device and the Mac's Bonjour hostname,
checks device lock state, runs all 25 Swift package tests, builds both iOS SDK
destinations, signs and installs the physical build, passes only the non-secret
fixture host into the launched process, and keeps the fixture alive only while
the runner is attached. A launch attempt that encountered a re-locked phone
proved cleanup on failure; the runner was then changed to postpone LAN exposure
until after all builds and wait for a fresh unlock immediately before launch.

The corrected end-to-end run launched on the iPhone 14 Pro. Its guided probes
automatically selected disposable credentials and commands, enforced sub-second
teardown, and recorded pass/fail. The user performed only the system gestures:
switching Wi-Fi, restoring Wi-Fi, and backgrounding/reopening the app. Automatic
route teardown passed, exact-output explicit fresh reconnect passed, and
background teardown plus foreground reconnect availability passed. Returning
to the runner stopped and removed the fixture.

## 2026-07-16: cancellable Bonjour hostname resolution

The connector replaced its synchronous resolving `getaddrinfo` call with Apple
DNS-SD under the same absolute deadline as TCP establishment. A package test
cancels an actively pending unique `.local.` lookup in approximately 108 ms,
and a separate loopback test connects through `localhost`. The complete macOS
SSH fixture also authenticates through `localhost`, and the harness builds for
the iOS device and simulator SDKs.

The automated physical-device runner now passes the Mac's Bonjour hostname by
default while continuing to expose the disposable fixture only after all
builds and a fresh unlock. It selects the sole team configured in Xcode when no
environment override is supplied and permits automatic profile updates. It
signed, installed, and launched the harness on the iPhone 14 Pro with
`Jamess-MacBook-Pro-9.local.:22022`. The bounded password command resolved that
hostname on-device and returned:

```text
ghosttea-device-ok
Linux … aarch64 GNU/Linux
```

This closes the local physical-device hostname-resolution gate. The runner
then stopped and removed the fixture. Representative launch-server DNS and
split-horizon/VPN behavior remain open.

## 2026-07-16: standard-tier whole-application memory gate

The signed harness introduced explicit initial device tiers and automatically
ran the standard-tier policy on the same iPhone 14 Pro. Standard devices
(reported physical memory above 4 GiB) admit eight resident sessions with a
5,000,000-byte scrollback budget each, a 160 MiB soft application budget, and a
224 MiB hard bound. Compact devices admit four sessions with 3,000,000 bytes
each and 96/128 MiB soft/hard bounds; that tier still requires execution on a
representative low-memory device.

The process-level scenario loaded 5,000 deterministic lines into all eight
sessions, compressed seven background sessions while retaining one active
session, then compressed the active session as the final memory-warning step.
It passed with:

| Measurement                                          | Physical footprint |
| ---------------------------------------------------- | -----------------: |
| Process baseline                                     |            16.5 MB |
| Eight loaded sessions (peak)                         |            44.6 MB |
| One active plus seven compressed background sessions |            30.5 MB |
| All eight sessions compressed                        |            28.5 MB |
| Empty terminal-handle delta                          |             1.9 MB |
| Loaded scrollback delta                              |            26.2 MB |

Every session retained 4,977 scrollback rows. The scenario samples the entire
UIKit process rather than only native allocations, verifies that both
background and active compression reduce physical footprint, and enforces the
soft/hard bounds in code. Transport buffers were idle at zero for this
scenario. The Phase 0 app has no TRF1 renderer, decoded images, or Metal atlas,
so those categories remain explicitly unavailable rather than being reported
as zero-cost implementation. They become measurable gates after the renderer
exists.

## 2026-07-17: active SSH backpressure and whole-process memory gate

The device runner installed a signed build that automatically ran the VT
whole-application scenario above and then connected to the disposable password
fixture for an active transport scenario. The server command emitted exactly
33,554,432 zero bytes. The app intentionally made no channel-read request for
750 ms, sampled both the instrumented transport and the complete UIKit process,
then drained output in bounded 64 KiB reads without accumulating it in Swift.

The gate passed with:

| Measurement                              |                        Result |
| ---------------------------------------- | ----------------------------: |
| Process footprint before connection      |                       26.7 MB |
| Connected and stalled footprint          |                       16.9 MB |
| Footprint after lossless drain           |                       17.0 MB |
| Standard-tier soft budget                |                        160 MB |
| Application-delivered bytes during pause |                         0 → 0 |
| Raw socket bytes received during pause   |                 1,957 → 1,957 |
| Output drained                           | 33,554,432 / 33,554,432 bytes |
| Receive window while paused              |         2 MiB / 2 MiB initial |
| Socket readiness waits after drain       |                         1,115 |

The lower connected sample reflects reclamation after the preceding automatic
VT memory scenario; the enforced claims use the absolute stalled footprint and
nonnegative growth, not an assumption that samples must increase. Most
importantly, neither application delivery nor socket receipt advanced while
demand was paused. This is direct physical-device evidence that inbound
backpressure reaches the transport boundary rather than filling an unbounded
Swift stream. Resuming demand drained the fixture output byte-for-byte while the
whole process remained far below the standard-tier soft limit. The runner then
removed the fixture.

## 2026-07-17: bundled-font shaping and raster parity

Phase 2 added a stateless C probe around the shared Rust `ghosttea-text` engine
and composed it into the unified Apple native XCFramework. `GhostteaFontProof`
loads the package's SHA-256-verified JetBrains Mono Nerd Font regular, bold,
italic, and bold-italic faces plus Noto Color Emoji fallback. It generates the
same normalized fixture used by desktop, covering ligatures, styled text,
combining marks, wide/missing glyph behavior, emoji fallback, geometry, and
glyph bitmap hashes.

The automated runner first passed the fixture through the XCFramework on macOS
and an arm64 iPhone simulator. It then signed and installed the same harness on
the connected iPhone 14 Pro running iOS 26.5. The app launched with a test-only
automation flag, ran the fixture through bundled Swift package resources and
the Rust C ABI, emitted:

```text
GHOSTTEA_FONT_PARITY_PASS
```

and exited without manual result interpretation. The runner reported:

```text
iPhone 14 Pro bundled-font runtime parity passed.
```

Reproduce all Apple runtime gates with an unlocked connected device by running:

```sh
node scripts/test-font-parity-apple-runtime.mjs --device
```

The exact normalized shaping geometry and raster bitmap digests now match the
checked-in desktop golden on macOS, arm64 iOS simulator, and physical arm64 iOS.
This satisfies the Phase 2 exit gate. System-font discovery remains explicitly
non-parity, and final App Store font-license review remains on the release
checklist.

## 2026-07-17: production core C ABI and Swift ownership

Phase 3 introduced `ghosttea-ffi` as the application-facing native boundary
over the extracted `ghosttea-core` model. Its versioned header exposes opaque
runtime and terminal handles and represents every update as one aligned owned
arena containing contiguous ordered-effect descriptors and their payloads.
The matching `GhostteaCore` Swift product copies thread-local diagnostics,
owns native lifetimes through reference types, serializes terminal mutation in
an actor, and scopes no-copy payload access to the arena lifetime. It loads the
same locked font bytes proven in Phase 2.

The automated native gate compiled the public header as C with static layout
assertions and warnings as errors. Rust unit tests covered malformed arguments,
output zeroing, descriptor ordering and offsets, panic containment, terminal-
local versus shared-runtime poisoning, and rejection of every post-panic
operation except inspection and destruction. An exact direct-Rust/C-ABI
fixture compared binary terminal replies and TRF1 bytes plus semantic logical
JSON, selection, and accessibility results. Both the ordinary and macOS
AddressSanitizer builds completed 100 runtime/terminal/update ownership loops
without findings.

The final Apple artifact records ABI/package version, source state, Rust and
Xcode versions, the public-header SHA-256 digest, and each slice's archive
digest. It contains macOS arm64, iOS arm64, and iOS Simulator arm64 slices. The
Swift gate completed another 100 ownership loops and produced exact ordered
effects on macOS. The signed harness builds for both iOS SDK destinations and
the iPhone 17 Pro arm64 simulator emitted:

```text
GHOSTTEA_CORE_PASS
```

The same signed build was installed and launched on the paired iPhone 14 Pro.
Apple's lock-state service repeatedly failed to allocate its transient RSD
resource even while the phone was unlocked, so the runner was corrected to use
the authoritative install/launch operation and retry that operation directly.
The physical process emitted:

```text
GHOSTTEA_CORE_PASS
```

and exited with status zero. Reproduce the physical gate with:

```sh
node scripts/test-font-parity-apple-runtime.mjs --core --device-only --skip-build
```

## 2026-07-17: strict TRF1 decoder vertical slice

Phase 4 began with the decoder boundary rather than Metal allocation. The new
internal Swift decoder accepts at most 16 MiB, checks the TRF1 magic and version,
uses overflow-safe section-table arithmetic, and validates every currently
emitted payload: glyph and style definitions, atomic row replacements, cursor,
accessibility text, scrollbar state, and clipboard writes. UTF-8 is strict;
glyph pixels must match dimensions and format; reserved bytes, counts, and
fixed payload lengths are enforced. Collection reservations are bounded by the
already validated section length, and section `Data` values retain slices of
the original frame instead of copying every payload.

Five Swift tests cover the same manual accessibility shape used by the desktop
decoder tests, a real production-core frame with styled Unicode and glyph
bitmaps, invalid envelope bounds and oversized packets, invalid UTF-8/counts/
pixels/reserved fields, and clipboard/scrollbar bounds. The nine existing
TypeScript decoder tests continue to pass. `GhostteaTerminal` then inspected a
fresh Rust-produced frame in the iPhone harness; macOS and the arm64 iPhone 17
Pro Simulator both emitted:

```text
GHOSTTEA_TRF1_PASS
```

The updated harness also compiles for the physical iOS arm64 SDK. The same
signed iPhone 14 Pro process decoded its production frame, emitted:

```text
GHOSTTEA_TRF1_PASS
```

and exited with status zero. The decoder gate is automated with:

```sh
npm run test:ghosttea-frame:apple-runtime
```

## 2026-07-17: retained TRF1 renderer state

The next Phase 4 slice moved the desktop worker's sequencing rules into an
atomic Swift retained-state transition. It stores the latest accepted session,
layout, sequence, terminal revision, dimensions, rows, per-row revisions and
glyph/style placements, glyph/style catalogs, cursor, and scrollbar. Stale
frames are ignored. A gap, missing initial full snapshot, non-full session
replacement, or any decode/semantic failure preserves the last good state and
requires a full refresh. A valid full frame completes recovery and resets the
catalogs at session/resync boundaries.

Five additional Swift tests use production Rust frames to cover full followed
by incremental state, duplicate stale rejection, sequence-gap recovery, refusal
of incremental frames while awaiting resync, atomic malformed-row failure,
older row-revision suppression, missing initial snapshots, and full session-
epoch replacement with catalog reset. The complete ten-test frame suite passes
on macOS. The harness applies a full frame, an incremental frame, and a repeated
stale frame; the arm64 iPhone 17 Pro Simulator emits `GHOSTTEA_TRF1_PASS`, and
the same harness compiles for the physical iOS SDK. The signed physical build
was installed; its automated launch is a local unlock retry rather than an
implementation gate.

## 2026-07-17: bounded Metal glyph atlases

The next Phase 4 slice created one Metal device/command-queue owner and
separate 2,048-square `r8Unorm` alpha and `rgba8Unorm` premultiplied-color glyph
atlases. Their fixed combined allocation is 20 MiB. Glyph IDs receive
deterministic shelf locations with a one-pixel gutter. Synchronization
preflights the complete visible working set, avoids uploads for cache hits,
resets only when that set fits an empty atlas, and rejects invalid pixel storage
or an unrepresentable set before partial texture mutation.

Five focused Metal tests exercise real Rust-produced glyphs, texture formats,
placement, zero-byte cached synchronization, reset, exhaustion, and malformed
storage. The complete GhostteaKit suite passes 43 tests on macOS. The harness
builds for arm64 iOS Simulator and physical-device SDK destinations. On the
arm64 iPhone 17 Pro Simulator it created and uploaded the real textures,
validated the 20 MiB budget and cache hit, emitted:

```text
GHOSTTEA_TRF1_PASS
```

and exited successfully. A physical-device rerun is useful evidence before
release, but it is not a blocker for beginning the render-pipeline slice.

## 2026-07-17: ordered offscreen Metal render pass

The first render pass consumes atomic retained state and emits desktop-ordered
buffers for style backgrounds, view-owned selection, alpha glyphs,
premultiplied-color glyphs, underline/strikethrough decorations, and cursor. It
uses the desktop demo's cell geometry, origin, style resolution, and
premultiplied blend factors. Invalid glyph geometry is rejected before command
encoding. The bring-up target is an offscreen `rgba8Unorm` texture whose pixels
are read back and hashed after command-buffer completion.

One new focused test renders styled ANSI text plus a color emoji, proves a
reversed selection has the same pixels as its normalized range, and verifies
that repeated retained state keeps both pixels and atlas contents stable. The
complete GhostteaKit suite now passes 44 tests on macOS. Both iOS SDK builds
pass. On the arm64 iPhone 17 Pro Simulator, the automated harness compiled the
Metal shaders, executed rectangle, alpha-glyph and color-glyph pipelines,
validated non-background output and a stable rerender hash, emitted:

```text
GHOSTTEA_TRF1_PASS
```

and exited successfully. This is renderer bring-up rather than screenshot
conformance: runtime shader compilation, offscreen readback, drawable
presentation, lifecycle scheduling, and cross-device pixel goldens remain.

## 2026-07-17: event-driven iOS Metal surface

`GhostteaTerminalMetalView` now presents retained frames through a public
`MTKView` surface with continuous drawing disabled. Accepted frames,
drawable-size changes, selection/focus changes, and host-driven cursor blink
visibility request individual draws; duplicate stale frames do not. The view
surfaces a full-refresh callback for gaps and malformed frames. Drawable
command buffers are submitted without a main-run-loop completion wait, while
the offscreen pixel proof retains its synchronous completion boundary.

The surface observes app background and memory-warning notifications. It
evicts reconstructible pipelines and both atlases while retaining logical rows,
styles, glyph definitions, and sequencing state. Resume recreates those GPU
resources lazily, so no terminal replay is required. The iPhone Simulator
harness automatically applied full, incremental, and stale frames and proved
two accepted frames, one stale frame, and a resource transition of 20 MiB to
zero to 20 MiB with one eviction and two builds. Both iOS SDK destinations
compile, and the arm64 iPhone 17 Pro Simulator again emitted:

```text
GHOSTTEA_TRF1_PASS
```

The harness also contains a SwiftUI-hosted live Metal preview for manual visual
inspection. Safe-area-to-terminal resize negotiation, real scene detach/attach
gestures, multi-window ownership, and screenshot conformance are subsequent
Phase 4 gates.

## 2026-07-17: safe-area and rotation grid negotiation

The presentation surface now derives terminal columns and rows from point-space
bounds using the desktop renderer's 7.83-by-19 cell and two-point padding.
UIKit safe-area insets and explicit host content insets are combined once and
fed to both the grid calculation and Metal content origin. Layout,
safe-area-inset, and drawable-size changes produce a deduplicated callback for
the controller to route into core and SSH PTY resize operations; transport I/O
remains outside the view.

Two pure tests prove the exact 100-by-30 desktop fixture geometry, conservative
one-cell behavior for degenerate input, `UInt16` clamping, and representative
iPhone portrait and landscape results. The complete GhostteaKit suite now
passes 46 tests on macOS. Both iOS SDK builds pass. The arm64 iPhone 17 Pro
Simulator exercised the actual view callback and observed 49-by-39 portrait
and 92-by-19 landscape grids before completing the existing render and GPU
lifecycle gates and emitting:

```text
GHOSTTEA_TRF1_PASS
```

A physical rotation gesture and controller-side ordering of core resize, PTY
resize, and the resulting full render frame remain release evidence.

## 2026-07-17: serialized core and PTY resize

`GhostteaResizeCoordinator` now sequences the view's grid callback through the
host-owned transport and production model. It sends PTY resize first, advances
the core layout epoch second, requests a full frame, and publishes only if that
size is still the newest request. Intermediate rotation sizes are overwritten
while an operation is in flight. A core failure attempts PTY rollback to the
last committed dimensions.

Three tests prove a real replay PTY and production-core resize yields a full
100-by-30 frame at layout epoch two, a 90/91/92-column burst executes only 90
and 92 and publishes only 92, and a core failure records target and rollback
PTY sizes. The complete GhostteaKit suite passes 49 tests on macOS. iOS SDK and
simulator runtime validation use the same public package graph; real SSH
rotation and disconnect-during-resize remain device integration evidence.

## 2026-07-17: cursor blink timing

`GhostteaTerminalMetalView` now owns the same cursor timing rules as the desktop
render worker: a 600 ms one-shot chain runs only for a visible, blinking cursor
on a focused and visible surface. Cursor changes and input activity reset the
cursor to visible. Unchanged terminal frames leave the existing deadline alone.
Focus or visibility restoration resets and restarts the chain; loss of focus,
scene occlusion, view detachment, backgrounding, or explicit GPU suspension
cancels it.

Two main-actor tests exercise toggles and rescheduling without wall-clock waits,
including reset transitions, static and hidden cursors, focus, and surface
visibility. The event-driven Metal view receives one invalidation per actual
blink transition. The complete GhostteaKit suite passes 51 tests on macOS, and
the harness builds the package for arm64 simulator and physical-device SDKs.
Physical multi-scene evidence remains a release gate because the owning scene
controller must route activation changes through `setTerminalVisible(_:)`.

## 2026-07-17: precompiled Metal shader library

The renderer no longer embeds or compiles an MSL source string at runtime.
`GhostteaMetalCompilerPlugin` invokes the Xcode `metal` and `metallib` tools and
packages target-specific AIR and `GhostteaTerminal.metallib` resources. The
renderer requires that library by bundle URL; there is no source fallback.
Xcode's implicit compilation is excluded, leaving the plugin as the single
shader build path in SwiftPM and Xcode builds.

The macOS proof loads the packaged library, verifies all five vertex/fragment
functions, and retains its deterministic pixel result; the complete suite now
passes 52 tests. Arm64 simulator and physical-device SDK bundles contain
distinct compiled libraries. With only the plugin-produced library present,
the iPhone 17 Pro Simulator completed the full renderer automation and emitted:

```text
GHOSTTEA_CORE_PASS
GHOSTTEA_TRF1_PASS
```

Xcode 26.1 requires its optional Metal Toolchain component on the build host;
the package README records the one-time installation command.

## 2026-07-17: initial visual golden

The production styled Unicode/emoji frame now has a reproducible visual golden.
It records the exact 787-by-574 reference pixel hash and a portable 96-by-64
horizontal/vertical edge fingerprint, mean RGBA channels, and non-background
pixel count. The declared tolerance permits at most 48 changed edge bits, one
mean-channel level, and 128 content pixels; dimensions must remain exact. A
fully erased terminal with the correct background and dimensions fails the
gate.

`GhostteaVisualGoldenRecorder` regenerates the 2.6 KB JSON through the
production core and packaged Metal renderer. The complete GhostteaKit suite
passes 53 tests on macOS. The arm64 simulator and physical-device SDK builds
pass. The independently compiled iPhone 17 Pro Simulator output is byte-exact
with the macOS reference:

```text
GHOSTTEA_VISUAL_PASS hash=3f7623275f6bf056 edges=0 channels=0 content=0
GHOSTTEA_TRF1_PASS
```

The paired iPhone 14 Pro was visible over the local network but its CoreDevice
tunnel was disconnected, so this slice does not claim a physical-GPU pass.
Physical-device and desktop-WebGPU comparisons remain visual-parity gates.

## 2026-07-17: generation-checked scene ownership

The iOS v1 presentation contract is now executable rather than controller
convention. `GhostteaSceneAttachmentRegistry` allows one current presentation
token per session. Moving a session reports and invalidates the old token, so a
late detach from the previous scene cannot remove the new owner. Phase changes
affect only current attachments, and disconnecting a scene drops presentation
ownership without claiming or destroying the application-owned session.

`GhostteaSceneLifecycleState` computes the application phase across all
connected scenes. The harness routes global SSH/session lifecycle callbacks
through that aggregate and routes each WindowGroup's own active state to its
Metal view. A unit test proves that backgrounding one of two active scenes does
not suspend the app; only the last foreground scene leaving reaches the
background state.

The full GhostteaKit suite passes 56 tests with Metal and local-loopback access.
The harness compiles for arm64 iOS Simulator and physical-device SDKs. The
iPhone 17 Pro Simulator installs the rebuilt app and passes the production
TRF1/Metal marker. Physical iPad Stage Manager transfer, stale teardown, and
scene-disconnect gestures remain release evidence; they are recorded as a
future release gate rather than blocking the next implementation slice.

## 2026-07-17: hardware-key parity boundary

The first Phase 5 slice maps iOS hardware-key USB HID usages to the same
DOM-style physical codes consumed by the desktop path. Printable text and
unmodified layout identity remain separate; special keys such as arrows discard
UIKit private-use characters instead of misreporting them as terminal text.
Down, repeat, and up actions retain the shared Ghostty ABI values.

`GhostteaTerminalInputEncoder` delegates terminal bytes to the production
Ghosttea core. The application layer above it matches the existing desktop
natural-text-editing bindings, suppresses their paired key-up events, routes
clipboard/workspace commands without sending them to the PTY, and permits
Option to be configured as terminal Alt instead. The event-driven Metal view is
tap-focusable and forwards `UIPress` values through a host callback, falling
back to UIKit for declined keys. Responder loss synthesizes releases for
handled held keys so focus changes cannot strand enhanced keyboard state.

Two new tests cover HID mapping, keyboard-layout identity, letters, Ctrl-C,
arrows, Option word movement, Command-paste, key-up suppression, Unicode text,
and paste encoding. The complete package suite contains 58 tests. Both iOS SDK
builds pass, and the rebuilt iPhone 17 Pro Simulator retains the production
TRF1/Metal automation marker. Software keyboard, marked-text/IME composition,
and physical hardware-key matrix evidence remain Phase 5 work.

## 2026-07-17: software keyboard and marked-text boundary

The second Phase 5 slice makes the production Metal surface conform to
`UITextInput`. Its UIKit document intentionally contains only the current
marked-text composition and selection; it does not duplicate the terminal
screen or scrollback. Marked text remains local until commit, is rendered at
the retained terminal cursor, and reports cursor-anchored caret and candidate
geometry. Backward deletion and UIKit character-range queries use composed
character sequences so multi-scalar emoji are not split.

Committed Unicode, Return, backward delete, and paste are expressed as ordered
software-input events. Return and delete reuse the shared Ghostty key encoder,
and paste reuses terminal-mode-aware paste encoding, including bracketed paste.
The terminal surface disables UIKit spelling and smart-text transformations.
The harness preview now accepts real software/IME and hardware input after its
TRF1 proof and displays the resulting bytes or application action.

Two package tests cover local Japanese composition, replacement, unmarking,
composed emoji deletion/range queries, CR/LF/CRLF ordering, terminal deletion,
Unicode encoding, Ghostty Return/Delete bytes, empty paste, and bracketed paste.
The simulator automation drives the real `UITextInput` methods and checks
marked-state lifetime, ordered callbacks, cursor geometry, and terminal-safe
keyboard traits. The package suite now contains 60 tests; both iOS SDK builds
and the iPhone 17 Pro production TRF1/Metal marker pass. Physical-device CJK,
combining-mark, emoji, dictation, third-party software-keyboard, and hardware
keyboard matrix runs remain release evidence.

## 2026-07-17: normalized terminal accessory row

The third Phase 5 slice supplies a configurable, horizontally scrollable
`inputAccessoryView` with Esc, Tab, one-shot Ctrl/Alt, arrows, Home, End,
Page Up/Down, pipe, tilde, and backquote. Every non-modifier action constructs a
normalized HID-style key event; UIKit contains no terminal escape sequences.
Ctrl and Alt can modify the next supported software-keyboard character, Return,
Delete, or accessory key and then clear. Marked-text composition and responder
loss also clear them to avoid leaking a stale terminal modifier into later
input. Symbol keys retain their underlying physical key and Shift state.

The new package test proves modifier toggle/consumption, Ctrl+C, Alt+Left,
shifted pipe, unsupported Unicode fallback, and shared Ghostty encoding. The
simulator automation exercises the production Metal view, validates the
ordered normalized events and latch clearing, and confirms the configurable
accessory view is present. The package suite now contains 61 tests; both iOS
SDK builds and the iPhone 17 Pro production TRF1/Metal marker pass. Physical
touch ergonomics and the final device input matrix remain release evidence.

## 2026-07-17: pointer routing and mouse-encoding foundation

The fourth Phase 5 slice retains TRF1's application mouse-tracking flag and
adds typed press, release, motion, button, modifier, and geometry values above
the existing native mouse encoder. The Metal view converts safe-area-aware
points to clamped viewport cells and emits the same rounded 8×19 cell geometry
as desktop. Routing resolves to remote application input only when tracking is
active and no force-local override is present.

The new package test proves local/remote/force-local ownership, suppression
while tracking is disabled, tracking transitions carried by full TRF1 frames,
and the byte-exact SGR press packet from Ghostty. Simulator automation validates
the production view's landscape screen dimensions, content padding, viewport
cell mapping, and non-tracking local-selection decision. The package suite now
contains 62 tests; both iOS SDK builds and the iPhone 17 Pro production
TRF1/Metal marker pass. UIKit gestures, wheel momentum, scrollback selection,
and device pointer ergonomics remain the next implementation and release gates.

## 2026-07-17: UIKit pointer, wheel, and local selection

The fifth Phase 5 slice installs indirect-pointer pan and hover recognizers and
a direct-touch long-press selection recognizer on the production Metal view.
Remote ownership emits normalized Ghostty mouse events; Shift or explicit
force-local mode retains local selection. Wheel normalization matches desktop's
2× multiplier and sub-row accumulation, caps remote wheel floods at 12 packets,
and returns local row deltas to the host's native scroll path.

Selections now live in absolute scrollback coordinates and are clipped into the
visible viewport solely for rendering. A zero-length click clears selection;
non-empty completion invokes a host effect that extracts text through the
native terminal model. The diagnostic harness wires remote mouse encoding,
native scroll updates, and native selection extraction to its retained terminal
actor. The new package test covers forward/reverse viewport clipping, offscreen
selection removal, and byte-for-byte desktop wheel accumulation.

The complete package suite now contains 63 tests. Both iOS SDK builds and the
iPhone 17 Pro simulator production marker pass, including recognizer presence,
absolute selection state, local ownership, and coordinate assertions. Physical
trackpad/mouse/touch ergonomics, edge autoscroll, word/line expansion, and
secondary-button menus remain device and implementation gates.

## 2026-07-17: selection edge scrolling and edit menu

The sixth Phase 5 slice matches the desktop demo's remaining local-selection
behavior. A drag beyond the vertical bounds requests one native scroll row
every 40 ms and moves the absolute focus after each returned TRF1 scrollbar
frame. Gesture completion, responder loss, and backgrounding cancel the task.
The production surface now exposes a secondary-click UIKit menu with Copy,
Select All, and Paste. Copy and completed selections use native extraction;
Select All retains a full absolute highlight and uses Ghostty's native
`select_all` path. The harness owns the explicit `UIPasteboard` write.

The existing pointer conformance test now also covers edge direction, bounded
full-range construction, and empty-terminal handling. Both iOS SDK builds pass
under Swift 6, including the pre-concurrency bridge required by UIKit's legacy
edit-menu delegate annotation. The complete 63-test suite and iPhone 17 Pro
simulator marker pass. Physical secondary-click, edge-hold timing, clipboard
confirmation, and touch ergonomics remain device evidence; word/line expansion
is not a parity claim because it is absent from the desktop demo.

## 2026-07-17: native terminal accessibility surface

The seventh Phase 5 slice retains the producer's dedicated TRF1 accessibility
rows alongside rendered row state. Its public snapshot assigns every visible
row an absolute scrollback coordinate and a deterministic visible-range
description. The production Metal view exposes those rows as native
`UIAccessibilityElement` static text with safe-area-aware frames and stable
identifiers. It does not scrape shaped glyphs and does not make scrollback an
editable UIKit document.

The accessibility container returns page-scroll deltas sized to the current
live grid and exposes Escape-to-unfocus plus Copy, Select All, and Paste actions.
Copy and selection still route through native model extraction; page scrolling
still routes through the host's terminal actor. The SwiftUI harness no longer
adds a wrapper label that could flatten the native row tree.

The new package test proves native row text, absolute coordinates, visible-range
descriptions, and empty-terminal behavior. The iPhone 17 Pro simulator drives
the production view and verifies a summary element plus 30 native row elements,
stable identifiers, title/connection/selection context, focus/reconnect and
row-action catalogs, and a 19-row page callback after landscape layout.
The complete package suite now contains 64 tests, and both iOS SDK builds pass.
Physical VoiceOver row navigation, output-announcement pacing, rotor behavior,
and action confirmation remain release evidence before the Phase 5 exit gate is
declared complete.

## 2026-07-17: production reconnectable-session foundation

The first Phase 6 slice adds the transport-neutral `GhostteaSession` package.
It binds one core terminal to a fresh-connection factory, generation-checks all
connect/read/teardown work, and drives the already-tested reconnect policy for
path changes, app suspension, explicit disconnect, clean completion, and
failure. A reconnect is only offered; a new connection still requires an
explicit request.

Inbound bytes remain pull-based and bounded. Each chunk is fed to the native
model only after the previous ordered effects complete. Terminal replies and
user input enter the same bounded sequenced writer under a host operation gate,
and PTY resize precedes core resize and its full frame. Lifecycle state is
published only after ordered teardown effects finish, preventing a replacement
UI from racing a still-live old generation.

Four macOS replay tests cover a cursor-position terminal reply across
three-byte input chunks, exact clean exit status, serialized raw and shared-core
key writes, PTY/core resize, route-change teardown, explicit reconnect, and
generation advance, plus redacted non-reconnectable write failure. The complete
package suite contains 68 tests. This slice
has no new UIKit or Metal behavior; dual iOS SDK compilation is retained as its
Apple portability gate, while live SSH/TUI and physical lifecycle evidence
remain later Phase 6 work.

## 2026-07-17: production SSH session facade

The second Phase 6 slice promotes the Phase 0-selected libssh2 implementation
behind stable `GhostteaSSHConfiguration` and `GhostteaSSHTransport` names while
leaving the candidate API available for compatibility fixtures. A production
session factory now installs SSH-specific reconnect and display policies:
socket and timeout failures may offer reconnect, while authentication,
host-key, missing-credential, invalid configuration, and failed remote-profile
startup require user action. Display strings are fixed categories and never
include server-controlled or native libssh2 messages.

Password, in-memory private-key, and optional passphrase authentication now
have direct Keychain-backed constructors. Their opaque credential IDs are
captured in the connection configuration and their secret bytes are resolved
only when authentication begins. The known-host helper prepares an app-private
Application Support directory and applies complete file protection on iOS; the
existing native known-host writer continues to own atomic file replacement and
permission preservation.

Shell, named tmux, and named Zellij profiles map to PTY-allocating remote
commands. Names are passed as one POSIX-shell argument with embedded quotes
escaped, and empty or NUL-containing names are rejected before connection.
Five new package tests cover the exact attach commands, injection-resistant
quoting, Keychain-only production authentication, known-host path containment,
redacted failure policy, and the session configuration wiring. All 73 package
tests pass, and the full harness builds
for arm64 iPhone Simulator and physical-device SDKs. This is build and replay
evidence, not a live tmux/Zellij device claim; live shell/TUI runs and the
credential-backed public-key-plus-keyboard-interactive gap remain open.

## 2026-07-17: production session surface and automatic device gate

The third Phase 6 slice binds `GhostteaSSHSessionFactory` to a visible iOS
terminal surface. It does not read SSH output beside the model: the production
session pulls transport bytes, feeds the shared core, executes ordered replies,
and publishes immutable TRF1 frames to the Metal view. Hardware and software
keys, paste, terminal mouse input, scrollback, and native selection route back
through the production session/core boundary. Network path changes and
aggregate scene suspension are forwarded to that same generation-safe actor.

The harness offers shell, tmux, and Zellij profiles. Shell mode is a one-tap
gate: after production Keychain authentication it writes styled marker output,
exits, requires a typed zero exit, and verifies the marker through native
terminal accessibility rows before declaring the complete SSH-to-render path
passed. The attach profiles retain the surface for interactive input.

`npm run test:ios:production-session` adds a noninteractive physical-device
runner. It builds and installs the signed app, starts the disposable fixture,
limits automatic host-key acceptance to the injected fixture hostname, streams
the app console until its pass/fail exit, removes the temporary device-only
Keychain credential, and tears down the fixture. All 73 package tests and both
iOS SDK builds pass.

The automatic runner then passed on the physical iPhone 14 Pro running iOS
26.5.2. CoreDevice established its tunnel on demand, installed the signed app,
and streamed `GHOSTTEA_PRODUCTION_SESSION_PASS`; the app exited with status
zero. The same process also reported the core, font, TRF1, and visual markers,
with an exact visual hash and zero recorded edge, channel, or content delta.
The runner removed the disposable SSH container and network after termination.
This proves the automatic shell path on device; live tmux, Zellij, Vim, htop,
and agent-TUI interaction remain separate Phase 6 evidence.

## 2026-07-17: production tmux attach, input, and resize gate

The fourth Phase 6 slice turns tmux from a build-tested attach profile into a
noninteractive physical-device gate. `npm run test:ios:production-tmux` uses
the same signed production surface, Keychain credential, fixture-scoped host
key decision, session actor, shared core, TRF1 renderer, and disposable SSH
fixture as the shell gate. The fixture image now includes tmux.

The app attaches or creates the named `ghosttea` session with an allocated
100x30 PTY. It observes the shell's `29 100` size through native terminal
accessibility text, accounting for tmux's default one-row status line. It then
requests a 120x40 PTY through `GhostteaSession.resize`, waits until the tmux
pane reports `39 120`, and sends a newline acknowledgement through the normal
ordered input path. Exact contiguous output markers prevent the echoed probe
command from satisfying either observation. The remote shell and tmux session
then exit normally, and the app requires typed exit status zero.

The automatic runner passed on the physical iPhone 14 Pro running iOS 26.5.2.
The signed process emitted `GHOSTTEA_PRODUCTION_TMUX_PASS` and exited with
status zero after the attach/input/resize handshake. The same run passed all
73 package tests, both iOS SDK builds, and the core, font, TRF1, and visual
prerequisite markers, then removed the disposable container and network.
Zellij, Vim/Neovim, htop/btop, and agent-TUI interaction remain separate Phase
6 evidence.

## 2026-07-17: production Vim render, input, and resize gate

The fifth Phase 6 slice adds `npm run test:ios:production-vim`. It uses the
same signed production surface and disposable fixture as the shell and tmux
gates, with `vim-tiny` installed only in the fixture image. The app disables
shell echo before emitting its synchronization marker, launches Vim with no
user configuration or persistent history, and waits until the seed buffer is
visible through native terminal accessibility rows.

The first device attempt exposed a real transport scheduling defect rather
than a Vim issue. `SSHCandidateConnection.read` serialized libssh2 access with
the connection operation gate but retained that gate while polling an idle
socket. The session's background reader therefore prevented the first user
write from reaching an otherwise idle interactive shell. The connection now
performs one libssh2 read while serialized, captures its requested block
directions, releases the operation gate while polling the raw socket, and then
retries under the gate. No libssh2 call is made concurrently, but inbound
idleness no longer blocks outbound input.

The disposable macOS matrix now contains an explicit regression: it starts an
idle read before attempting a write and requires the returned marker within two
seconds. The write-and-read exchange completed in approximately 2.6 ms. The
same run retained all existing authentication, algorithm, command, PTY resize,
cancellation, half-close, and 32 MiB lossless stalled-reader checks.

Debian's minimal Vim is compiled without the `eval` feature, so the gate avoids
Vimscript functions. It uses Vim's supported `:read !` command to run `stty
size` inside the allocated PTY. The physical iPhone observed `30 100`, ordered
a session/core resize to 120x40, then observed `40 120`. It inserted
`ghosttea-vim-edited ghosttea-vim-input` through normal terminal key input,
validated the edited buffer through native accessibility text, sent `:qa!`,
and required typed exit status zero.

The signed iPhone 14 Pro process emitted the following final marker and exited
zero:

```text
GHOSTTEA_PRODUCTION_VIM_PASS
```

The runner also passed all 73 package tests, both iOS SDK builds, and the core,
font, TRF1, and visual prerequisites before removing the disposable fixture.
Zellij, htop/btop, and representative agent-TUI interaction remain separate
Phase 6 evidence.

## 2026-07-17: production Zellij attach, input, and resize gate

The sixth Phase 6 slice adds `npm run test:ios:production-zellij`. The
disposable fixture installs the official Zellij 0.44.3 no-web binary in a
multistage image, selecting the aarch64 or x86_64 archive for the Docker host.
Both release archives are checksum-pinned, and only the resulting binary is
copied into the runtime image. Fixture-local configuration suppresses startup
tips and release notes so the test always reaches a real shell pane without a
first-run interaction.

The signed app attaches or creates the named `ghosttea` session with a 100x30
outer PTY. Zellij's default chrome leaves a 98x26 shell pane, which the gate
reads from `stty size` and validates as the exact contiguous accessibility
marker `ghosttea-zellij-ready 26 98`. It then orders a PTY/core resize to
120x40 and requires the pane to report 118x36. Finally it sends `accepted`
through the normal ordered input path, observes the resulting marker through
native terminal accessibility rows, and requires typed exit status zero.

The initial physical run exposed a startup ordering race: the SSH channel can
report connected before Zellij has created its first shell pane. The automated
profile now waits for a bounded Zellij startup interval before sending its
first shell command. This behavior is limited to the deterministic harness;
interactive product input remains user-driven.

The automatic runner passed on the physical iPhone 14 Pro running iOS 26.5.2.
It emitted every Zellij synchronization marker followed by:

```text
GHOSTTEA_PRODUCTION_ZELLIJ_PASS
```

The process exited zero after passing all 73 package tests, both iOS SDK
builds, and the core, font, TRF1, and visual prerequisites. The runner then
removed its disposable SSH container and network. htop/btop and representative
agent-TUI interaction remain separate Phase 6 evidence.

## 2026-07-18: production htop and btop render, input, and resize gate

The seventh Phase 6 slice adds `npm run test:ios:production-monitor-tuis`.
The disposable Debian fixture pins htop 3.2.2-2 and btop 1.2.13-1 so the
full-screen layouts and interaction contract cannot drift underneath the
device gate. Both applications run sequentially in one production shell over
the same Keychain credential, known-host policy, session actor, shared core,
TRF1 renderer, and Metal surface exercised by the preceding gates.

At the initial 100x30 PTY, the app requires htop's task, load-average, and
function-key rows through native terminal accessibility text. It sends `h`
through the ordered writer, validates htop's help screen, and resizes the
PTY/core to 120x40. The first device run correctly exposed that `q` dismisses
the help overlay before a later `q` exits htop. The state machine now requires
the main screen to reappear after resize before sending the distinct exit key.
After htop returns, the shell reports `40 120`, proving the remote PTY received
the resize.

btop then starts at 120x40. The app validates its CPU, memory, process, and
network panels, sends `m`, and requires the versioned menu overlay through
native accessibility rows. It resizes the PTY/core back to 100x30, sends the
menu's quit key, and requires the shell to report `30 100`. The shell then
exits, and the gate requires typed exit status zero plus every intermediate
render, input, resize, and return flag.

The signed run passed on the physical iPhone 14 Pro running iOS 26.5.2 and
emitted:

```text
GHOSTTEA_PRODUCTION_MONITOR_TUIS_PASS
```

The same run passed all 73 package tests, both iOS SDK builds, and the core,
font, TRF1, and visual prerequisites, then removed its disposable container
and network. Representative agent-TUI interaction remains the final planned
Phase 6 compatibility slice.
