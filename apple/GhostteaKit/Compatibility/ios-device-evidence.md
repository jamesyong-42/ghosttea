# Phase 0 iOS device evidence

This record captures reproducible physical-device observations from the
checked-in `apple/GhostteaHarness` diagnostic app. It does not contain device
serial numbers, UDIDs, credentials, or host-key material.

## 2026-07-16: Ghostty VT and scrollback memory

Environment:

- harness source: commit `8167f5f` (`feat: add iOS phase zero harness`);
- device: iPhone 14 Pro (`iPhone15,2`);
- operating system: iOS 26.5;
- reported physical memory: 5,662 MiB;
- toolchain: Xcode 26.1 with the iOS 26.1 SDK;
- connection: wired, paired, Developer Mode enabled;
- build: automatically signed Debug device build, installed and launched with
  Xcode's CoreDevice tooling.

The VT smoke test passed with the expected result:

```text
100x30, cursor 5,0, key [97]
```

The deterministic 80-column, 5,000-line memory matrix completed as follows.
Values are process physical-footprint deltas captured by the harness, not a
breakdown of every terminal-owned allocation.

| Sessions |  Empty |  Loaded | After full compression | Retained scrollback rows |
| -------: | -----: | ------: | ---------------------: | -----------------------: |
|        1 | 128 KB |  3.3 MB |               1,008 KB |                    4,977 |
|        4 | 512 KB | 13.5 MB |                 4.4 MB |        4,977 per session |
|        8 |   1 MB | 27.1 MB |                 6.6 MB |        4,977 per session |

All sessions reported full scrollback compression support. The loaded result
scaled approximately linearly to eight sessions, while compression reduced the
eight-session delta by about 76%. These measurements cover raw Ghostty VT state
only. They exclude the future Ghosttea model, TRF1 buffers, text shaping,
decoded images, Metal resources, transport state, and application UI budgets.

The physical-device VT build/run gate is satisfied. The same harness still
needs launch-server SSH, adverse-network transition, and complete terminal-stack
memory evidence before Phase 0 can close.

## 2026-07-16: password SSH command

The same signed harness connected over Wi-Fi to the repository's disposable
OpenSSH password fixture, exposed temporarily on the development Mac's trusted
LAN interface. The fixture was returned to its loopback-only default and shut
down immediately after the probe.

The device successfully completed all of the following:

- displayed the unknown Ed25519 host-key challenge before authentication;
- matched its SHA-256 fingerprint against an independently scanned value;
- applied an explicit accept-once decision without persisting the disposable
  fixture key;
- authenticated the `ghosttea` fixture account using the password method;
- executed the harness's default non-PTY command;
- drained the command output through the pull-based Swift transport; and
- observed a clean command exit.

Observed output:

```text
ghosttea-device-ok
Linux 361f033ac616 6.12.54-linuxkit #1 SMP Tue Nov 4 21:21:47 UTC 2025 aarch64 GNU/Linux
```

This satisfies the physical-device password-authentication and basic command
transport baseline. It does not replace representative launch-server coverage,
keyboard-interactive or public-key credential UI, adverse-network transitions,
or the stalled-reader flow-control fixture already covered on macOS.

## 2026-07-16: data-protection Keychain

The signed harness exercised the production-shaped `GhostteaCredentials`
package against the real iOS Keychain. It generated a random opaque connection
UUID and random non-user secret bytes, then:

1. stored the secret as a device-only, non-synchronizing generic-password item;
2. loaded and compared the bytes exactly;
3. removed the item; and
4. verified that a subsequent load returned no item.

Observed result:

```text
Passed · device-only, non-synchronizing item removed
```

The test left no credential item behind and did not use the user's SSH
credentials. This satisfies the persistent Keychain storage boundary. Async
private-key/passphrase resolution through libssh2's in-memory key API now passes
the macOS OpenSSH fixture; exercising that path with a Keychain-backed key on a
physical device remains a production-promotion gate.

## 2026-07-16: on-demand password resolution

The harness was rebuilt to use `SSHCandidateAuthentication.passwordCredential`
instead of the legacy direct password-string case. Before starting the task it
cleared the editable UIKit field, stored password bytes under an opaque random
credential ID, and configured the transport with only that ID and an async
resolver. `GhostteaSSH` requested the bytes when authentication began and the
harness removed the Keychain item immediately after `connect()` returned.
Failure and cancellation paths perform the same idempotent removal.

The physical iPhone then repeated the independently verified accept-once flow,
password authentication, command execution, clean exit, and output drain:

```text
ghosttea-device-ok
Linux 9e1f3e1ac677 6.12.54-linuxkit #1 SMP Tue Nov 4 21:21:47 UTC 2025 aarch64 GNU/Linux
```

Because credential removal occurs before the harness begins reading command
output, this successful result also proves that immediate post-authentication
deletion succeeded. The disposable LAN fixture was shut down afterward.

## 2026-07-16: encrypted private-key resolution

The signed harness was rebuilt with its private-key diagnostic path and
connected over Wi-Fi to the disposable OpenSSH public-key fixture. Only the
public-key endpoint was temporarily bound to the development Mac's trusted LAN
interface. The generated encrypted Ed25519 fixture key was transferred through
Universal Clipboard and was not a user credential.

Before connecting, the harness cleared the editable private-key and passphrase
fields and stored their bytes as separate device-only, non-synchronizing
Keychain items under random opaque IDs. `GhostteaSSH` resolved both items only
when authentication began, passed the counted private-key bytes to libssh2's
in-memory API, and let its OpenSSL backend derive the public key. No private-key
path or temporary key file was created. The harness deleted both Keychain items
immediately after `connect()` returned and before reading command output.

The physical iPhone authenticated with the encrypted key and passphrase,
executed the default command, observed a clean exit, and drained:

```text
ghosttea-device-ok
Linux ea1647e1f80f 6.12.54-linuxkit #1 SMP Tue Nov 4 21:21:47 UTC 2025 aarch64 GNU/Linux
```

This closes the physical-device opaque private-key/passphrase resolver gate.
The LAN fixture was stopped and removed immediately after the probe, and the
disposable key was cleared from the Mac clipboard.
