# SSH Phase 0 compatibility matrix

This matrix is a release gate, not an aspirational feature list. A candidate
must pass representative live servers before it is selected. “Required” means
the capability blocks an SSH-first v1; “scenario-dependent” means product
scope must explicitly accept the gap.

## Candidate screening

| Candidate                      | Password / key | Keyboard-interactive   | Chained public-key + MFA                                                  | Apple build                    | Phase 0 disposition                                                                   |
| ------------------------------ | -------------- | ---------------------- | ------------------------------------------------------------------------- | ------------------------------ | ------------------------------------------------------------------------------------- |
| SwiftNIO SSH 0.14.1 directly   | Yes            | No client auth offer   | No exposed flow                                                           | Native Swift                   | Rejected for the current v1 requirements unless missing protocol work is funded       |
| Citadel 0.12.1                 | Yes            | No public auth method  | No public auth method                                                     | Native Swift                   | Rejected; its higher-level API does not close the SwiftNIO SSH gap                    |
| libssh2 1.11.1 + OpenSSL 3.5.6 | Adapter pass   | Two-round adapter pass | Passes with explicit sequencing; partial key step returns ambiguous `-19` | Three-slice XCFramework proven | Leading candidate; retain production-server, credential UI, network, and device gates |

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
exit-stream/status, and stalled-reader flood checks. The nonblocking Swift
adapter now passes the same authentication policies, strict host-key negative
controls, PTY/resize, typed exit status/signal, encrypted keys, connection and
handshake cancellation, two algorithm profiles, and the stalled-reader flood.

## Live-server matrix

| Area           | Probe                                         | v1 expectation            | libssh2 compile evidence                             | Remaining gate                                                   |
| -------------- | --------------------------------------------- | ------------------------- | ---------------------------------------------------- | ---------------------------------------------------------------- |
| Authentication | Password                                      | Required                  | Nonblocking Swift adapter passes                     | Physical-device fixture                                          |
| Authentication | Ed25519 public key                            | Required                  | Nonblocking unencrypted and encrypted keys pass      | Add Keychain-backed loading                                      |
| Authentication | ECDSA user key                                | Product-sample dependent  | OpenSSL backend present; host-key profile passes     | Decide from target-server/user-key sample                        |
| Authentication | Encrypted private-key loading                 | Required                  | Correct passphrase passes; incorrect one is rejected | Define Keychain-backed loading and secret-lifetime policy        |
| Authentication | Keyboard-interactive, one prompt              | Required for common 2FA   | Async responder preserves prompt text and echo       | Wire UIKit/Keychain policy                                       |
| Authentication | Keyboard-interactive, multiple prompts        | Required for common 2FA   | Zero-prompt and mixed echo/no-echo rounds pass       | Add a nonempty name/instruction server fixture                   |
| Authentication | Partial success followed by second factor     | Required for common 2FA   | Explicit policy and async responder pass; key `-19`  | Retain wrong-key regression; wire product policy                 |
| Host identity  | Known-hosts match, unknown host, changed host | Required                  | Strict match and both rejection controls pass        | Implement explicit user decision and persistent update policy    |
| Host keys      | Ed25519 and ECDSA                             | Required                  | Ed25519 and ECDSA P-256 negotiated fixtures pass     | Repeat against launch server sample                              |
| Host keys      | RSA/SHA-2                                     | Scenario-dependent        | RSA-3072 host negotiated as `rsa-sha2-512`           | Decide required scope from target-server sample                  |
| Key exchange   | Curve25519 SHA-256                            | Required                  | `curve25519-sha256` negotiated and locked            | Repeat against launch server sample                              |
| Encryption     | AES-GCM and ChaCha20-Poly1305                 | Required                  | AES-256-GCM and ChaCha20-Poly1305 profiles pass      | Repeat against launch server sample                              |
| Session        | PTY allocation and shell start                | Required                  | Nonblocking adapter fixture passes                   | Physical-device fixture                                          |
| Session        | Initial and repeated window resize            | Required                  | 41x132 allocation and 50x140 resize pass             | Physical-device fixture                                          |
| Session        | Exit status/signal, EOF, half-close           | Required                  | Exit 37, `SIGTERM`, half-close, and close pass       | Repeat on physical device                                        |
| Cancellation   | Cancel auth/connect/handshake/read            | Required                  | One-shot plus 16 auth and 32 handshake cycles pass   | Add adverse-network transition and physical-device tests         |
| Networking     | Wi-Fi/cellular transition and reconnect UX    | Required product behavior | Adapter/orchestrator responsibility                  | Pass physical-device test                                        |
| Flow control   | Sustained output with bounded app queues      | Required                  | 32 MiB stalled flood drains exactly at ~10 MB RSS    | Instrument channel windows and repeat on low-end physical device |

## Decision rule

Do not promote the candidate `GhostteaSSH` package into a production transport
until every required row is green or has a documented, tested companion
implementation. In particular, a successful chained fixture does not waive the
ambiguous partial-step return-state gate or the need for a real challenge UI.

The flood fixture must issue network/channel demand only when the terminal
actor has capacity and verify that memory remains bounded while the server
emits sustained output. A `yes` or large-file flood must pause delivery through
the SSH flow-control mechanism rather than disconnecting or dropping bytes.

See [ssh-candidate-decision.md](ssh-candidate-decision.md) for pins, artifact
evidence, and the next implementation boundary.
