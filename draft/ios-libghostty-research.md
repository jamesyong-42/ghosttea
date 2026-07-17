# iOS libghostty research note

**Status:** Repository-owned research snapshot
**Date:** July 16, 2026
**Related design:** [`ios-terminal-design.md`](ios-terminal-design.md)

This note preserves the findings that informed Ghosttea's iOS architecture.
It replaces a machine-local working note as the durable repository reference.
It is a research snapshot, not an API stability promise; every Ghostty or SSH
upgrade must be revalidated against current source.

## 1. Research question

Can Ghosttea deliver an iOS terminal that matches the behavior of its desktop
demo, and should that product embed full `libghostty` or reuse Ghosttea's
existing `libghostty-vt` custom-renderer pipeline?

## 2. Conclusion

Use the same Ghosttea terminal model, `libghostty-vt` adapter, native text
engine, and TRF1 frame producer on desktop and iOS. Implement iOS-specific
transport, input, workspace, lifecycle, and Metal rendering around that shared
core.

Full `libghostty` and community Swift packages are valuable device spikes, but
they are not the production parity boundary because:

- Ghosttea desktop already bypasses Ghostty's complete surface renderer;
- the pinned full-libghostty surface does not expose a stable upstream
  host-managed byte backend suitable for an iOS SSH client;
- community integrations carry additional external-I/O and iOS lifecycle work;
- a second renderer would make Ghosttea desktop/iOS parity harder to define and
  test.

## 3. Pinned Ghostty evidence

Ghosttea pins Ghostty in `native/ghostty.lock.json`. At the researched revision:

- `include/ghostty.h` defines an iOS platform and a UIKit view pointer;
- the embedded application runtime contains UIKit and Metal surface support;
- the public surface configuration still describes command/termio startup and
  does not expose an upstream host-managed byte transport;
- `src/build/GhosttyLibVt.zig` supports iOS device and simulator builds and can
  assemble a `ghostty-vt.xcframework` with a `GhosttyVt` module map;
- the pinned public `GhosttyTerminalOptions` comment describes
  `max_scrollback` as lines, while the implementation consumes it as bytes and
  rounds it to page allocation; Ghosttea wrappers must name and budget the
  value in bytes rather than inheriting the misleading comment;
- Ghosttea's current `ghostty-vt-sys` artifact manifest publishes only the
  Apple Silicon macOS target.

The iOS VT proof therefore requires an Apple artifact pipeline and Swift link
test, but not a new VT implementation or a full Ghostty fork.

Repository evidence:

- `native/ghostty.lock.json`
- `native/vendor/ghostty/include/ghostty.h`
- `native/vendor/ghostty/src/apprt/embedded.zig`
- `native/vendor/ghostty/src/build/GhosttyLibVt.zig`
- `native/terminald/crates/ghostty-vt-sys/artifacts.json`

## 4. Existing Ghosttea reuse boundary

The reusable behavior is already concentrated in:

- `ghostty-adapter`: safe Rust ownership and input/snapshot APIs over the
  custom C shim;
- `session.rs`: byte batching, terminal feed, replies, logical snapshots,
  rendering, input ordering, and view authority, currently coupled to a PTY;
- `text-engine`: HarfBuzz shaping and Swash rasterization;
- `frame.rs`: binary TRF1 display-list encoding;
- `terminal-frame`: strict TypeScript TRF1 decoding;
- `terminal-react`: the reference input, selection, rendering, and workspace
  behavior.

The required extraction is a host-neutral terminal model. Desktop supplies a
PTY/process adapter. iOS supplies an SSH or remote-session byte transport.

## 5. Full libghostty and community projects

### Upstream Ghostty

Ghostty exposes an embedding API and experimental iOS-related code, but its
public header warns that the embedding API is not yet a general-purpose stable
surface. The upstream iPad discussion indicates that third-party clients are
possible while an official iPad application is not the project's commitment.
Participants have needed pipe/external-I/O and display-link behavior for iOS
clients.

### libghostty-spm

`libghostty-spm` distributes prebuilt Apple artifacts and a Swift wrapper. Its
documentation distinguishes its host-managed backend additions from upstream
Ghostty. It is useful for validating device integration and studying a
Swift-facing API, but adopting it directly would make Ghosttea dependent on
its patch cadence.

### Termini

Termini demonstrates an iOS SSH terminal using a Ghostty-based Swift package
and SwiftNIO SSH. It is a useful product and integration reference, especially
for UIKit, Metal, and transport wiring. It does not by itself establish parity
with Ghosttea's custom WebGPU/TRF1 desktop renderer.

### Geistty and Rootshell

These projects reinforce the external-I/O architecture: iOS cannot use the
desktop local-process model, so SSH or another host-managed transport feeds
terminal bytes. Their maintenance status and custom Ghostty changes make them
references rather than production foundations.

## 6. iOS product constraints

### Local execution

The iOS product should not be designed around spawning arbitrary local shells
or owning a desktop-style PTY process tree. Its primary session forms are:

