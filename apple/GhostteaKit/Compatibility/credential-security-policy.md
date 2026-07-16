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

`GhostteaSSH` includes async password and private-key credential cases that
receive opaque `SSHCredentialID` values. The iOS harness clears its editable
password field, stores the bytes in Keychain, resolves them only when
authentication begins, and removes the item immediately after connection or on
every failure path. The private-key case resolves key and optional passphrase
bytes only inside `connect()`. The legacy direct-password and path/string
public-key cases remain for fixture compatibility and must not be used by the
product app.

## Private-key materialization

The pinned libssh2 file API currently accepts private-key paths.
`ProtectedPrivateKeyMaterializer` therefore writes resolved bytes immediately
before authentication to a randomly named app-private temporary file. Its
directory is mode `0700`; each key is a regular file with mode `0600`, complete
file protection, and backup-exclusion metadata. `GhostteaSSH` removes the file
before `connect()` returns after success and on every thrown failure, timeout,
or cancellation path. The owning object makes an idempotent deinitialization
cleanup attempt as a final fallback. No workspace path refers to the temporary
file, and errors and logs do not include it.

Because the pinned candidate uses libssh2's OpenSSL backend, the opaque case
passes no public-key file path; libssh2 derives the public key from the resolved
private key. Product configuration therefore contains neither a public- nor a
private-key path.

The passphrase crosses the C boundary as counted bytes. The shim rejects
embedded NUL bytes, creates the null-terminated copy required by libssh2 only
for the call, and overwrites that copy before freeing it. Swift and libssh2 may
still make other copies, so this does not claim complete zeroization.

Longer term, prefer a libssh2 in-memory key API or a signing callback if the
required key formats and algorithms can pass the same compatibility matrix.

## User presence and background behavior

The default policy does not add per-read biometric or passcode prompts. The app
already stops terminal work in the background and treats reconnection as an
explicit state; `WhenUnlockedThisDeviceOnly` makes the lock boundary honest and
predictable. A future user-presence option requires separate UX and reconnect
tests and must not silently change existing credential accessibility.

## Verification

Package tests lock the opaque account format, reject an empty service name,
validate credential kinds, and verify exact private-key bytes, file type and
permissions, backup-exclusion metadata, explicit deletion, and deinitialization
cleanup.
The iOS Phase 0 harness performs a real Keychain save/load/delete round trip
using random non-user secret data and verifies that removal returns the item to
the missing state. A second physical-device probe authenticates to the
disposable SSH fixture through the on-demand resolver and cannot proceed to
command output unless immediate post-connect deletion succeeds. No test writes
user credentials to the Keychain. The disposable macOS OpenSSH matrix also
authenticates with a passphrase-encrypted key through the opaque resolver,
rejects an incorrect resolved passphrase, and leaves the protected temporary
directory empty. Physical-device private-key authentication remains a product
integration gate.
