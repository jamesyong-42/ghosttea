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
server. Keyboard-interactive authentication uses an asynchronous Swift
responder receiving the server name, instruction, prompt text, and echo policy.
The synchronous libssh2 callback waits on a condition variable on a dedicated
worker rather than blocking a Swift cooperative executor.

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
maximum RSS on the development Mac, below the 64 MiB gate. With
cancellation-triggered socket shutdown, a blocked channel read observed Swift
task cancellation in under 1 ms. Strict
known-host matching succeeds, while empty and changed-key files are rejected.
Every fixture connection also locks the negotiated methods as
`curve25519-sha256`, `ssh-ed25519`,
`chacha20-poly1305@openssh.com` in both directions, and `hmac-sha2-256` in both
directions. A second forced profile passes strict known-host verification and a
shell session with `ecdsa-sha2-nistp256`, bidirectional
`aes256-gcm@openssh.com`, and `INTEGRATED-AES-GCM`. A third forced profile
passes strict known-host verification and a shell session with a 3072-bit RSA
host key negotiated as `rsa-sha2-512`, never the deprecated `ssh-rsa` signature
algorithm. The local feasibility matrix is green; representative
production-server coverage is still required.
The live keyboard fixture exercises an informational zero-prompt round followed
by distinct password and verification-code rounds, preserving their exact text
and mixed `echo=false`/`echo=true` metadata. A PAM `PAM_TEXT_INFO` message is
also preserved exactly where OpenSSH folds it into the hidden-password prompt.
The OpenSSH fixture's empty protocol-level server name and instruction are
asserted exactly. A separate minimal Paramiko endpoint emits nonempty
`Ghosttea metadata fixture` and `Supply both test factors.` values plus both
mixed-echo prompts in one round. System OpenSSH, the raw C/libssh2 callback, and
the Swift async challenge all preserve those values exactly. The cancellation
fixture's responder deliberately suspends before replying.
Cancelling while that responder is suspended wakes and joins the libssh2 worker
in under one millisecond on the development Mac.
TCP establishment now uses a nonblocking connector with an absolute deadline,
100 ms cancellation polling, and socket shutdown from the Swift task
cancellation handler. The SSH handshake has a separate deadline. A deterministic
fixture accepts TCP but never sends an SSH banner: its 250 ms handshake deadline
fired in approximately 307 ms, and cancellation unwound in approximately 77 ms.
Hostname lookup now uses the asynchronous Apple DNS-SD API under that same
absolute connection deadline. The connector polls the resolver at most every
100 ms, so cancellation and timeout no longer wait for a synchronous
`getaddrinfo`; numeric IPv4 and IPv6 literals retain a non-resolving fast path.
The package suite opens a loopback socket through `localhost`, and the full SSH
fixture authenticates through that hostname path. Both iOS SDK builds pass. A
signed iPhone build also resolves the Mac's Bonjour hostname and completes the
bounded SSH command through it; representative server DNS remains open.
The same process also completes 32 consecutive stalled-handshake cancellations
and 16 consecutive suspended keyboard-interactive cancellations, with every
cycle bounded below one second. This exercises repeated session destruction and
callback-worker cleanup. On a physical iPhone, disabling Wi-Fi during an active
LAN command and explicitly cancelling shuts down the socket and unwinds in 23
ms. After Wi-Fi restoration, a fresh connection to a new fixture completes a
bounded command. A reusable transport-neutral reducer and Network.framework
observer now implement generation-checked route state, automatic teardown,
background suspension, and explicit fresh-reconnect availability. Automatic
Wi-Fi-to-cellular teardown, explicit fresh reconnect, background teardown, and
foreground reconnect availability now pass on the physical iPhone.
The host-neutral transport now includes input half-close and a typed termination
result that distinguishes `.exited(code:)` from `.signaled(name:)`.
A non-PTY command fixture receives byte-exact, separate `fixture-stdout\n` and
`fixture-stderr\n` streams and preserves exit status 37. A second command sends
`half-close-payload\n`, calls `finishInput()`, reads the exact echoed bytes, and
completes `wait_eof`, channel close, and `wait_closed` with exit status 0. The
candidate command reader services both SSH streams before waiting on the
socket, preventing buffered stderr from starving behind idle stdout.
A third command terminates its remote shell with `SIGTERM`; the adapter copies
and frees libssh2's allocated exit-signal value and returns
`.signaled(name: "TERM")` instead of the library's default numeric zero.
The generated-key fixture also authenticates with a passphrase-encrypted
OpenSSH Ed25519 private key through both the legacy path/string case and the
production-shaped opaque resolver, and rejects incorrect passphrases through
both paths. The resolver receives only opaque private-key and passphrase IDs,
passes counted private-key bytes to libssh2's in-memory API, and supplies no
public-key data so the OpenSSL backend derives it. No key path or temporary key
file exists. The C shim also accepts counted passphrase bytes and wipes its
required null-terminated copy before freeing it. Unencrypted and encrypted
opaque resolver cases pass, and the wrong-passphrase control is rejected.

