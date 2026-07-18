# iOS release hardening

**Status:** Phase 9 in progress (started under former Phase 8 numbering)

**Started:** 2026-07-18

## Deterministic component inventory

[`ios-release.cdx.json`](ios-release.cdx.json) is the checked-in CycloneDX 1.6
inventory for the iOS application's direct native and bundled inputs. It is
generated only by an explicit, reviewed `--write` invocation from the
authoritative repository pins:

- `native/ghostty.lock.json`;
- `native/ssh.lock.json`;
- `native/fonts.lock.json`;
- `truffle-swift.lock.json`;
- the root package version and license; and
- the tracked MIT, OFL-1.1, and font-notice files.

The BOM records the shared Rust FFI runtime, pinned Ghostty source, OpenSSL,
libssh2, the exact sibling Truffle Swift revision, the exact TailscaleKit source
revision, reviewed source-patch path/hash/purpose, binary/license hashes, and
each of the five exact bundled font files. Relationships describe the static
native/runtime inputs, and every font carries its locked SHA-256. The carried
libtailscale patch fixes authenticated listener address lookup after
`SCM_RIGHTS` duplicates the accepted descriptor; it has passed the signed
iPhone shared-session and desktop-restart gates. The separately observed
self-recovering LocalAPI watch timeout remains a release-hardening item.
The BOM timestamp and serial are fixed so identical repository inputs produce
byte-identical JSON.

Run the drift gate with:

```sh
npm run check:ios-release-bom
```

After intentionally reviewing a lock change, regenerate the checked-in file
with `node scripts/check-ios-release-bom.mjs --write` and run the drift gate
again.

The verifier constructs the expected BOM in memory and compares it exactly
with the checked-in file. A changed dependency commit, tag, font hash, package
version, license text, or notice file therefore requires an intentional BOM
review. The ordinary repository `check` command includes this non-release
gate.

## Fail-closed release mode

Release certification additionally runs:

```sh
npm run check:ios-release-ready
```

This mode currently fails by design because `native/ssh.lock.json` records
`productionApproved: false` for the pinned libssh2 release and names the
required upstream security fixes and revalidation matrix. Development and
parity work may continue, but a release artifact cannot pass while that policy
bit remains false.

Changing the bit alone is not approval. The SSH lock must first move to a fixed
source revision, incorporate the required fixes, and record successful Apple
artifact, package, fixture, Swift, and physical-device revalidation.

## Remaining BOM work

This first gate intentionally covers direct/static iOS inputs and bundled
files. Before release, expand the packaged artifact BOM with the exact
transitive Rust crates selected for each Apple target and the final Xcode/Swift
toolchain identity, then validate the CycloneDX document in the release CI
environment. Development-only Docker fixture tools such as Zellij, htop, btop,
and Claude Code do not ship in the iOS app and must remain outside the release
component graph.
