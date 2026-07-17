# Phase 0 execution plan

Phase 0 answers the architectural questions that would otherwise force expensive rework. It is complete only when its evidence is reproducible in CI or on a documented device setup.

## Implemented foundation

- pinned macOS Zig distribution and checksum in `native/ghostty.lock.json`;
- reproducible upstream Ghostty VT XCFramework build;
- artifact validation for macOS universal, iOS device, and iOS simulator slices;
- local Swift package integration, macOS smoke test, and iOS device/simulator compilation;
- fixture-driven state, formatter, terminal-reply, and chunking conformance;
- a repeatable one/four/eight-session physical-footprint and compression probe;
- a host-neutral pull-based transport contract, bounded ordered writer, replay
  transport, and concurrency tests;
- pinned OpenSSL 3.5.7/libssh2 1.11.1 macOS, iOS device, and iOS simulator
  candidate build, with a fail-closed production-readiness security gate;
- XCFramework architecture/header/symbol validation and a Swift lifecycle and
  keyboard-interactive import probe;
- SSH candidate decision, capability matrix, and flow-control gate.
- a Phase 0 development decision to proceed with the host-owned libssh2 adapter;
  dependency security approval remains a separate fail-closed release gate.
- the Electron embedding refactor and its package/integration gates are landed;
  a pre-extraction desktop golden now proves byte-identical logical TRF1 output
  and terminal replies under whole-buffer, byte-at-a-time, and irregular input
  chunking.
- a pinned OpenSSH reference fixture covering password, public key,
  two-prompt keyboard-interactive, chained partial success, exit streams/status,
  PTY resize, and a stalled-reader output flood.
- a libssh2 candidate fixture probe that passes password, Ed25519 public key,
  two-round keyboard-interactive, strict host-key matching, command execution,
  and explicit public-key-plus-keyboard-interactive sequencing, with a
  wrong-key negative control.
- an opaque C shim and serialized, pull-based `GhostteaSSH` Swift adapter using
  libssh2's nonblocking mode, with no libssh2 type in the public contract;
- a live Swift adapter fixture that passes the authentication matrix, rejects
  unknown and changed host keys, verifies a 41x132 PTY and 50x140 resize, drains
  a deliberately stalled 32 MiB stream byte-for-byte at about 10 MB process
  RSS, and observes blocked-read task cancellation in under 1 ms with
  cancellation-triggered socket shutdown on the development Mac. It locks the
  negotiated fixture profile to Curve25519,
  Ed25519, ChaCha20-Poly1305, and HMAC-SHA2-256.
- an asynchronous keyboard-interactive challenge broker that preserves prompt
  text and echo policy, keeps the synchronous callback on a dedicated worker,
  handles informational and multiple prompt rounds, preserves nonempty
  protocol name/instruction metadata, and cancels a suspended responder without
  leaking the worker.
- host-neutral input half-close and typed exit status, plus non-PTY SSH command
  support that preserves stdout, stderr, EOF, exit 37, and the complete channel
  close handshake. A `cat` fixture proves output remains readable after input
  EOF and exits cleanly without truncation.
- distinct typed termination for numeric exit and remote signal death; a live
  `SIGTERM` command returns `.signaled(name: "TERM")`.
- a cancellable nonblocking TCP connector and independent SSH handshake
  deadline, with pre-cancel and deterministic no-banner timeout/cancellation
  controls.
- an asynchronous Apple DNS-SD hostname resolver sharing the TCP deadline and
  100 ms cancellation polling, with a numeric-address fast path, package-level
  loopback coverage, a full SSH `localhost` fixture, and successful iOS device
  and simulator SDK builds.
- repeated cleanup stress covering 32 stalled-handshake cancellations and 16
  suspended keyboard-interactive cancellations in one process.
- a second strict-known-host negotiation profile using ECDSA P-256 and
  bidirectional AES-256-GCM.
- a strict-known-host RSA-3072 profile that negotiates RSA/SHA-2-512 rather
  than deprecated `ssh-rsa` signatures.
- generated encrypted OpenSSH Ed25519 private-key authentication, plus an
  incorrect-passphrase rejection control. Fixture keys remain in ignored build
  state.
- candidate-only flow-control metrics for raw socket, delivered, and written
  bytes, socket waits, and libssh2 receive-window state. During the 750 ms flood
  pause the socket-receive and delivered-byte counters remain unchanged; the
  later 32 MiB drain is exact.
- an async unknown/changed host-key decision boundary carrying host, port,
  algorithm, SHA-256 fingerprint, and mismatch reason. Strict rejection and
  explicit accept-once paths pass before authentication begins. Accept-and-store
  atomically inserts or replaces the OpenSSH entry, preserves file mode, and
  passes a subsequent strict reconnect.
