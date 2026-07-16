# Phase 0 SSH candidate decision

**Status:** libssh2 passes the Phase 0 nonblocking Swift adapter fixture. It
remains the leading candidate, but no SSH stack is selected for production yet.

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

The repository now implements that narrow policy in `GhostteaSSH`: only the
explicit `publicKeyThenKeyboardInteractive` configuration accepts the observed
`-19` step and attempts the second method. A public-key-only configuration
still fails on `-19`, and the wrong-key chained control remains rejected by the
server. Keyboard answers are pre-supplied for this Phase 0 adapter; an
asynchronous prompt broker that preserves prompt metadata is still required for
the product UI.

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
also run through the nonblocking Swift adapter. It allocates a 41x132 PTY,
resizes it to 50x140, stops reading for 750 ms during a 32 MiB stream, and then
drains exactly 33,554,432 bytes. The stalled process measured 10,043,392 bytes
maximum RSS on the development Mac, below the 64 MiB gate. A blocked channel
read observed Swift task cancellation in approximately 45 ms. Strict
known-host matching succeeds, while empty and changed-key files are rejected.
Every fixture connection also locks the negotiated methods as
`curve25519-sha256`, `ssh-ed25519`,
`chacha20-poly1305@openssh.com` in both directions, and `hmac-sha2-256` in both
directions. This proves one modern launch profile; it does not replace ECDSA,
AES-GCM, RSA/SHA-2, or representative production-server coverage.

## Reproduce

From the repository root on Apple Silicon macOS:

```sh
npm run bootstrap:ssh:apple
npm run build:ssh:apple
npm run check:ssh:apple
npm run test:ghostty-vt:apple
npm run test:ssh:fixture
npm run test:ssh:fixture:candidate
npm run test:ssh:fixture:swift
```

Generated source checkouts, build directories, and XCFrameworks are ignored.
Only lock data, scripts, package declarations, probes, tests, and this decision
record belong in source control.

## Intended adapter boundary

The candidate adapter is a `GhostteaSSH` package implementing
`TerminalTransport`. It owns the socket, opaque libssh2 session and channel,
credential callbacks, strict host-key check, and cancellation. A per-connection
async gate prevents actor reentrancy from overlapping libssh2 calls while a
poll wait is suspended. The generic terminal controller sees only:

- pull-based `read(maxBytes:)` demand;
- ordered, lossless writes;
- resize and interrupt operations;
- disconnect and typed failure.

No libssh2 type crosses that boundary. Inbound reads must stop when the
terminal actor has no capacity, and the live flood fixture must demonstrate
that this propagates to the SSH channel window rather than accumulating in an
unbounded Swift stream. The live adapter calls neither socket nor channel read
without a `read(maxBytes:)` request; its stalled-reader fixture remains bounded
and lossless. `ReplayTransport` and `OrderedTerminalWriter` separately test the
host-neutral demand and queue semantics.

## Live-fixture work required before selection

1. Replace pre-supplied keyboard-interactive answers with an asynchronous
   challenge broker that preserves prompt text and echo policy without calling
   Swift concurrency from libssh2's synchronous callback.
2. Add the explicit user decision boundary for unknown and changed host keys;
   strict acceptance and rejection controls already pass.
3. Add ECDSA and AES-GCM fixture endpoints, then repeat the now-instrumented
   negotiated-method capture against the launch server sample. Decide RSA/SHA-2
   scope from that sample.
4. Add command-channel stdout/stderr/EOF/exit-status coverage, connect/auth
   cancellation, graceful close, and reconnect orchestration. PTY allocation,
   resize, shell I/O, and blocked-read cancellation already pass.
5. Instrument socket bytes, SSH-channel windows, adapter queues, and physical
   footprint. The macOS adapter flood is already byte-exact and below its
   whole-process RSS gate.
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
