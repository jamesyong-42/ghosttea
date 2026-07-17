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