- a checked-in SwiftUI iOS harness that runs the VT proof, measures deterministic
  one/four/eight-session physical footprint, executes a bounded SSH command,
  and presents reject, accept-once, and accept-and-store host-key decisions;
- a single composed Apple-native XCFramework that carries the Ghostty VT and
  libssh2/OpenSSL modules without Xcode's multiple-static-binary header collision;
- reproducible unsigned arm64 builds of that harness for both the iOS Simulator
  and physical-device SDK.
- a signed physical-device build installed and launched on an iPhone 14 Pro
  running iOS 26.5. The VT smoke result matched the host fixture, and the
  one/four/eight-session memory matrix completed with every session retaining
  4,977 scrollback rows and reporting compression support. Exact measurements
  are recorded in `Compatibility/ios-device-evidence.md`.
- an enforceable whole-process memory policy with compact and standard device
  tiers. The standard-tier iPhone gate passes eight loaded sessions at 44.6 MB
  peak, one active plus seven compressed background sessions at 30.5 MB, and
  all sessions compressed at 28.5 MB. Renderer/image/atlas categories remain
  unavailable until those components exist.
- a physical-device password SSH probe against the disposable OpenSSH fixture,
  including an independently verified unknown host key, explicit accept-once
  decision, authentication, command execution, output drain, and clean exit.
- a reusable `GhostteaCredentials` Keychain boundary with device-only,
  non-synchronizing accessibility and opaque connection identifiers, plus a
  checked-in secret-lifetime and in-memory private-key policy. A real
  iPhone save/load/delete round trip passes and leaves no item behind.
- an async opaque password-credential resolver in `GhostteaSSH`. The iPhone
  harness clears its field before connection, resolves Keychain bytes only at
  authentication time, removes them immediately after connection, and passes
  the physical SSH fixture through that path.
- async opaque private-key and passphrase resolution in `GhostteaSSH`, backed
  by libssh2's in-memory key API and a counted-byte C shim. The live fixture
  passes unencrypted and encrypted resolver paths, rejects a wrong passphrase,
  derives the public key without configured key bytes or a path, and never
  writes private-key bytes to disk.
- a diagnostic iOS harness selector for password or pasted disposable OpenSSH
  private keys with an optional passphrase. It clears all secret fields before
  work begins, uses opaque device-only Keychain items, and deletes them before
  reading command output. Device and simulator SDK builds pass. A physical
  iPhone authenticated to the disposable fixture with its encrypted Ed25519
  key and passphrase through this path, executed the bounded command, and
  drained the expected output without a private-key file.
- a physical-device route-loss probe. After Wi-Fi was disabled during an active
  command, explicit cancellation shut down the SSH socket and unwound in 23 ms.
  Restoring Wi-Fi and connecting to a fresh fixture produced the expected
  command output. This proves teardown and fresh connection, not survival of
  the original ordinary SSH session.
- a physical-device keyboard-interactive probe through a continuous
  host-key/authentication sheet. The iPhone preserved nonempty protocol name
  and instruction, prompt order, and mixed echo policy, submitted two factors,
  authenticated, and drained the expected command output. A competing-sheet
  presentation race found by the first device attempt is covered by keeping one
  interaction presentation alive across both stages. Cancelling directly from
  the challenge sheet unwinds the responder and native callback worker in
  162 ms on the same device.
- a physical-device persistent host-key probe. The iPhone stores an explicitly
  accepted unknown key, detects a freshly generated changed key at the same
  address, presents the changed-key warning before replacement, and reconnects
  to the replacement strictly without another prompt.
- a physical-device command-termination probe. The iPhone drains stdout and
  stderr separately, reports a nonzero remote exit as `exit 37`, and preserves
  `SIGTERM` as typed `signal TERM` rather than exit zero.
- physical-device session probes that allocate a 41x132 PTY, resize the live
  shell to 50x140, and separately send input EOF to `cat` before draining the
  exact echoed payload and observing a clean exit.
- a transport-neutral, generation-checked reconnect reducer plus a
  Network.framework path observer with newest-state buffering. Selected-route
  changes and background transitions order teardown before reconnect
  availability, stale task completions are ignored, and restoration never
  silently starts a fresh connection or reuses submitted credentials. The iOS
  harness exposes the path and lifecycle states. Automatic Wi-Fi-to-cellular
  teardown, explicit fresh reconnect, background teardown, and foreground
  reconnect availability pass on the physical iPhone.
