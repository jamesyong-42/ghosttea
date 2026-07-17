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
product credential UI, adverse-network transitions, or the stalled-reader
flow-control fixture already covered on macOS.

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

## 2026-07-16: route-loss cancellation and fresh reconnect

The harness ran a command that emitted a readiness marker and one heartbeat per
second through the disposable password fixture. After the connection was
established, Wi-Fi was disabled from Control Center, moving the phone away from
the fixture's LAN-only route. The user then explicitly cancelled the command.

The retained Swift task propagated cancellation into `GhostteaSSH`, whose
socket-wait cancellation handler called `shutdown(SHUT_RDWR)` before unwinding
the serialized session. The harness reported:

```text
Cancelled in 23 ms
```

This is below the one-second Phase 0 cancellation gate. It proves prompt
physical-device teardown when the active route disappears; it does not claim
that an ordinary SSH session survives a network transition.

The original fixture was removed. After Wi-Fi was restored, a fresh fixture
with a separately verified host key was started and accepted once. A new
connection authenticated through the opaque password resolver and drained:

```text
ghosttea-reconnect-ok
Linux 3caa85b42359 6.12.54-linuxkit #1 SMP Tue Nov 4 21:21:47 UTC 2025 aarch64 GNU/Linux
```

This satisfies the local physical-device route-loss cancellation and explicit
fresh-reconnect baseline. Automatic path monitoring, retry policy, UI state,
and representative launch-server behavior remain product gates. The second
fixture was stopped and removed immediately after the probe.

## 2026-07-16: keyboard-interactive challenge UI

The signed harness added a keyboard-interactive authentication mode backed by
the asynchronous `GhostteaSSH` responder. Only the test-only protocol-metadata
endpoint was temporarily exposed on the trusted LAN. Its fresh Ed25519
fingerprint was scanned independently on the Mac and supplied for the
accept-once decision.

The first physical attempt exposed a real presentation race: dismissing the
host-key sheet while presenting a separate authentication sheet left the
native callback waiting until the fixture rejected the exchange. The harness
was corrected to keep one continuous SSH-interaction sheet alive across the
host-key and authentication stages. The fixture's human-response allowance was
also made explicit, without adding a client-side authentication timeout.

The rebuilt harness then presented the metadata fixture's protocol name and
instruction, maintained prompt order, used a secure field for the no-echo
password prompt, and a visible field for the echo-on verification-code prompt.
Submitting `ghosttea-password` and `123456` authenticated successfully,
executed the configured non-PTY command, and drained:

```text
ghosttea-metadata-command-ok
```

This closes the diagnostic physical-device keyboard-interactive UI gate for a
two-prompt, mixed-echo challenge with nonempty name and instruction. Product UI
promotion, representative 2FA servers, and the explicit
public-key-plus-second-factor product policy remain open.

The rebuilt harness then repeated the flow against a fresh fixture and
independently supplied fingerprint. Instead of entering answers, the user
pressed **Cancel** on the authentication challenge. The sheet routed that
action through the SSH task-cancellation path; the suspended responder and
native callback worker unwound, and the harness reported:

```text
Cancelled in 162 ms
```

This is below the one-second Phase 0 gate and closes the diagnostic on-device
keyboard-interactive cancellation check. Each LAN fixture was stopped and
removed immediately after its probe.

## 2026-07-16: host-key persistence and replacement

The physical iPhone next exercised both persistent host-key decisions against
the disposable password endpoint. For the first fresh key, the user compared
the displayed Ed25519 fingerprint with the independently scanned value, chose
**Accept & Store**, authenticated, and completed the default command.

The fixture was then removed and recreated at the same host and port, producing
a different Ed25519 key. On the next connection the harness identified the
stored-key mismatch, displayed **Host key changed** with the red warning to
verify independently, and showed the newly scanned fingerprint. After the user
chose **Accept & Store**, authentication and command execution succeeded. A
third connection to the unchanged replacement fixture completed without any
host-key prompt, proving that the old entry was replaced and that the new entry
passed strict verification.

This closes the diagnostic physical-device unknown-key persistence,
changed-key warning/replacement, and strict-reconnect UI gate. Representative
launch-server host-key behavior and promotion into the production connection
UI remain open. Both disposable LAN fixtures were stopped and removed
immediately after their respective probes.

## 2026-07-16: command streams and typed termination

The harness command drain was corrected to consume
`SSHCandidateConnection.readCommandOutput`, preserving stdout and stderr as
distinct bounded streams instead of reading only the generic terminal stream.
The signed iPhone build then ran two deterministic commands through the
disposable password endpoint.

