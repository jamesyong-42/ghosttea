# Truffle: sibling checkout → published Swift package

Truffle's Apple package moves from a relative-path SwiftPM dependency on a
sibling development checkout to its published repository at
`https://github.com/vibecook-dev/truffle.git`.

This branch applies the whole downstream change **except** the four values that
cannot exist until Truffle publishes. They are committed as loud placeholders so
nothing resolves, builds, or passes a release gate against a half-migrated pin.

## Why this was more than a one-line dependency swap

The old wiring bound the two repositories in four separate places, only one of
which was the SwiftPM dependency:

| Binding                | Was                                                                                | Now                                                              |
| ---------------------- | ---------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Package dependency     | `.package(path: "../../../p008/truffle/apple")`, identity `apple`                  | `.package(url:revision:)`, identity `truffle`                    |
| TailscaleKit artifact  | read from `../p008/truffle/apple/Vendor/…` at archive and device-run time          | checksum-verified SwiftPM binary target                          |
| Release revision proof | `git rev-parse HEAD` in the sibling working tree                                   | the `truffle` pin in `Package.resolved`                          |
| Notice documents       | `../p008/truffle/LICENSE` and `../p008/truffle/apple/.vendor/libtailscale/LICENSE` | vendored copies in this directory, hash-checked against the lock |

The license binding was the most fragile: `.vendor/libtailscale/` is a
**gitignored transient clone** that only exists on a machine which has run
Truffle's materializer, so the bundled third-party notice could not be rebuilt
from a clean checkout. Both documents are now vendored here, byte-identical to
Truffle's originals (`TAILSCALE-LICENSE` hashes to the `licenseSha256` the lock
already recorded; `TRUFFLE-LICENSE` adds `package.licenseSha256`).

## What replaced the materializer source-text contracts

`check-ios-app-store-readiness.mjs` used to grep Truffle's
`materialize-tailscalekit.sh` for three exact strings, asserting _indirectly_
that both framework slices were stamped with the reviewed privacy manifest.
With a prebuilt artifact there is no script to grep, so the check now asserts
the property itself: the resolved XCFramework must carry
`PrivacyInfo.xcprivacy` in exactly two slices, each semantically equal to the
reviewed copy. That is strictly stronger — it inspects the artifact rather than
the script that was supposed to produce it.

`requireExactRevision` likewise got stronger. It used to mean "the checkout next
door happens to be parked at the right commit"; it now means "SwiftPM will build
exactly this commit".

## Placeholders to fill when Truffle publishes

| Placeholder                                           | Where                                                                                  | Source                                                                           |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `REPLACE_WITH_TRUFFLE_ROOT_MANIFEST_REVISION`         | `Package.swift` (`truffleRevision`) and `truffle-swift.lock.json` (`package.revision`) | the Truffle commit that adds the root manifest — must be identical in both files |
| `REPLACE_WITH_PUBLISHED_XCFRAMEWORK_ZIP_URL`          | `truffle-swift.lock.json` (`tailscaleKit.distribution.url`)                            | Truffle's release asset URL                                                      |
| `REPLACE_WITH_SWIFT_PACKAGE_COMPUTE_CHECKSUM_OUTPUT`  | same, `distribution.swiftPMChecksum`                                                   | `swift package compute-checksum TailscaleKit.xcframework.zip`                    |
| `REPLACE_WITH_PUBLISHED_IOS_{ARM64,SIMULATOR}_SHA256` | same, `artifacts.*.sha256`                                                             | `shasum -a 256` of each slice in the published artifact                          |

Then regenerate the derived files:

```sh
node scripts/check-ios-release-bom.mjs --write   # BOM purl now derives from the lock's repository
npm run update:ios-release-resources             # rebuilds THIRD-PARTY-NOTICES.txt + bundled BOM
npm run check                                    # full gate
```

## Expect the artifact hashes to change

`artifacts.iosArm64.sha256` and `artifacts.iosSimulatorUniversal.sha256`
previously recorded a **locally built** XCFramework (Xcode 26.1 / Swift 6.2.1 /
Go 1.25.6, Apple silicon). Truffle's own `Vendor/README.md` warns that build
metadata changes the binary digest under a different toolchain, so a
CI-published artifact will almost certainly hash differently even from the same
libtailscale revision and patch.

This is a one-time re-baseline of the App Store evidence chain, and it is an
improvement: today the two repositories pin whatever each machine happened to
build, and afterwards both pin one published artifact that SwiftPM verifies by
checksum before unpacking.

## Truffle-side prerequisites

None of this resolves until Truffle ships:

1. A `Package.swift` at the **repository root** — SwiftPM cannot consume a
   manifest in a subdirectory over a URL dependency, and `apple/Package.swift`
   is where it lives today.
2. `.binaryTarget(url:checksum:)` instead of
   `.binaryTarget(path: "Vendor/TailscaleKit.xcframework")` — the artifact is
   gitignored, so a clean checkout currently fails at package-graph load for
   _every_ product, including the pure-Swift ones.
3. The published XCFramework zip as a release asset.

A revision pin is used rather than a version range deliberately: it matches the
exactness this lock already required, and it does not wait on Truffle adopting
SemVer tags, which its `truffle-vX.Y.Z` scheme does not currently provide.
Move to `exact:`/`from:` once it does.

## Keeping both paths working during the transition

Truffle should keep `apple/Package.swift` alongside the new root manifest until
this branch merges. Deleting it immediately would break the path dependency on
`main` here before the replacement is available — the two manifests can coexist
because SwiftPM only reads the root one for URL dependencies.
