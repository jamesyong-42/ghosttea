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

## Remaining placeholder

Only one value is still unknown — Truffle's artifact is already published.

| Placeholder                                   | Where                                                                                  | Source                                                                           |
| --------------------------------------------- | -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `REPLACE_WITH_TRUFFLE_ROOT_MANIFEST_REVISION` | `Package.swift` (`truffleRevision`) and `truffle-swift.lock.json` (`package.revision`) | the Truffle commit that adds the root manifest — must be identical in both files |

Then regenerate the derived files:

```sh
node scripts/check-ios-release-bom.mjs --write   # BOM purl now derives from the lock's repository
npm run update:ios-release-resources             # rebuilds THIRD-PARTY-NOTICES.txt + bundled BOM
npm run check                                    # full gate
```

## The artifact hashes did NOT change

An earlier draft of this document warned that the pinned per-slice digests would
have to be re-baselined, on the reasoning that Truffle's `Vendor/README.md`
cautions that build metadata shifts the binary digest under a different
toolchain. That turned out not to apply: Truffle published the **existing
materialized artifact** rather than rebuilding it in CI, precisely so the bytes
would not move.

Verified identical to what this lock already pinned:

| Slice     | SHA-256                                                            |
| --------- | ------------------------------------------------------------------ |
| device    | `94796395b2f3aedc6a57fba22f63bbd9bd906d4badec96c6de44fc53929d449e` |
| simulator | `d2bb76de7d7ed225c1e879f225a33d877eac8183b56b93256faff476dc35ac41` |

So the App Store evidence chain carries over untouched — no re-baseline, no new
BOM component digests. The migration is strictly an improvement in provenance:
the same bytes, now fetched from a checksum-verified published artifact instead
of whatever each machine happened to build locally.

The artifact is keyed to the vendored dependency (`tailscalekit-5e89501d`),
not to a Truffle version, so these digests stay stable across Truffle releases
and move only when the libtailscale revision or its patch deliberately changes.

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