- SSH to a user-configured remote host;
- a future authenticated Ghosttea remote-session connection;
- replay and loopback transports for tests.

### Background execution

An ordinary iOS application is normally suspended after entering the
background. Metal work must stop. The correct lifecycle is suspend, detect
connection loss, reconnect, and reattach to durable remote state. tmux,
zellij, or a persistent Ghosttea host provides actual session continuity.

### Input

Parity requires native handling for:

- `UITextInput` and marked text;
- hardware key commands and modifier policy;
- an accessory key row;
- pointer/mouse tracking versus local selection;
- clipboard security policy;
- VoiceOver and accessibility row updates.

### Fonts

System font discovery is not a deterministic cross-platform contract. Frame
parity requires identical redistributable font bytes, face indices, shaping
features, metrics, and raster scale on desktop and iOS.

## 7. SSH stack validation

SwiftNIO provides first-class Apple-platform networking, and SwiftNIO SSH
provides programmatic SSHv2 building blocks. The latter explicitly does not
claim to ship a production-ready SSH client.

At the researched SwiftNIO SSH release, the documented and implemented
authentication offers include password and public key, but not
keyboard-interactive. Its documented cryptographic compatibility intentionally
focuses on modern algorithms. These are potential launch blockers for PAM/MFA,
bastion, or older enterprise hosts.

The SSH implementation is therefore a Phase 0 decision gate. Test:

- password and public-key authentication;
- encrypted key handling;
- keyboard-interactive and sequential multi-factor authentication;
- required host-key, cipher, and key-exchange algorithms;
- host-key verification and known-host behavior;
- PTY, resize, exit, half-close, cancellation, and network transition;
- inbound channel-window backpressure during unbounded output.

SwiftNIO SSH child channels implement SSH receive windows and can delay window
adjustment until buffered bytes are delivered. A Ghosttea adapter should use
demand-driven reads with automatic reads disabled rather than copying channel
data into an unbounded `AsyncThrowingStream`.

If the compatibility matrix fails, choose another SSH stack or explicitly fund
and maintain the missing SwiftNIO SSH protocol work as a Phase 0 outcome,
before transport implementation begins.

### 7.1 Phase 0 candidate result (2026-07-16)

Current screening confirms that Citadel 0.12.1 does not add
keyboard-interactive authentication on top of SwiftNIO SSH. A second candidate,
libssh2 1.11.1 with OpenSSL 3.5.6, was pinned and built as a static XCFramework
for macOS arm64, iOS arm64, and iOS simulator arm64. Swift can initialize the
library, allocate/free a session, query its version, and import the
multi-prompt keyboard-interactive function. Every archive slice is also
validated for that function symbol.

This does not yet select libssh2. The pinned live fixture now runs through a
serialized nonblocking Swift adapter and passes password, Ed25519 public key,
two-round keyboard-interactive, and explicit public-key followed by
keyboard-interactive. In the chained case libssh2 reports the accepted key step
as `LIBSSH2_ERROR_PUBLICKEY_UNVERIFIED` (`-19`) rather than a distinct partial
result; only the explicitly chained configuration proceeds to the subsequent
keyboard-interactive call. A wrong-key control remains rejected. The adapter
also rejects unknown and changed host keys, verifies PTY allocation and resize,
drains a 32 MiB stalled stream byte-for-byte at about 10 MB RSS, and cancels a
blocked read in under 1 ms with cancellation-triggered socket shutdown.
Negotiated-method instrumentation locks the
fixture profile to Curve25519, Ed25519, ChaCha20-Poly1305, and HMAC-SHA2-256.
Candidate-only metrics now record raw encrypted socket, delivered, and written
bytes, socket waits, and libssh2 receive-window state. The socket-receive and
delivered-byte counters remain unchanged during the 750 ms pause, ruling out
hidden network or Swift-side prefetch before the exact 32 MiB drain.
Strict known-host verification remains the default. Unknown and changed keys
can now cross an opt-in async decision boundary with host, port, algorithm,
OpenSSH-style SHA-256 fingerprint, and mismatch reason. Live controls prove
strict rejection and explicit accept-once behavior before authentication;
accept-and-store atomically inserts or replaces the OpenSSH entry, preserves
its file mode, and passes strict reconnect controls. A physical iPhone also
persists an unknown key, warns before replacing a changed key, and reconnects
strictly without another prompt; production UI promotion remains open.
An asynchronous challenge responder now preserves prompt text and echo policy
without running the synchronous libssh2 callback on a Swift executor; the live
fixture covers informational and multiple prompt rounds, exact nonempty
protocol name/instruction metadata, and cancellation. A diagnostic challenge
sheet passes the two-prompt mixed-echo metadata fixture on a physical iPhone;
one continuous presentation bridges host-key confirmation and authentication
without losing a challenge during sheet dismissal. Cancelling from that sheet
unwinds the suspended responder and native callback worker in 162 ms on the
same device.
The adapter now uses a cancellable nonblocking TCP connector with a separate SSH
handshake deadline. A local peer that accepts TCP without sending a banner proves
the 250 ms handshake deadline and cancellation paths. Hostname lookup now uses
Apple DNS-SD under the same absolute connect deadline with 100 ms cancellation
polling. Package and live `localhost` fixtures pass, and both iOS SDKs build.
Device-only,
non-synchronizing Keychain storage now passes a real iPhone save/load/delete
cycle. Opaque password and encrypted private-key/passphrase resolution also
pass the disposable SSH fixture on that device, with credential deletion before
command output is read and no private-key file. The iPhone also preserves
separate command streams, exit 37, typed `SIGTERM`, PTY allocation/resize, and
byte-exact input half-close. A signed iPhone build also resolves the Mac's
Bonjour hostname and completes the bounded SSH command. Remaining gates include
product UI promotion, representative-server/DNS sampling, and complete
minimum-device evidence, as
documented in `apple/GhostteaKit/Compatibility/ssh-candidate-decision.md`.

