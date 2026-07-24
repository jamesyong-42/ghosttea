# Publishing Ghosttea

Ghosttea uses one version across its Rust and npm packages. The private
`ghosttead` binary and `ghosttea-demo` workspace are integration fixtures and
must never be published.

## Package graph

```text
Rust
ghosttea-vt-sys ─> ghosttea-vt ─┐
ghosttea-text ──────────────────┴─> ghosttea
                    └─> ghosttea-truffle (private until its synchronized release)
                         └─> ghosttead (private)

npm
@vibecook/ghosttea-protocol ─┬─> @vibecook/ghosttea
                             └─> @vibecook/ghosttea-client
@vibecook/ghosttea-frame
@vibecook/ghosttea-client ─> @vibecook/ghosttea-electron
@vibecook/ghosttea + frame + protocol ─> @vibecook/ghosttea-react
```

Development and published builds both pin the registry release of
`truffle-core` 0.7.2. A clean checkout must not depend on a sibling source tree.

## Local package verification

```sh
npm run check
npm run package:check
cargo test --workspace
```

`npm run package:check` builds the SDK, downloads and verifies the locked native
artifact when it is not already cached, creates the six npm tarballs, installs
them into a temporary consumer outside the monorepo, imports their public
runtime APIs, and checks the file lists of the publishable Rust crates. It also
packages `ghosttea-vt-sys`, installs that `.crate` into an external Rust
consumer, and builds it using the checksummed release bundle.

To reproduce the deterministic native asset itself rather than consume the
attested release bundle:

```sh
npm run bootstrap:ghostty-vt
npm run build:ghostty-vt
npm run package:ghostty-vt
```

The resulting tarball, checksum metadata, and SPDX 2.3 SBOM are written under
`artifacts/ghostty-vt/`. Packaging fails if they do not match the target record
embedded in `ghosttea-vt-sys/artifacts.json`.

Before each release, verify the leaf Rust crates against crates.io:

```sh
GHOSTTEA_GHOSTTY_VT_BUNDLE="$PWD/artifacts/ghostty-vt/ghostty-vt-f8041e849b36-aarch64-apple-darwin.tar" \
  cargo publish --dry-run --package ghosttea-vt-sys
cargo publish --dry-run --package ghosttea-text
```

For a new synchronized version, `ghosttea-vt` can resolve only after
`ghosttea-vt-sys` exists on crates.io, and `ghosttea` can resolve only after
both safe leaf crates exist. Run each dependent dry-run immediately after its
dependencies are published and before publishing that crate.

The `Ghostty VT artifact` workflow runs on a native Linux arm64 runner, rebuilds
the pinned source in the locked container, checks the deterministic manifest,
attests the bundle and its SPDX SBOM, and creates the matching GitHub
release when the `ghostty-vt-f8041e849b36` tag is pushed. Manual runs only
produce an attested workflow artifact.

## Release order

1. Run `npm run ci:desktop` (including font/FFI parity and sanitizer checks),
   the live Truffle QUIC test, and the same-machine WebGPU performance
   comparison.
2. Update `CHANGELOG.md`, commit the synchronized version, push it, and require
   the desktop release workflow to pass.
3. Push `ghostty-vt-f8041e849b36` only when the pinned native input changed;
   verify its release attestation.
4. Publish `ghosttea-vt-sys` and `ghosttea-text` to crates.io.
5. Dry-run and publish `ghosttea-vt`.
6. Dry-run and publish `ghosttea` after its exact leaf versions resolve.
7. Publish `@vibecook/ghosttea-protocol` and `@vibecook/ghosttea-frame`.
8. Publish `@vibecook/ghosttea` and `@vibecook/ghosttea-client`.
9. Publish `@vibecook/ghosttea-electron`, then `@vibecook/ghosttea-react`.
10. Enable and publish `ghosttea-truffle` with the synchronized Ghosttea version.
    `truffle-core` 0.7.2 is registry-resolvable; the adapter remains private
    until its manifest, package fixture, and release ordering are enabled.

Use npm provenance from trusted CI. Do not publish from a developer machine or
publish the private demo workspaces.

All npm packages configure `publish-npm.yml` as their trusted GitHub publisher.
The workflow contains no registry token: npm exchanges GitHub's short-lived
OIDC identity for publish access and generates provenance automatically. It
verifies the version tag, requires the complete macOS desktop release gate, and
only then publishes all six packages in dependency order.
