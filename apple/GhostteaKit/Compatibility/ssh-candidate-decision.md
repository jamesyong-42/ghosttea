# Phase 0 SSH candidate decision

**Status:** libssh2 advances to a live-fixture spike. No SSH stack is selected
for production yet.

**Recorded:** 2026-07-16

## Outcome

The current SwiftNIO SSH client surface, including Citadel’s higher-level
wrapper, does not expose keyboard-interactive authentication. That is a launch
gap for common PAM and OTP deployments. libssh2 1.11.1 does expose a
multi-prompt keyboard-interactive callback and a caller-driven nonblocking API,
and this repository now proves it can be packaged and imported on the supported
Apple targets.

libssh2 is not yet the production choice. Version 1.11.1 does not handle the
SSH authentication partial-success state needed for flows such as public key
followed by OTP. Upstream work for that capability is still unmerged. The next
gate is a live server matrix; if launch servers require that flow, we must fund
and maintain the missing work, choose a different stack, or explicitly narrow
compatibility.

## Reproducible evidence

The exact inputs are locked in `native/ssh.lock.json`:

- OpenSSL `openssl-3.5.6` at
  `286ddeaac037533bbdce65b3c689e3f7ffebf0f6`;
- libssh2 `libssh2-1.11.1` at
  `a312b43325e3383c865a87bb1d26cb52e3292641`;
- deployment targets macOS 14 and iOS 17 on arm64.

The build produces a static XCFramework with macOS arm64, iOS arm64, and iOS
simulator arm64 slices. On Xcode 26.1 the unpacked artifact is 26,446,680 bytes;
the individual archives are roughly 8.1–9.0 MB. These are pre-link archives
containing libssh2 and libcrypto, not installed-app size. Dead stripping and App
Store thinning must be measured in the eventual app.

The validator checks platform metadata, archive format, architecture, headers,
module map, and the following symbols in every slice:

- `libssh2_init`;
- `libssh2_session_init_ex`;
- `libssh2_userauth_keyboard_interactive_ex`;
- `libssh2_version`.

`GhostteaSSHProbe` additionally proves from Swift that global initialization,
session allocation/free, runtime version lookup, and the keyboard-interactive
API import work on macOS. The same target cross-compiles for iOS device and
simulator. The upstream 1.11.1 tag reports the runtime string `1.11.1_DEV`; the
commit pin, rather than that string, is the authoritative source identity.

The repository also contains a pinned OpenSSH reference fixture with four
endpoints: password, public key, two-prompt keyboard-interactive, and public key
followed by keyboard-interactive. Its system-OpenSSH baseline proves the
scenarios are configured correctly. It also verifies exact stdout/stderr and
exit status, an initial and repeated PTY size, and a 32 MiB stalled-reader flood
that resumes without byte loss. Those results do not count as libssh2 evidence;
the candidate adapter must execute the same matrix.

## Reproduce

From the repository root on Apple Silicon macOS:

```sh
npm run bootstrap:ssh:apple
npm run build:ssh:apple
npm run check:ssh:apple
npm run test:ghostty-vt:apple
npm run test:ssh:fixture
```

Generated source checkouts, build directories, and XCFrameworks are ignored.
Only lock data, scripts, package declarations, probes, tests, and this decision
record belong in source control.

## Intended adapter boundary

The production adapter, if this candidate passes, should be a `GhostteaSSH`
actor implementing `TerminalTransport`. It owns the socket, libssh2 session,
channel, credential callbacks, host-key policy, and cancellation. The generic
terminal controller sees only:

- pull-based `read(maxBytes:)` demand;
- ordered, lossless writes;
- resize and interrupt operations;
- disconnect and typed failure.

No libssh2 type crosses that boundary. Inbound reads must stop when the
terminal actor has no capacity, and the live flood fixture must demonstrate
that this propagates to the SSH channel window rather than accumulating in an
unbounded Swift stream. The existing `ReplayTransport` and
`OrderedTerminalWriter` test the host-neutral demand and queue semantics while
the real network adapter remains gated.

## Live-fixture work required before selection

1. Run the libssh2 candidate against the implemented password, public-key,
   two-prompt keyboard-interactive, and partial-success-chain fixtures.
2. Test known, unknown, and changed host keys with an explicit user decision
   boundary.
3. Record negotiated host-key, key-exchange, cipher, and MAC algorithms for the
   launch server sample.
4. Repeat the reference PTY, resize, stdout/stderr/EOF, and exit-status probes
   through the candidate; add cancellation and reconnect orchestration.
5. Repeat the reference stalled-reader flood through the candidate while
   measuring socket, SSH-channel, adapter-queue, and whole-process memory.
6. Run the package and network fixture on a physical low-end supported iOS
   device.

## Sources

- SwiftNIO SSH: <https://github.com/apple/swift-nio-ssh>
- Citadel: <https://github.com/orlandos-nl/Citadel>
- libssh2 keyboard-interactive API:
  <https://libssh2.org/libssh2_userauth_keyboard_interactive_ex.html>
- libssh2 partial-success pull request:
  <https://github.com/libssh2/libssh2/pull/1760>
- OpenSSL releases: <https://github.com/openssl/openssl/releases>