The first command emitted one line on each stream and exited with status 37.
The harness displayed `fixture-stdout` as stdout, `fixture-stderr` in its
separate stderr section, and reported `exit 37`. The second command terminated
its remote shell with `SIGTERM`; the harness reported `signal TERM` rather than
conflating the signal with exit zero.

This closes the physical-device separate command-stream, nonzero exit-status,
and remote-signal reporting checks. Those commands did not exercise shell input
half-close or PTY resize. The LAN fixture was stopped and removed immediately
after the probes.

## 2026-07-16: PTY resize and input half-close

The signed harness added two self-validating physical-device session modes. The
PTY probe requested an `xterm-256color` shell at 132 columns by 41 rows, waited
until the remote shell reported `INITIAL 41 132`, resized the live channel to
140 columns by 50 rows, and required `RESIZED 50 140` plus exit zero. The first
attempt established from the fixture that the PTY had resized correctly, but
Debian's interactive `dash` did not run the probe's `WINCH` trap. The probe was
corrected to poll `stty size`, avoiding shell-specific signal behavior while
still validating the actual remote PTY dimensions. The iPhone then displayed:

```text
INITIAL 41 132
RESIZED 50 140
```

The half-close probe opened a non-PTY `cat` command, wrote one fixed payload,
sent SSH input EOF without closing the output side, drained the byte-exact
echo, and required a clean exit zero. The iPhone displayed:

```text
ghosttea-half-close-device-ok
```

These results close the local physical-device PTY allocation, live resize,
input half-close, post-EOF output drain, and clean channel-close gates. The LAN
fixture was stopped and removed immediately after both successful probes.

## 2026-07-16: automatic path and background reconnect state

The signed harness next used the reusable `GhostteaTransport` reconnect reducer
and Network.framework observer on the same iPhone. Before connecting, the UI
reported `Satisfied · Wi-Fi` and lifecycle `Idle`. A long-lived command reached
the connected state through the LAN password fixture.

Without pressing **Cancel**, the user disabled Wi-Fi. Network.framework selected
the cellular route and the harness reported `Satisfied · Cellular · expensive`
plus lifecycle `Reconnect available`. The route event invalidated and cancelled
the active SSH generation before offering the explicit fresh-connection state;
it did not silently reuse the old ordinary SSH session. After Wi-Fi restoration,
the user reloaded the disposable credential, explicitly ran a fresh bounded
command, and confirmed it passed.

A separate long-lived connection exercised application suspension. Sending the
app to the background tore down the active generation. Reopening the app showed
`Reconnect available`; no connection started automatically. This closes the
local physical-device automatic selected-route, background teardown, stale-task
isolation, and explicit-reconnect state gates. Representative launch-server
transitions remain open. The LAN fixture was stopped and removed immediately
after the probes.

The workflow was then promoted into `npm run test:ios:device`. The runner
discovers a single paired physical iOS device and the Mac's Bonjour hostname,
checks device lock state, runs all 23 Swift package tests, builds both iOS SDK
destinations, signs and installs the physical build, passes only the non-secret
fixture host into the launched process, and keeps the fixture alive only while
the runner is attached. A launch attempt that encountered a re-locked phone
proved cleanup on failure; the runner was then changed to postpone LAN exposure
until after all builds and wait for a fresh unlock immediately before launch.

The corrected end-to-end run launched on the iPhone 14 Pro. Its guided probes
automatically selected disposable credentials and commands, enforced sub-second
teardown, and recorded pass/fail. The user performed only the system gestures:
switching Wi-Fi, restoring Wi-Fi, and backgrounding/reopening the app. Automatic
route teardown passed, exact-output explicit fresh reconnect passed, and
background teardown plus foreground reconnect availability passed. Returning
to the runner stopped and removed the fixture.

## 2026-07-16: cancellable Bonjour hostname resolution

The connector replaced its synchronous resolving `getaddrinfo` call with Apple
DNS-SD under the same absolute deadline as TCP establishment. A package test
cancels an actively pending unique `.local.` lookup in approximately 108 ms,
and a separate loopback test connects through `localhost`. The complete macOS
SSH fixture also authenticates through `localhost`, and the harness builds for
the iOS device and simulator SDKs.

The automated physical-device runner now passes the Mac's Bonjour hostname by
default while continuing to expose the disposable fixture only after all
builds and a fresh unlock. It selects the sole team configured in Xcode when no
environment override is supplied and permits automatic profile updates. It
signed, installed, and launched the harness on the iPhone 14 Pro with
`Jamess-MacBook-Pro-9.local.:22022`. The bounded password command resolved that
hostname on-device and returned:

```text
ghosttea-device-ok
Linux … aarch64 GNU/Linux
```

This closes the local physical-device hostname-resolution gate. The runner
then stopped and removed the fixture. Representative launch-server DNS and
split-horizon/VPN behavior remain open.
