# Publishing Ghosttea

Ghosttea publishes one shared version across six npm packages and six Rust
crates. The `ghosttead`, `ghosttea-ffi`, and `ghosttea-font-fixture-ffi` Rust
packages and both desktop applications are private integration targets and
must never be published.

Registry versions are immutable. Every release starts from a clean, pushed
commit whose signed `vX.Y.Z` tag matches the root package version.

## Package graph and order

Publish Rust crates in dependency order:

1. `ghosttea-vt-sys`
2. `ghosttea-text`
3. `ghosttea-vt`
4. `ghosttea-core`
5. `ghosttea`
6. `ghosttea-truffle`

Publish npm packages in dependency order:

1. `@vibecook/ghosttea-protocol`
2. `@vibecook/ghosttea-frame`
3. `@vibecook/ghosttea`
4. `@vibecook/ghosttea-client`
5. `@vibecook/ghosttea-electron`
6. `@vibecook/ghosttea-react`

Development and published Rust builds pin the registry release of
`truffle-core` 0.7.2. Every crate sharing an application-owned Truffle node
must resolve the same version and source so its `Node` type is identical.

## Release gate

Run from a clean checkout of the release commit:

```sh
npm ci --ignore-scripts
npm audit --audit-level=high
npm run bootstrap:ghostty-vt:apple
npm run ci:desktop
cargo audit
```

The desktop gate builds and tests every workspace, validates npm and Rust
package archives, builds external consumers exclusively from those archives,
and runs the native lifecycle soak. GitHub separately checks the declared Rust
1.88 minimum and extends the lifecycle soak on its weekly schedule.

Before publishing, perform Cargo's atomic workspace dry-run. This uses Cargo's
temporary registry to verify the unpublished synchronized dependency graph
without uploading anything:

```sh
cargo publish \
  --dry-run \
  --locked \
  --workspace \
  --exclude ghosttead \
  --exclude ghosttea-ffi \
  --exclude ghosttea-font-fixture-ffi
```

Dry-run each npm package with local provenance disabled explicitly. The command
line flag is intentional: it takes precedence over the manifests'
`publishConfig.provenance=true` on every supported npm CLI:

```sh
export npm_config_cache=/private/tmp/ghosttea-npm-release-cache

for release_package in \
  @vibecook/ghosttea-protocol \
  @vibecook/ghosttea-frame \
  @vibecook/ghosttea \
  @vibecook/ghosttea-client \
  @vibecook/ghosttea-electron \
  @vibecook/ghosttea-react
do
  npm publish \
    --dry-run \
    --workspace "$release_package" \
    --access public \
    --provenance=false
done

unset npm_config_cache
```

The Ghostty VT artifact referenced by
`native/terminald/crates/ghostty-vt-sys/artifacts.json` must already exist in
the matching GitHub release. The crate downloads it and verifies its archive,
static library, and public headers before linking. Push a new `ghostty-vt-*`
tag only when this pinned native input changes.

Machine-local WebGPU comparisons and the authenticated live Truffle QUIC test
remain manual pre-release evidence because hosted GPU timing and tailnet
credentials are not stable CI inputs.

## First manual publish

The first release of a package or crate must exist before its trusted
publisher can be configured. Authenticate interactively with npm and
crates.io, then create and push the signed release tag. Never move the tag
after publishing any artifact.

Publish one Rust crate at a time in the order above. Wait for
`cargo info NAME@VERSION` to succeed before publishing its dependents:

```sh
cargo publish --locked --package ghosttea-vt-sys
cargo publish --locked --package ghosttea-text
cargo publish --locked --package ghosttea-vt
cargo publish --locked --package ghosttea-core
cargo publish --locked --package ghosttea
cargo publish --locked --package ghosttea-truffle
```

The npm manifests enable provenance for trusted CI publishing. Disable it only
for the first local publish, which has no CI identity:

```sh
export NPM_CONFIG_PROVENANCE=false
export npm_config_cache=/private/tmp/ghosttea-npm-release-cache

scripts/publish-npm-package-if-missing.sh @vibecook/ghosttea-protocol
scripts/publish-npm-package-if-missing.sh @vibecook/ghosttea-frame
scripts/publish-npm-package-if-missing.sh @vibecook/ghosttea
scripts/publish-npm-package-if-missing.sh @vibecook/ghosttea-client
scripts/publish-npm-package-if-missing.sh @vibecook/ghosttea-electron
scripts/publish-npm-package-if-missing.sh @vibecook/ghosttea-react

unset NPM_CONFIG_PROVENANCE npm_config_cache
```

Verify every exact version from clean external npm and Rust consumers before
creating the GitHub release. Revoke the temporary crates.io token after the
manual release. If an uploaded artifact is defective, deprecate or yank it and
release the next patch version; never try to replace a registry version.

## Trusted publishing

The `Publish release` workflow validates every `v*` tag. Registry mutation is
disabled until the repository variable `OIDC_RELEASE_ENABLED` is exactly
`true`.

After the first manual release:

1. Create a protected GitHub environment named `release`.
2. Configure every npm package and crates.io crate to trust:
   - GitHub owner: `jamesyong-42`
   - Repository: `ghosttea`
   - Workflow: `publish-release.yml`
   - Environment: `release`
3. Allow `npm publish` for each npm trusted publisher. With an authenticated
   npm 12 session, the six npm trust relationships can be created with:

   ```sh
   for release_package in \
     @vibecook/ghosttea-protocol \
     @vibecook/ghosttea-frame \
     @vibecook/ghosttea \
     @vibecook/ghosttea-client \
     @vibecook/ghosttea-electron \
     @vibecook/ghosttea-react
   do
     npm trust github "$release_package" \
       --repository jamesyong-42/ghosttea \
       --file publish-release.yml \
       --environment release \
       --allow-publish \
       --yes
   done
   ```

4. Set the repository variable `OIDC_RELEASE_ENABLED=true`.
5. Revoke obsolete registry automation tokens and configure npm to require
   two-factor authentication while disallowing token publishing.

The release job runs on an Apple Silicon GitHub-hosted runner because the
current verified Ghostty VT artifact targets `aarch64-apple-darwin`. It obtains
a fresh short-lived crates.io token before each Rust upload; npm exchanges the
same job's OIDC identity automatically and generates package provenance.

The publish helpers safely skip an exact version that already exists, making a
workflow rerun resumable after partial registry success. They never overwrite
or replace a published artifact. After an upload succeeds, they wait for the
exact version to become publicly resolvable so ordinary registry propagation
does not produce a false release failure.
