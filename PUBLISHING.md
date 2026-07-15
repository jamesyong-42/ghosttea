# Publishing Ghosttea

Ghosttea uses one version across its Rust and npm packages. The private
`ghosttead` binary and `ghosttea-demo` workspace are integration fixtures and
must never be published.

## Package graph

```text
Rust
ghosttea-text ─┐
ghosttea-vt ───┴─> ghosttea
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
runtime APIs, and checks the file lists of the publishable Rust crates.

Before the first release, verify the leaf Rust crates against crates.io:

```sh
cargo publish --dry-run --no-verify --package ghosttea-text
cargo publish --dry-run --no-verify --package ghosttea-vt
```

The `--no-verify` flag is temporary for `ghosttea-vt`: its verification build
cannot run from an isolated crate archive until the native Ghostty artifact
download pipeline exists. The top-level `ghosttea` dry-run can resolve its
exact internal dependencies only after the two leaf versions are published.

## Release order

1. Publish `ghosttea-text` and `ghosttea-vt` to crates.io.
2. Run and publish `ghosttea` after its exact leaf versions resolve.
3. Publish `@vibecook/ghosttea-protocol` and `@vibecook/ghosttea-frame`.
4. Publish `@vibecook/ghosttea`.
5. Enable and publish `ghosttea-truffle` only after `truffle-core` is available
   from the selected Cargo registry.

Use npm provenance from trusted CI. Do not publish from a developer machine or
publish the private demo workspaces.
