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
- pinned OpenSSL/libssh2 macOS, iOS device, and iOS simulator candidate build;
- XCFramework architecture/header/symbol validation and a Swift lifecycle and
  keyboard-interactive import probe;
- SSH candidate decision, capability matrix, and flow-control gate.

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

1. Run the proof on a physical iOS device once an app harness and signing team are available.
2. Build an SSH fixture service covering the required matrix, especially keyboard-interactive, partial success, host-key policy, resize, cancellation, and a sustained-output flood. libssh2 advances to this gate but is not selected; its missing partial-success handling remains a blocker for public-key-plus-MFA servers.
3. Measure resident memory for one foreground and several background terminal fixtures on the oldest supported device class. Record terminal state, scrollback, decoded image, and GPU atlas bytes separately.
4. Decide the SSH implementation from fixture evidence.
5. Decide the v1 connection scope and bundled-font licensing.
6. Land the in-flight embedding refactor and record byte-identical desktop fixture output as the Phase 1 extraction baseline.

Phase 1 must not reorganize `session.rs`, `service.rs`, `replica.rs`, or their package boundaries until the embedding refactor has landed. The first Phase 1 change should introduce the ordered `TerminalEffect` contract and prove identical TRF1 bytes under varied input chunking before any Apple FFI code is added.
