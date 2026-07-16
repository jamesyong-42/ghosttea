# OpenSSH compatibility fixtures

This fixture runs four OpenSSH servers in one local container:

| Host port | Authentication policy                 | Purpose                                                              |
| --------- | ------------------------------------- | -------------------------------------------------------------------- |
| `22022`   | password                              | Baseline password authentication                                     |
| `22023`   | keyboard-interactive                  | Deterministic two-prompt password and verification-code conversation |
| `22024`   | public key, then keyboard-interactive | SSH partial-success and sequential-MFA gate                          |
| `22025`   | public key                            | Noninteractive session, PTY, exit, and flood probes                  |

The fixture credentials are intentionally public and must never be reused:

- username: `ghosttea`;
- password: `ghosttea-password`;
- verification code: `123456`.

The client key is generated into ignored `native/build/ssh-fixture/` state. No
private key is committed. Each container creation generates fresh, distinct
Ed25519 host keys, and the harness records those keys before connecting with
strict host-key checking.

From the repository root:

```sh
npm run test:ssh:fixture
```

Use `npm run fixture:ssh:up` to leave the endpoints running for an adapter
spike and `npm run fixture:ssh:down` when finished. Set
`GHOSTTEA_SSH_PASSWORD_PORT`, `GHOSTTEA_SSH_KEYBOARD_PORT`,
`GHOSTTEA_SSH_PARTIAL_PORT`, or `GHOSTTEA_SSH_PUBLIC_KEY_PORT` to avoid local
port conflicts.

The automated matrix verifies:

- password, public-key, and two-prompt keyboard-interactive authentication;
- rejection when the partial-success endpoint is used without its required
  public-key step;
- public-key plus keyboard-interactive sequential authentication;
- separated stdout/stderr and an exact nonzero remote exit status;
- initial PTY dimensions and a later window-change request;
- a 32 MiB output flood that is stalled for 750 ms, remains below a 64 MiB
  client RSS gate, and then drains byte-for-byte without disconnecting.

The current harness proves the server scenarios with the system OpenSSH
client. It does not count as libssh2 compatibility evidence until the
`GhostteaSSH` candidate adapter runs the same cases.
