# GhostteaKit

This directory is the Apple-side Phase 0 integration package for the iOS terminal project described in [`draft/ios-terminal-design.md`](../../draft/ios-terminal-design.md).

It currently proves that Swift can link the pinned upstream `libghostty-vt`
XCFramework and exercise terminal creation, VT input, resize, state queries,
and key encoding. It also contains the host-neutral, demand-driven
`GhostteaTransport` contract and a pinned libssh2/OpenSSL nonblocking candidate.
The raw Ghostty and libssh2 APIs are explicitly not application contracts. The
planned stable terminal boundary is `GhostteaCoreFFI.xcframework`, backed by
the shared Ghosttea model and ordered effect stream.

## Build and test

From the repository root on Apple Silicon macOS:

```sh
npm run bootstrap:ghostty-vt:apple
npm run build:ghostty-vt:apple
npm run bootstrap:ssh:apple
npm run build:ssh:apple
npm run check:ssh:apple
npm run test:ghostty-vt:apple
npm run test:ssh:fixture
npm run test:ssh:fixture:candidate
npm run test:ssh:fixture:swift
npm run bench:ghostty-vt:apple:matrix
```

The Ghostty build uses a repository-pinned Zig archive and Ghostty commit. The
SSH candidate build uses pinned OpenSSL and libssh2 commits. Both produce and
validate macOS, iOS device, and iOS simulator slices. The test script runs the
Swift proofs on macOS and cross-compiles the relevant targets for the arm64 iOS
simulator and device SDKs.

The conformance test loads a JSON fixture, feeds it as one buffer, one byte at
a time, and patterned chunks, then compares state, visible text, and ordered
terminal replies. The memory matrix measures macOS physical footprint for one,
four, and eight raw VT sessions before and after upstream scrollback
compression. It is a repeatable host baseline; physical-device jetsam and
energy measurements remain required.

No package source should import `GhosttyVt` outside the `GhosttyVtProof` target. This keeps the unstable upstream API from leaking into future app code.

Likewise, only `CGhostteaSSH` and the isolated `GhostteaSSHProbe` may import
`LibSSH2Candidate`. The public `GhostteaSSH` candidate sees only opaque C shim
handles and implements `TerminalTransport`; it is not yet a selected production
transport. The current evidence and known chained-MFA return-state ambiguity are recorded in
[`Compatibility/ssh-candidate-decision.md`](Compatibility/ssh-candidate-decision.md).
The adapter uses independent TCP-connect and SSH-handshake deadlines. Its local
banner-blackhole fixture also proves that a stalled handshake observes both its
deadline and Swift task cancellation; synchronous DNS cancellation remains a
documented hardening item.
The candidate connection also exposes diagnostic flow-control metrics. The
live flood gate requires its delivered-byte counters to remain unchanged while
terminal demand is paused, then verifies exact delivery while reporting the
libssh2 receive window and socket-wait count.
