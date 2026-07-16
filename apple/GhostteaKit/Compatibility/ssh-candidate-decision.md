# Phase 0 SSH candidate decision

**Status:** libssh2 passes the Phase 0 authentication fixture and advances to a
nonblocking adapter spike. No SSH stack is selected for production yet.

**Recorded:** 2026-07-16

## Outcome

The current SwiftNIO SSH client surface, including Citadel’s higher-level
wrapper, does not expose keyboard-interactive authentication. That is a launch
gap for common PAM and OTP deployments. libssh2 1.11.1 does expose a
multi-prompt keyboard-interactive callback and a caller-driven nonblocking API,
and this repository now proves it can be packaged and imported on the supported
Apple targets.

libssh2 is not yet the production choice. Against the pinned OpenSSH
`publickey,keyboard-interactive` endpoint, the correct public key returns
`LIBSSH2_ERROR_PUBLICKEY_UNVERIFIED` (`-19`) with the session still
unauthenticated; explicitly invoking keyboard-interactive next succeeds with
two prompts and completes authentication. A wrong-key control does not
authenticate. Thus chained MFA works, but libssh2 1.11.1 does not expose a
distinct partial-success result. The adapter must sequence only methods allowed
by product/server policy and lock this ambiguous return behavior under tests.
Upstream work to represent partial success explicitly remains relevant.

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
that resumes without byte loss. A test-only C probe linked against the packaged
XCFramework now passes password, Ed25519 public key, two-round
keyboard-interactive, strict known-host matching, command execution, and the
explicit chained-authentication sequence. It also locks the current `-19`
partial-step behavior and rejects a wrong-key control. The PTY and flood results
still belong only to the system-OpenSSH baseline until the nonblocking adapter
executes them.

## Reproduce

From the repository root on Apple Silicon macOS:

```sh
npm run bootstrap:ssh:apple
npm run build:ssh:apple
npm run check:ssh:apple
npm run test:ghostty-vt:apple
npm run test:ssh:fixture
npm run test:ssh:fixture:candidate
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

1. Move the proven authentication flows from the blocking C probe into a
   nonblocking Swift adapter without weakening chained-method policy.
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