- an automated physical-device launcher that discovers the connected iPhone,
  fails fast when it is locked, opens only the disposable password fixture on
  the current LAN address, runs package and dual-SDK gates, signs, installs,
  launches with a non-secret host override, and guarantees fixture cleanup on
  failure or interruption. Guided on-device probes automate command selection,
  exact output validation, teardown timing, and pass/fail recording around the
  two system gestures iOS cannot automate.

The first verified ReleaseFast artifact, built with Xcode 26.1 and SDK 26.1,
is 36 MiB unpacked. Its static archives are 8,782,808 bytes for iOS device,
8,733,248 bytes for the iOS simulator, and 18,746,584 bytes for universal
macOS. SwiftPM linked the macOS proof without extra package linker settings.
These are build artifacts, not installed-app contribution: dead stripping,
the final Ghosttea wrapper, symbols, and App Store thinning will change the
shipping number, so final linked and compressed size remains a release gate.

The pinned Ghostty implementation interprets `max_scrollback` as bytes and
rounds it to internal page allocation, despite the public header describing
the field as lines. The proof API and proposed Ghosttea ABI therefore name it
`scrollback_bytes`; callers must not treat it as a row count.

On this development Mac, deterministic printable 80-column content with a
10,000,000-byte budget retained 9,977 scrollback rows. Before compression,
10,000 rows added approximately 6.9 MB of physical footprint per session. Full
upstream scrollback compression reduced that increment to approximately 2.7 MB
per session. Eight sessions measured approximately 55.2 MB before compression
and 21.8 MB after compression. These numbers are diagnostic baselines, not iOS
budgets: they exclude Ghosttea shaping, TRF1 buffers, decoded images, Metal,
UIKit, transport state, and the rest of the application.

## Remaining gates

1. Run the harness against representative launch servers and record negotiated
   algorithms plus product path-transition behavior. The signed
   physical-device VT, raw scrollback-memory, host-key confirmation, password
   and private-key authentication, command-output, route-loss cancellation,
   and fresh-reconnect baselines are complete against the local fixture.
2. Finish the nonblocking SSH candidate matrix. The Swift adapter now passes
   authentication including encrypted private keys, the asynchronous prompt
   broker, strict unknown/changed-host rejection, two modern algorithm profiles,
   PTY/resize, typed exit status/signal, auth/connect/handshake/read cancellation,
   and the stalled-reader flood. The Keychain storage policy and package
   boundary plus password and private-key/passphrase resolvers are implemented;
   remaining credential work is production UI promotion, representative-server
   sampling, representative DNS verification, representative-server verification
   of the implemented path/reconnect orchestration, and representative
   compact-tier device execution. The public-key partial step
   remains locked as `-19`, so only an
   explicitly configured chained policy may proceed to keyboard-interactive.
3. The raw VT, standard-tier whole-process, and active-SSH backpressure gates
   are complete. Repeat the compact-tier policy on a low-memory supported
   device, then add decoded-image, shaping/cache, TRF1, and GPU-atlas categories
   as those components enter the iOS application.
4. Before release, replace the compatibility pin with a fixed immutable
   libssh2 release/commit, rerun every Apple/fixture/device gate, and make
   `check:ssh:production` pass. This does not block Phase 1 development.
5. Decide the v1 connection scope and bundled-font licensing.

## Phase 1 handoff

The embedding prerequisite is satisfied and Phase 1 preserved the checked-in
TRF1 baseline while introducing the ordered `TerminalEffect` contract. The
current golden deliberately omits glyph definitions; add shaped-frame parity
after the bundled font decision.

Phase 1 completed on 2026-07-17: `ghosttea-core` now owns the ordered effect
batch, Ghostty model, logical snapshots and patches, local and replica
shaping/render caches, counters, TRF1 producers, view authority, input
deduplication, and human/automation input ordering. Desktop `Session` executes
effects and queues authorized operations as the PTY host, while the existing
serialized tunnel representation remains unchanged. Rust tests and strict
Clippy, lint, package/consumer checks, daemon integration, the TRF1 golden, and
the release benchmark all pass. Phase 2 may begin with explicit bundled font
resources.

Phase 2 completed on 2026-07-17. The locked byte-backed bundle uses JetBrains Mono
Nerd Font regular/bold/italic/bold-italic with Noto Color Emoji fallback,
explicit metrics and raster scale, and normalized geometry/bitmap hashes. The
text engine passes through the generated XCFramework on macOS, in an arm64
iPhone simulator, and on the physical iPhone 14 Pro. All three produce the same
fixture as the checked-in desktop golden. System-font discovery is retained
only as an explicitly non-parity desktop mode. Final font-license review remains
a release checklist item, as agreed, rather than a Phase 2 implementation gate.