The local physical-device route-loss baseline now passes: disabling Wi-Fi
during an active LAN command and explicitly cancelling unwinds the SSH socket in
23 ms. After Wi-Fi is restored, a fresh connection to a new fixture completes
the expected command. This proves bounded teardown and reconnection, not
survival of the original ordinary SSH session.

Repeated cleanup stress now passes 32 stalled-handshake cancellations and 16
suspended keyboard-interactive cancellations in one process, each bounded below
one second.

Generated passphrase-encrypted OpenSSH Ed25519 keys now authenticate through
the adapter, while an incorrect-passphrase control is rejected. The physical
iPhone proof exercises production-shaped Keychain loading and immediate
post-authentication deletion; final product credential UI remains open.

A second forced negotiation profile now passes with an ECDSA P-256 host key,
bidirectional AES-256-GCM, strict known-host verification, and a shell session.
A third passes with an RSA-3072 host key negotiated as RSA/SHA-2-512 rather than
deprecated `ssh-rsa`. Required production scope still depends on the
representative launch-server sample.

The candidate also implements non-PTY commands, multiplexed stdout/stderr,
input half-close, typed exit status or signal, and the SSH EOF/close handshake. Live
fixtures preserve separate output streams with exit 37 and prove that output
remains readable after input EOF without truncation.
A third command killed by `SIGTERM` is reported distinctly as
`.signaled(name: "TERM")` rather than numeric exit zero.

## 8. Recommended proof order

1. Build pinned `libghostty-vt` for physical iOS and simulator.
2. Link it into a minimal Swift package test.
3. Feed fixed ANSI bytes and verify snapshot and key-encoding results.
4. Measure binary size and VT/scrollback byte-budget memory before and after
   caller-driven compression.
5. Spike the SSH authentication and algorithm matrix.
6. Add whole-app footprint instrumentation, then repeat the instrumented
   demand-driven stalled-output fixture on a low-end physical device.
7. Only then extract the shared Ghosttea terminal model.
8. Begin the extraction after the current Electron embedding refactor lands.

The standard-tier whole-process gate now passes on an iPhone 14 Pro: eight
loaded VT sessions peak at 44.6 MB, one active plus seven compressed background
sessions use 30.5 MB, and all compressed sessions use 28.5 MB. Compact-tier
execution and active transport/renderer categories remain open.

## 9. Sources

Primary and upstream sources:

- Ghostty: <https://github.com/ghostty-org/ghostty>
- Ghostling: <https://github.com/ghostty-org/ghostling>
- Ghostty iPad discussion:
  <https://github.com/ghostty-org/ghostty/discussions/4087>
- SwiftNIO: <https://github.com/apple/swift-nio>
- SwiftNIO SSH: <https://github.com/apple/swift-nio-ssh>
- SwiftNIO SSH child-channel implementation:
  <https://github.com/apple/swift-nio-ssh/tree/main/Sources/NIOSSH/Child%20Channels>
- Citadel: <https://github.com/orlandos-nl/Citadel>
- libssh2 keyboard-interactive API:
  <https://libssh2.org/libssh2_userauth_keyboard_interactive_ex.html>
- libssh2 authentication partial-success work:
  <https://github.com/libssh2/libssh2/pull/1760>
- OpenSSL releases: <https://github.com/openssl/openssl/releases>
- Apple App Review Guidelines:
  <https://developer.apple.com/app-store/review/guidelines/>
- Apple Metal background guidance:
  <https://developer.apple.com/documentation/metal/preparing-your-metal-app-to-run-in-the-background>
- Apple UIKit background guidance:
  <https://developer.apple.com/documentation/uikit/preparing-your-ui-to-run-in-the-background>
- Apple background execution limits:
  <https://developer.apple.com/forums/thread/685525>

Community implementation references:

- libghostty-spm: <https://github.com/Lakr233/libghostty-spm>
- Termini: <https://github.com/arach/Termini>
- Geistty: <https://github.com/daiimus/geistty>
- Rootshell: <https://github.com/kitknox/rootshell>
