# SSH Phase 0 compatibility matrix

This matrix is a release gate, not an aspirational feature list. A candidate
must pass representative live servers before it is selected. “Required” means
the capability blocks an SSH-first v1; “scenario-dependent” means product
scope must explicitly accept the gap.

## Candidate screening

| Candidate                      | Password / key | Keyboard-interactive   | Chained public-key + MFA                                                  | Apple build                    | Phase 0 disposition                                                             |
| ------------------------------ | -------------- | ---------------------- | ------------------------------------------------------------------------- | ------------------------------ | ------------------------------------------------------------------------------- |
| SwiftNIO SSH 0.14.1 directly   | Yes            | No client auth offer   | No exposed flow                                                           | Native Swift                   | Rejected for the current v1 requirements unless missing protocol work is funded |
| Citadel 0.12.1                 | Yes            | No public auth method  | No public auth method                                                     | Native Swift                   | Rejected; its higher-level API does not close the SwiftNIO SSH gap              |
| libssh2 1.11.1 + OpenSSL 3.5.6 | Fixture pass   | Two-round fixture pass | Passes with explicit sequencing; partial key step returns ambiguous `-19` | Three-slice XCFramework proven | Advance to nonblocking adapter evaluation, but do not select for production yet |

The libssh2 finding is narrower than an unconditional “supports MFA.” It passes
the pinned two-round keyboard-interactive and
`publickey,keyboard-interactive` fixtures. In the chained case the accepted
public key returns `LIBSSH2_ERROR_PUBLICKEY_UNVERIFIED` (`-19`) rather than an
explicit partial-success result; invoking the required second method then
succeeds. A wrong-key control remains rejected. The production adapter must
avoid treating every `-19` as permission to downgrade to another method.

The pinned OpenSSH fixture now proves the required password, public-key,
two-prompt keyboard-interactive, and `publickey,keyboard-interactive` reference
server scenarios. Its system-OpenSSH client baseline also passes PTY resize,
exit-stream/status, and stalled-reader flood checks. Matrix rows remain open
until the libssh2 adapter—not the reference client—passes them.

## Live-server matrix

| Area           | Probe                                         | v1 expectation            | libssh2 compile evidence                         | Remaining gate                                                   |
| -------------- | --------------------------------------------- | ------------------------- | ------------------------------------------------ | ---------------------------------------------------------------- |
| Authentication | Password                                      | Required                  | Pinned blocking fixture passes                   | Repeat through nonblocking Swift adapter                         |
| Authentication | Ed25519 public key                            | Required                  | Unencrypted-key fixture passes                   | Add encrypted-key fixture and repeat through adapter             |
| Authentication | ECDSA public key                              | Required                  | API and OpenSSL backend present                  | Pass fixture                                                     |
| Authentication | Encrypted private-key loading                 | Required                  | Library API present                              | Define Keychain-backed loading and pass fixture                  |
| Authentication | Keyboard-interactive, one prompt              | Required for common 2FA   | Imported Swift symbol and archive symbol proven  | Pass fixture with prompt metadata preserved                      |
| Authentication | Keyboard-interactive, multiple prompts        | Required for common 2FA   | Two sequential prompt callbacks pass             | Preserve metadata in adapter; add mixed echo/no-echo fixture     |
| Authentication | Partial success followed by second factor     | Required for common 2FA   | Explicit sequence passes; key step returns `-19` | Implement policy-safe sequencing and retain wrong-key control    |
| Host identity  | Known-hosts match, unknown host, changed host | Required                  | Known-host API present                           | Implement policy/UI and pass all three fixtures                  |
| Host keys      | Ed25519 and ECDSA                             | Required                  | OpenSSL backend built                            | Pass fixture                                                     |
| Host keys      | RSA/SHA-2                                     | Scenario-dependent        | OpenSSL backend built                            | Decide from target-server sample                                 |
| Key exchange   | Curve25519 SHA-256                            | Required                  | Built implementation                             | Pass fixture                                                     |
| Encryption     | AES-GCM and ChaCha20-Poly1305                 | Required                  | Built implementations                            | Pass fixture and record negotiated algorithms                    |
| Session        | PTY allocation and shell start                | Required                  | Channel APIs present                             | Pass fixture                                                     |
| Session        | Initial and repeated window resize            | Required                  | PTY resize API present                           | Pass end-to-end fixture                                          |
| Session        | Exit status, EOF, half-close                  | Required                  | Channel APIs present                             | Pass fixture without truncation                                  |
| Cancellation   | Cancel auth/connect/read without leaked tasks | Required                  | Adapter responsibility                           | Pass stress test                                                 |
| Networking     | Wi-Fi/cellular transition and reconnect UX    | Required product behavior | Adapter/orchestrator responsibility              | Pass physical-device test                                        |
| Flow control   | Sustained output with bounded app queues      | Required                  | Nonblocking, caller-driven reads available       | Prove SSH receive-window behavior and bounded memory under flood |

## Decision rule

Do not promote `GhostteaSSHProbe` into a production `GhostteaSSH` transport
until every required row is green or has a documented, tested companion
implementation. In particular, a successful chained fixture does not waive the
ambiguous partial-step return-state gate.

The flood fixture must issue network/channel demand only when the terminal
actor has capacity and verify that memory remains bounded while the server
emits sustained output. A `yes` or large-file flood must pause delivery through
the SSH flow-control mechanism rather than disconnecting or dropping bytes.

See [ssh-candidate-decision.md](ssh-candidate-decision.md) for pins, artifact
evidence, and the next implementation boundary.