The candidate exposes diagnostic flow-control counters without changing the
host-neutral transport protocol: bytes delivered to Swift per channel, raw
encrypted socket bytes received/sent, bytes written, socket-wait calls, and
libssh2's current/initial receive-window state. During the 750 ms flood pause,
neither the delivered-byte nor raw socket-receive counters move, proving that
the adapter does not prefetch network or channel data into a hidden queue. The
subsequent drain remains byte-exact. One representative run consumed 33,848,488
encrypted socket bytes while delivering the 33,554,432-byte payload, reported a
2,096,949-byte receive window from an initial 2,097,152 bytes, and performed
1,143 socket waits. Because the adapter performs no channel read while demand
is paused, this observation shows backpressure at the socket/SSH-processing
boundary; it does not claim that libssh2 consumed packets and advertised a
smaller remote channel window during the pause.

Strict known-host verification remains the default. For an unknown or changed
key, an opt-in async responder now receives the host, port, negotiated key
algorithm, OpenSSH-style SHA-256 fingerprint, and whether the key is unknown or
changed. It may reject or accept that connection once; authentication never
starts before the decision. The fixture proves strict rejection and explicit
accept-once decisions for both states. An `acceptAndStore` decision inserts an
unknown key or replaces the rejected changed entry through a mode-preserving,
fsynced temporary file and atomic rename. Strict reconnects prove both stored
results. The UIKit confirmation flow remains product work.

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
- input half-close and typed remote exit status;
- resize and interrupt operations;
- disconnect and typed failure.

No libssh2 type crosses that boundary. Inbound reads must stop when the
terminal actor has no capacity, and the live flood fixture must demonstrate
that backpressure reaches the transport rather than accumulating in an
unbounded Swift stream. Depending on where processing pauses, SSH applies this
by withholding channel-window updates or by stopping socket consumption so TCP
backpressure reaches the peer. The live adapter calls neither socket nor
channel read without a `read(maxBytes:)` request; its stalled-reader fixture
remains bounded and lossless. `ReplayTransport` and `OrderedTerminalWriter`
separately test the host-neutral demand and queue semantics.

## Live-fixture work required before selection

1. Promote the diagnostic asynchronous challenge responder and opaque
   private-key chooser into the product connection UI. Opaque
   encrypted-key/passphrase resolution through the in-memory key API now
   passes both the macOS fixture and a physical iPhone. PAM informational text
   passes on macOS; nonempty protocol name/instruction metadata and mixed
   echo/no-echo prompts pass through the diagnostic UI on a physical iPhone.
2. Promote the tested unknown/changed host-key responder into the product
   connection UI. Strict rejection, explicit accept-once decisions, atomic
   insertion/replacement, and permission preservation pass in fixtures. A
   physical iPhone persists an unknown key, warns before replacing a changed
   key, and then reconnects strictly without another prompt.
3. Repeat the now-instrumented negotiated-method capture against the launch
   server sample and decide which profiles must ship. Forced ECDSA P-256,
   AES-256-GCM, and RSA/SHA-2-512 endpoints already pass.
4. Repeat the implemented resolver and reconnect orchestration against the
   representative server/network sample. PTY allocation, resize, shell I/O,
   command exit status/signal, half-close, graceful close, auth/read cancellation,
   DNS/connect/handshake deadlines and cancellation, and repeated auth/handshake
   cancellation stress already pass. Physical challenge-sheet cancellation,
   automatic Wi-Fi-to-cellular teardown, explicit fresh reconnect, background
   suspension, and foreground reconnect availability pass; representative-server
   transitions remain.
5. Carry the completed active-SSH gate into the terminal controller. The
   standard-tier iPhone pauses app demand with unchanged delivered and raw
   socket counters, holds the process at 16.9 MB, and then drains the complete
   32 MiB flood byte-for-byte. The same device also passes one active and seven
   compressed background VT sessions at 30.5 MB process footprint.
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
