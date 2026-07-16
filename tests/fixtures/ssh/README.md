# OpenSSH compatibility fixtures

This fixture runs five OpenSSH servers and one protocol blackhole in one local
container:

| Host port | Authentication policy                 | Purpose                                                             |
| --------- | ------------------------------------- | ------------------------------------------------------------------- |
| `22022`   | password                              | Baseline password authentication                                    |
| `22023`   | keyboard-interactive                  | Deterministic hidden password and echo-on verification-code prompts |
| `22024`   | public key, then keyboard-interactive | SSH partial-success and sequential-MFA gate                         |
| `22025`   | public key                            | Noninteractive session, PTY, exit, and flood probes                 |
| `22026`   | no SSH banner                         | Deterministic handshake deadline and cancellation                   |
| `22027`   | public key                            | ECDSA P-256 host key and AES-256-GCM negotiation                    |

The fixture credentials are intentionally public and must never be reused:

- username: `ghosttea`;
- password: `ghosttea-password`;
- verification code: `123456`.
- encrypted-key passphrase: `ghosttea-key-passphrase`.

The client keys are generated into ignored `native/build/ssh-fixture/` state.
No private key is committed. Each container creation generates fresh, distinct
host keys, and the harness records those keys before connecting with strict
host-key checking.

From the repository root:

```sh
npm run test:ssh:fixture
npm run test:ssh:fixture:candidate
npm run test:ssh:fixture:swift
```

Use `npm run fixture:ssh:up` to leave the endpoints running for an adapter
spike and `npm run fixture:ssh:down` when finished. Set
`GHOSTTEA_SSH_PASSWORD_PORT`, `GHOSTTEA_SSH_KEYBOARD_PORT`,
`GHOSTTEA_SSH_PARTIAL_PORT`, `GHOSTTEA_SSH_PUBLIC_KEY_PORT`, or
`GHOSTTEA_SSH_BLACKHOLE_PORT`, or `GHOSTTEA_SSH_ECDSA_AESGCM_PORT` to avoid
local port conflicts.

The automated matrix verifies:

- password, public-key, and mixed echo/no-echo keyboard-interactive
  authentication;
- passphrase-encrypted Ed25519 authentication and incorrect-passphrase
  rejection;
- rejection when the partial-success endpoint is used without its required
  public-key step;
- public-key plus keyboard-interactive sequential authentication;
- separated stdout/stderr and an exact nonzero remote exit status;
- a remote shell terminated by `SIGTERM`, reported as signal name `TERM`
  rather than conflated with exit code zero;
- initial PTY dimensions and a later window-change request;
- a 32 MiB output flood that is stalled for 750 ms, remains below a 64 MiB
  client RSS gate, and then drains byte-for-byte without disconnecting.
- a peer that accepts TCP but never sends an SSH banner, proving the handshake
  deadline and task-cancellation paths without relying on external networks.
- strict known-host verification and a complete shell session using ECDSA
  P-256 plus bidirectional AES-256-GCM.

The first command proves all server/session scenarios with the system OpenSSH
client. The candidate command compiles a test-only C client against the packaged
libssh2 XCFramework and proves password, public key, two-round
keyboard-interactive, strict known-host matching, command execution, and
explicit chained authentication. The accepted partial key step currently
returns `LIBSSH2_ERROR_PUBLICKEY_UNVERIFIED` (`-19`); the next method succeeds,
while a wrong-key control remains rejected. The Swift command exercises the
nonblocking adapter through the shared `TerminalTransport` protocol. It repeats
the authentication matrix, verifies initial and resized PTY dimensions,
deliberately stops reading during the 32 MiB flood, drains it byte-for-byte, and
rejects the wrong-key control. It also gates stalled-process RSS below 64 MiB,
requires a blocked read to observe cancellation within one second, and verifies
that strict host checking rejects both unknown and changed keys. Negotiated
methods are asserted as Curve25519, Ed25519, ChaCha20-Poly1305, and
HMAC-SHA2-256 so dependency or server-default drift fails the fixture visibly.
The second profile locks Curve25519, ECDSA P-256, bidirectional AES-256-GCM,
and libssh2's `INTEGRATED-AES-GCM` MAC report.
Keyboard-interactive challenges cross an async Swift responder and assert exact
prompt text plus echo policy across informational, password, and verification
code rounds. A separate control cancels while that responder is suspended and
requires the blocked native callback worker to unwind within one second.
Three non-PTY command controls cover termination semantics: one asserts
separate, byte-exact stdout/stderr and exit 37; another writes through `cat`,
sends SSH input EOF, drains the exact output, and completes the channel close
handshake with exit 0; the third kills its remote shell with `SIGTERM` and
requires the typed result `.signaled(name: "TERM")`. The banner-blackhole
controls require a 250 ms handshake deadline to fire within two seconds and
cancellation to unwind within one second.
