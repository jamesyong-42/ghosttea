# SSH credential security policy

**Status:** Phase 0 implementation boundary

**Recorded:** 2026-07-16

## Storage boundary

`GhostteaCredentials` owns persistent SSH secret storage. Its
`KeychainSSHCredentialStore` uses generic-password items in Apple's
data-protection Keychain with these invariants:

- `kSecAttrAccessibleWhenUnlockedThisDeviceOnly` prevents access while the
  device is locked and prevents migration to another device;
- `kSecAttrSynchronizable = false` prevents iCloud Keychain synchronization;
- `kSecUseDataProtectionKeychain = true` selects the modern data-protection
  Keychain on supported Apple platforms;
- the initial app has no shared Keychain access group;
- Keychain account metadata contains only a version, an opaque connection UUID,
  and the secret kind;
- hostnames, ports, usernames, fingerprints, passwords, private keys, and
  passphrases never appear in the Keychain account or label;
- workspace restoration persists only the opaque credential reference, never
  secret bytes.

The supported secret kinds are password, private key, and private-key
passphrase. Empty secret data remains representable because SSH servers may
permit an empty password; absence is represented by a missing Keychain item.

## Runtime lifetime

The vault returns `Data` rather than `String` so callers can avoid unnecessary
Unicode conversions and reduce immutable secret copies. Swift and Security
framework internals may still copy buffers, so the app must not claim guaranteed
zeroization. Callers must:

1. resolve the credential only when authentication begins;
2. keep it out of configuration descriptions, errors, analytics, crash
   metadata, and task names;
3. release the returned data immediately after the authentication operation;
4. clear editable UIKit fields after submission; and
5. request the credential again after reconnect rather than retaining it in
   workspace or session state.

The current Phase 0 `SSHCandidateConfiguration` still carries password and
passphrase strings. Production promotion therefore requires replacing those
cases with an async credential resolver receiving an opaque
`SSHCredentialID`.

## Private-key materialization

The pinned libssh2 file API currently accepts private-key paths. A production
resolver may materialize Keychain private-key bytes only immediately before
authentication into an app-private temporary file with complete file
protection and backup exclusion. The adapter must delete the file after the
authentication call on success, failure, timeout, and cancellation. No
workspace path may refer to that temporary file, and logs must not include it.

Longer term, prefer a libssh2 in-memory key API or a signing callback if the
required key formats and algorithms can pass the same compatibility matrix.

## User presence and background behavior

The default policy does not add per-read biometric or passcode prompts. The app
already stops terminal work in the background and treats reconnection as an
explicit state; `WhenUnlockedThisDeviceOnly` makes the lock boundary honest and
predictable. A future user-presence option requires separate UX and reconnect
tests and must not silently change existing credential accessibility.

## Verification

Package tests lock the opaque account format and reject an empty service name.
The iOS Phase 0 harness performs a real Keychain save/load/delete round trip
using random non-user secret data and verifies that removal returns the item to
the missing state. No test writes fixture credentials to the user's Keychain.
