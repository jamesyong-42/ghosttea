# iOS release hardening

**Status:** Phase 9 in progress (started under former Phase 8 numbering)

**Started:** 2026-07-18

## Deterministic component inventory

[`ios-release.cdx.json`](ios-release.cdx.json) is the checked-in CycloneDX 1.6
inventory for the iOS application's direct native inputs, complete
Apple-target Rust dependency closure, bundled resources, and reviewed build
toolchains. It is generated only by an explicit, reviewed `--write` invocation
from the authoritative repository pins:

- `native/ghostty.lock.json`;
- `native/ssh.lock.json`;
- `native/fonts.lock.json`;
- `truffle-swift.lock.json`;
- `ios-rust-components.lock.json` and its exact `Cargo.lock` hash;
- `ios-toolchain.lock.json`;
- the root package version and license; and
- the tracked MIT, OFL-1.1, and font-notice files.

The BOM records the shared Rust FFI runtime and all 83 non-development crates
selected from it for `aarch64-apple-ios`, pinned Ghostty source, OpenSSL,
libssh2, the exact sibling Truffle Swift revision, the exact TailscaleKit source
revision, reviewed source-patch path/hash/purpose, binary/license hashes, and
each of the five exact bundled font files. Relationships describe the static
native/runtime inputs, and every font carries its locked SHA-256. The carried
libtailscale patch fixes authenticated listener address lookup after
`SCM_RIGHTS` duplicates the accepted descriptor; it has passed the signed
iPhone shared-session and desktop-restart gates. The separately observed
self-recovering LocalAPI watch timeout remains a release-hardening item.
Xcode, Apple Swift/Clang, Rust/Cargo/LLVM, and all intended Apple Rust targets
are recorded as BOM creation tools. Registry crates carry the checksum selected
by `Cargo.lock`, SPDX license expressions, exact dependency edges, and their
target identity.
The BOM timestamp and serial are fixed so identical repository inputs produce
byte-identical JSON.

Run the drift gate with:

```sh
npm run check:ios-release-bom
```

After intentionally reviewing a lock change, regenerate the checked-in file
with:

```sh
npm run update:ios-rust-components
node scripts/check-ios-release-bom.mjs --write
npm run check:ios-release-bom
```

The Rust updater is the only step that asks Cargo to resolve the locked graph.
Ordinary verification is offline: it requires the recorded `Cargo.lock` hash
and exact BOM bytes to remain unchanged.

The verifier constructs the expected BOM in memory and compares it exactly
with the checked-in file. A changed dependency commit, tag, font hash, package
version, license text, or notice file therefore requires an intentional BOM
review. The ordinary repository `check` command includes this non-release
gate.

The dedicated `iOS release hardening` workflow repeats the drift and graph
checks on Linux, then validates the checked-in document as CycloneDX 1.6 with
the official CycloneDX CLI 0.32.0. This keeps schema validation independent
from the generator that produced the document.

## Reviewed release toolchain

`ios-toolchain.lock.json` records the exact Xcode, Swift, Clang, Rust, Cargo,
and LLVM identities used for the release candidate. Verify the current machine
with:

```sh
npm run check:ios-release-toolchain
```

`npm run archive:ios:app` runs both the BOM drift gate and this toolchain gate
before invoking Xcode. A release archive therefore cannot silently move to a
new compiler. Updating the toolchain lock is an explicit review operation and
must be followed by the complete release validation matrix.

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

## Remaining packaging work

The dependency and toolchain graph is now complete for the shared Rust archive.
Before release, the archive/export pipeline must embed the human-readable
third-party notices, validate their presence in the exported `.ipa`, and attach
the validated BOM to release provenance. Development-only Docker fixture tools
such as Zellij, htop, btop, and Claude Code do not ship in the iOS app and must
remain outside the release component graph.
