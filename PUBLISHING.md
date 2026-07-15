# Publishing Ghosttea

Ghosttea uses one version across its Rust and npm packages. The private
`ghosttead` binary and `ghosttea-demo` workspace are integration fixtures and
must never be published.

## Package graph

```text
Rust
ghosttea-vt-sys ─> ghosttea-vt ─┐
ghosttea-text ──────────────────┴─> ghosttea
                    └─> ghosttea-truffle (private until truffle-core is published)
                         └─> ghosttead (private)

npm
@vibecook/ghosttea-protocol ─> @vibecook/ghosttea
@vibecook/ghosttea-frame
```

The repository-level `[patch.crates-io]` points development builds at the
sibling Truffle checkout. It is not included in published crate manifests.

## Local package verification

```sh
npm run check
npm run package:check
cargo test --workspace
```

`npm run package:check` builds the SDK, creates the three npm tarballs, installs
them into a temporary consumer outside the monorepo, imports their public
runtime APIs, and checks the file lists of the publishable Rust crates. It also
packages `ghosttea-vt-sys`, installs that `.crate` into an external Rust
consumer, and builds it using the checksummed local release bundle.

Build the deterministic native asset before package verification:

```sh
npm run bootstrap:ghostty-vt
npm run build:ghostty-vt
npm run package:ghostty-vt
```

The resulting tarball, checksum metadata, and SPDX 2.3 SBOM are written under
`artifacts/ghostty-vt/`. Packaging fails if they do not match the target record
embedded in `ghosttea-vt-sys/artifacts.json`.

Before the first release, verify the leaf Rust crates against crates.io:

```sh
GHOSTTEA_GHOSTTY_VT_BUNDLE="$PWD/artifacts/ghostty-vt/ghostty-vt-f8041e849b36-aarch64-apple-darwin.tar" \
  cargo publish --dry-run --package ghosttea-vt-sys
cargo publish --dry-run --package ghosttea-text
```

For the first release, `ghosttea-vt` can resolve only after
`ghosttea-vt-sys` exists on crates.io, and `ghosttea` can resolve only after
both safe leaf crates exist. Run each dependent dry-run immediately after its
dependencies are published and before publishing that crate.

The `Ghostty VT artifact` workflow runs on a native Linux arm64 runner, rebuilds
the pinned source in the locked container, checks the deterministic manifest,
attests the bundle and its SPDX SBOM, and creates the matching GitHub
release when the `ghostty-vt-f8041e849b36` tag is pushed. Manual runs only
produce an attested workflow artifact.

## Release order

1. Push `ghostty-vt-f8041e849b36` and verify the release attestation.
2. Publish `ghosttea-vt-sys` and `ghosttea-text` to crates.io.
3. Dry-run and publish `ghosttea-vt`.
4. Dry-run and publish `ghosttea` after its exact leaf versions resolve.
5. Publish `@vibecook/ghosttea-protocol` and `@vibecook/ghosttea-frame`.
6. Publish `@vibecook/ghosttea`.
7. Enable and publish `ghosttea-truffle` only after `truffle-core` is available
   from the selected Cargo registry.

Use npm provenance from trusted CI. Do not publish from a developer machine or
publish the private demo workspaces.

For the first npm release, add a granular `NPM_TOKEN` repository secret with
permission to publish public packages in the `@vibecook` scope, then dispatch
`publish-npm.yml` at the version tag. The workflow verifies the tag, builds and
tests all three packages, and publishes them with provenance in dependency
order.

After the package names exist, configure `publish-npm.yml` as the trusted
GitHub publisher for each package, remove `NPM_TOKEN`, and keep subsequent
publishes token-free through npm's OIDC exchange.
