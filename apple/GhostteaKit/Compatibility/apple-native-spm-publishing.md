# GhostteaKit: local package → consumable Swift package

GhostteaKit becomes resolvable as `.package(url: "https://github.com/vibecook-dev/ghosttea.git")`.
Until now it could only be consumed by relative path, which is why the sibling-pin
class this repository retired in `truffle-spm-migration.md` kept threatening to
come back for anyone who wanted to embed it.

This is done and verified end to end. The artifact is published as
[`ghosttea-apple-native-c134a0bb09d6`][release], and a clean `swift package
resolve` at the repository root downloads it, checksum-verifies it, unpacks it,
and builds against it.

The tag moves whenever the native sources do, since it addresses the content:
0.6.2 superseded `ghosttea-apple-native-3883818b918d`, whose bytes predated the
key-encoder and cursor fixes. Both releases stay published — a version that
resolved the older artifact must keep resolving it.

[release]: https://github.com/vibecook-dev/ghosttea/releases/tag/ghosttea-apple-native-c134a0bb09d6

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
.package(url: "https://github.com/vibecook-dev/ghosttea.git", from: "0.6.2"),
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
  property of zlib rather than of the format, so this is the value that can be
  re-derived from a given artifact tree on any machine and with any zip
  implementation — including from the published archive after unpacking it, which
  is how the release check confirms what is actually being served.

  Re-derivable from the same tree, not from a rebuild: a rebuild produces a
  different tree, as measured below.

The bundle is renamed to `GhostteaAppleNative.xcframework` inside the archive: a
URL binary target makes SwiftPM look for a bundle named after the target and fail
the package graph otherwise. Renaming the top directory is safe because the
xcframework's `Info.plist` addresses its slices by `LibraryIdentifier` and
`LibraryPath`, never by the bundle's own name.

Note the scope of that determinism: the **archiver** is reproducible over a given
tree, but the **compose** step that produces the tree is not. Measured during
0.6.2, and stronger than the "across toolchains" caveat originally written here —
recomposing identical sources on one machine with one toolchain moved the archive
by two bytes (78,020,728 → 78,020,730) and changed its content digest.

So the published bytes are authoritative and cannot be re-derived by anyone,
including the machine that produced them — the same stance
`.github/workflows/ghostty-vt-artifact.yml` already takes for the native Windows
build, and the reason its upload step carries no `--clobber`. It is also why the
freshness of an artifact has to be tracked as a property of its _sources_
(`sourceDigest`) rather than by rebuilding and comparing.

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

## Two properties, verified separately

The archive's digests answer **which bytes are published**. They cannot answer
**whether those bytes contain the source being shipped** — a digest taken from a
stale build agrees with a lock written from that same stale build, so the
comparison is circular and passes exactly when it should not.

0.6.2 is the worked example. Its key-encoder and cursor fixes live in
`ghostty_shim.c`, which compiles into every slice. The lock and the local
artifact agreed, both being the previous build, and the release gate's only
artifact assertion was a hand-set `published: true` carried over from 0.6.1. Every
gate was green while GhostteaKit consumers would have received none of the fixes.
It was caught by reasoning about what the shim compiles into, not by a check.

So the lock records both, and each is checked against reality:

| Property  | Field                                 | How it is verified                                                                                                              |
| --------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Integrity | `checksum`, `contentDigest`, `slices` | `--release` fetches the URL, hashes the archive, unpacks it, and re-derives the content and slice digests from the served bytes |
| Freshness | `sourceDigest`                        | recomputed from the working tree on every run, offline                                                                          |

There is no `published` flag. It was a boolean a human set after uploading, and it
is the one claim in these locks that nothing verified.

`scripts/ghosttea-apple-native-artifact.mjs` owns the freshness input set and
documents what it deliberately omits: the packaging and identity scripts stay out,
because a change to how the artifact is archived or digested already surfaces as a
re-derived value disagreeing with the lock. Freshness only has to cover what
re-derivation cannot see.

## Publishing a new artifact

The ordering is forced by the content-addressed tag: the tag is derived from the
bytes, so the bytes exist before the tag, and the tag exists before the commit
that pins it.

```sh
npm run build:ghosttea-core:apple                # or whichever component moved
node scripts/compose-ghosttea-apple-native.mjs
npm run package:ghosttea-apple-native            # writes the asset and its .json result

gh release create ghosttea-apple-native-<digest12> \
  artifacts/apple-native/GhostteaAppleNative.xcframework.zip \
  --repo vibecook-dev/ghosttea \
  --title "GhostteaAppleNative xcframework <digest12>" \
  --latest=false
```

Then copy `tag`, `url`, `checksum`, `size`, `contentDigest`, `sourceDigest`, and
`slices` into `apple-native-artifact.lock.json`, update `appleNativeURL` and
`appleNativeChecksum` in the root `Package.swift`, and open the PR.

`iOS release hardening` triggers on exactly those paths and runs
`check:apple-native-artifact --release`, then resolves and builds `GhostteaCore`
against the published artifact — so the pin is proven before the change merges,
rather than after a release has shipped against it.

Never pass `--clobber`. These bytes are what every consumer's SwiftPM checksum is
pinned to, so a changed artifact takes a new tag rather than replacing an old
asset.

### Why CI does not build it

The workflow used to build the artifact on a tag push and refuse to publish unless
the rebuild reproduced the digest the tag named. That cannot work, for two reasons
that only surfaced when it first ran — during the 0.6.2 release, since every
earlier artifact had been published by hand:

1. **The Apple build is not byte-reproducible.** Measured, not assumed:
   recomposing identical sources on one machine with one toolchain moved the
   archive by two bytes and changed its content digest. A rebuild can never match
   a digest computed elsewhere, so "rebuild and compare" fails by construction.
2. **The tag cannot be an input.** The artifact is published before the lock
   update merges — it has to be, since the lock records the URL — so the tree at
   that tag still names the previous artifact.

Nothing is lost by building locally. SwiftPM verifies the checksum from the
_committed_ manifest before unpacking, so an asset cannot be substituted without
editing a reviewed file — which is the guarantee an attestation over CI-built
bytes would have added. The workflow now audits the published artifact on a
schedule instead, because a deleted or altered release would otherwise surface as
a stranger's failed build.
