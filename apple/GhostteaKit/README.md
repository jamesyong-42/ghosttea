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
before a future Metal renderer sees any size, count, text, or pixel data. The
internal decoder preserves unknown section kinds for compatible extensions,
uses bounded zero-copy frame slices, and decodes every section currently
emitted by `ghosttea-core`. Its Apple runtime gate executes a production frame
on macOS and an arm64 iPhone Simulator; pass `--device` to the underlying
runner to include a signed physical iPhone.

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
