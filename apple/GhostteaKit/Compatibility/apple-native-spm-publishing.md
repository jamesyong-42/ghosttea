# GhostteaKit: local package → consumable Swift package

GhostteaKit becomes resolvable as `.package(url: "https://github.com/vibecook-dev/ghosttea.git")`.
Until now it could only be consumed by relative path, which is why the sibling-pin
class this repository retired in `truffle-spm-migration.md` kept threatening to
come back for anyone who wanted to embed it.

Everything here is applied **except the upload itself**. The lock carries real,
locally verified values and `published: false`; `check-apple-native-artifact.mjs
--release` exits 1 until the asset exists, so nothing can ship against a URL that
does not resolve yet.

## Why a URL dependency could not work

Two independent blockers, either of which is fatal on its own.

| Blocker                                                         | Why it is fatal                                                                                                                                                                                                               |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The manifest lived at `apple/GhostteaKit/Package.swift`         | SwiftPM resolves a URL dependency only against a manifest at the **repository root**. `.package(url:)` cannot name a subdirectory.                                                                                            |
| `Artifacts/*.xcframework/` and the parity fonts were gitignored | `.binaryTarget(path:)` and `.process("Fonts")` both point at paths absent from a clean checkout. `GhostteaCore` depends on both, so this fails at **package-graph load** — every product dies, including the pure-Swift ones. |

That second row is the same failure this repository already diagnosed in Truffle
and wrote down as a prerequisite: _"the artifact is gitignored, so a clean
checkout currently fails at package-graph load for every product, including the
pure-Swift ones."_ GhostteaKit was in exactly that state.

## The fonts are committed now

`GhostteaFonts` is not a test fixture — `GhostteaCore` depends on it — so the
five OFL fonts pinned by `native/fonts.lock.json` are committed rather than
materialized. `npm run check:bundled-fonts` verifies the committed bytes against
the lock and rejects unlocked fonts, so `sync:fonts` remains the updater without
being a prerequisite for building.

Git LFS was rejected: SwiftPM performs a plain clone, so LFS pointers would
resolve as corrupt font files rather than as a missing dependency.

## The artifact tag is content-addressed, and that is load-bearing

The release tag names the artifact's content digest —
`ghosttea-apple-native-<digest12>` — rather than a ghosttea version. This is not
tidiness; a per-release artifact **cannot work**:

> `.binaryTarget(url:checksum:)` requires the checksum to be committed at the tag
> SwiftPM resolves, but release assets are built _after_ the release commit. A
> per-release artifact could therefore never carry a valid checksum at its own tag.

Truffle hit this first and keyed its artifact to the vendored dependency
(`tailscalekit-5e89501d`). GhostteaKit's artifact is built from this repository's
own Rust sources, so it has no external dependency to key to — the content digest
is the generalization. The consequences:

- Swift-only changes never move the artifact, so its URL and checksum stay valid
  across many ghosttea releases.
- A native change produces a new digest, hence a new tag. Publish it **before**
  committing the manifest that references it — the digest is computed from the
  working tree, so the ordering always works out.
- Every ghosttea tag points at bytes that already exist.

## Two manifests, one intended difference

`Package.swift` (root) and `apple/GhostteaKit/Package.swift` are mirrors apart
from how the native artifact is sourced:

|               | root                           | `apple/GhostteaKit/`                     |
| ------------- | ------------------------------ | ---------------------------------------- |
| Binary target | `.binaryTarget(url:checksum:)` | `.binaryTarget(path: "Artifacts/…")`     |
| Serves        | consumers, over the network    | Apple development, against a fresh build |

The local manifest is **not** a shim awaiting deletion. Local work must not have
to publish an artifact before it can compile one, and
`apple/GhostteaApp/GhostteaApp.xcodeproj` references the package by relative path
for that reason. `npm run check:apple-native-artifact` dumps both package graphs
and fails on any divergence other than the binary target's sourcing — including
if either side's sourcing flips.

Note that the dependency identity is `ghosttea` (SwiftPM derives it from the URL),
not `GhostteaKit`:

```swift
.package(url: "https://github.com/vibecook-dev/ghosttea.git", from: "0.5.2"),
.product(name: "GhostteaTerminal", package: "ghosttea"),
```

## The archive

`npm run package:ghosttea-apple-native` writes the zip by hand — sorted entries,
a fixed 1980 timestamp, normalised modes — rather than shelling out to `ditto`.
Two runs over the same tree produce identical bytes.

Two properties are recorded because they answer different questions:

- **`checksum`** — SHA-256 of the archive, which is what
  `swift package compute-checksum` reports and what SwiftPM enforces. Verified
  equal to that tool's output on 2026-07-29.
- **`contentDigest`** — paths, modes, and file bytes only. DEFLATE output is a
  property of zlib rather than of the format, so this is the value a rebuild can
  honestly re-derive elsewhere, and it is what the drift check compares against a
  local build.

The bundle is renamed to `GhostteaAppleNative.xcframework` inside the archive: a
URL binary target makes SwiftPM look for a bundle named after the target and fail
the package graph otherwise. Renaming the top directory is safe because the
xcframework's `Info.plist` addresses its slices by `LibraryIdentifier` and
`LibraryPath`, never by the bundle's own name.

The Apple build is not byte-reproducible across toolchains, so the published
bytes are authoritative — the same stance
`.github/workflows/ghostty-vt-artifact.yml` already takes for the native Windows
build, and the reason its upload step carries no `--clobber`.

## Remaining step

The artifact is packaged and locked but not yet uploaded.

```sh
npm run package:ghosttea-apple-native      # rebuild the asset from the composed artifact
npm run check:apple-native-artifact        # confirm it still matches the lock

git tag ghosttea-apple-native-3883818b918d
git push origin ghosttea-apple-native-3883818b918d   # the workflow builds, attests, and publishes
```

Then set `published: true` in `apple-native-artifact.lock.json` and re-run
`npm run check:apple-native-artifact:release`, which gates on it.

To publish the already-packaged local bytes instead of rebuilding them in CI —
the same call Truffle made, so the digests do not move:

```sh
gh release create ghosttea-apple-native-3883818b918d \
  artifacts/apple-native/GhostteaAppleNative.xcframework.zip \
  artifacts/apple-native/GhostteaAppleNative.xcframework.zip.json \
  --repo vibecook-dev/ghosttea --title ghosttea-apple-native-3883818b918d
```
