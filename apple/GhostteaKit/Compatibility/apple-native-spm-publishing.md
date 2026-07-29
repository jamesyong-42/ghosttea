# GhostteaKit: local package → consumable Swift package

GhostteaKit becomes resolvable as `.package(url: "https://github.com/vibecook-dev/ghosttea.git")`.
Until now it could only be consumed by relative path, which is why the sibling-pin
class this repository retired in `truffle-spm-migration.md` kept threatening to
come back for anyone who wanted to embed it.

This is done and verified end to end. The artifact is published as
[`ghosttea-apple-native-3883818b918d`][release], and a clean `swift package
resolve` at the repository root downloads it, checksum-verifies it, unpacks it,
and builds against it.

[release]: https://github.com/vibecook-dev/ghosttea/releases/tag/ghosttea-apple-native-3883818b918d

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
.package(url: "https://github.com/vibecook-dev/ghosttea.git", from: "0.6.0"),
.product(name: "GhostteaTerminal", package: "ghosttea"),
```

### Running `swift` against the root manifest needs full Xcode

`swift test` builds every test target, so `GhostteaTerminal`'s Metal build-tool
plugin runs even when the filter selects something else entirely. Under
Command Line Tools that fails with `xcrun: error: unable to find utility
"metal"`, which reads like a package fault and is not one:

```sh
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer swift test
```

The repository's own Apple scripts already export `DEVELOPER_DIR` for this
reason. Only direct invocation against the new root manifest is exposed to it —
set it in the environment, or point `xcode-select` at Xcode.

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

## What was published, and how it was verified

The first artifact was published from the already-composed local bytes rather
than rebuilt in CI — the same call Truffle made, so the digests did not move:

```sh
gh release create ghosttea-apple-native-3883818b918d \
  artifacts/apple-native/GhostteaAppleNative.xcframework.zip \
  artifacts/apple-native/GhostteaAppleNative.xcframework.zip.json \
  --repo vibecook-dev/ghosttea --title ghosttea-apple-native-3883818b918d \
  --latest=false
```

`--latest=false` matters: an artifact release created after the newest product
release would otherwise take the "Latest" badge from it on the repository page.

Verified after publishing, on 2026-07-29:

- The asset downloads from the URL the lock names, and its SHA-256 equals the
  locked checksum.
- `swift package resolve` at the repository root fetches Truffle at its pinned
  revision, downloads this artifact, checksum-verifies it, and unpacks it to
  `.build/artifacts/…/GhostteaAppleNative.xcframework` — which also confirms the
  in-archive rename was required.
- `swift build --target GhostteaCore` compiles against the resolved artifact and
  copies the committed parity fonts into the resource bundle, so both halves of
  this change hold together.

## Publishing a new artifact

Only a change to the native sources moves the digest. When it does:

```sh
npm run package:ghosttea-apple-native   # writes the asset and its .json result
npm run check:apple-native-artifact     # fails: the composed artifact no longer matches the lock
```

Copy `tag`, `url`, `checksum`, `size`, and `contentDigest` from the result into
`apple-native-artifact.lock.json`, update `appleNativeURL` and
`appleNativeChecksum` in the root `Package.swift`, then publish **before**
committing — the digest comes from the working tree, so the ordering always
works out:

```sh
git tag ghosttea-apple-native-<digest12>
git push origin ghosttea-apple-native-<digest12>   # the workflow builds, attests, and publishes
```

The workflow refuses to publish if the tag does not match the packaged content
digest, or if the packaged asset does not match the lock. It carries no
`--clobber`: these bytes are what every consumer's SwiftPM checksum is pinned
to, so a changed artifact takes a new tag rather than replacing an old asset.
