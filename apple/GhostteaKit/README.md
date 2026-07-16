# GhostteaKit

This directory is the Apple-side Phase 0 integration package for the iOS terminal project described in [`draft/ios-terminal-design.md`](../../draft/ios-terminal-design.md).

It currently proves that Swift can link the pinned upstream `libghostty-vt`
XCFramework and exercise terminal creation, VT input, resize, state queries,
and key encoding. It also contains the host-neutral, demand-driven
`GhostteaTransport` contract and a pinned libssh2/OpenSSL compile candidate.
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

Likewise, only `GhostteaSSHProbe` may import `LibSSH2Candidate`. It is a compile
and lifecycle proof, not a selected production transport. The current
candidate decision and known chained-MFA gap are recorded in
[`Compatibility/ssh-candidate-decision.md`](Compatibility/ssh-candidate-decision.md).
