# Changelog

All notable changes to Ghosttea are documented here. The Rust and npm packages
share one version.

## 0.6.1 - 2026-07-29

### Fixed

- GhostteaKit can be consumed by version. 0.6.0 pinned Truffle by bare Git
  revision, and SwiftPM forbids a version-resolved package from depending on a
  revision-pinned one, so every `from:`/`exact:` consumer — including the usage
  example 0.6.0 shipped — failed to resolve:

  ```
  package 'ghosttea' is required using a stable-version but 'ghosttea'
  depends on an unstable-version package 'truffle'
  ```

  Only `revision:` consumers worked. The pin is now
  `.package(url:exact:"0.7.11")`, which resolves the same commit through
  Truffle's plain `v0.7.11` tag, so the build is byte-for-byte what 0.6.0
  resolved — the artifact digests and release BOM are unchanged. `exact:` rather
  than `from:` keeps Truffle's lockstep discipline.

  Nothing caught this before release because both surfaces that were exercised
  are exempt from the rule: `apple/GhostteaApp` consumes the package by relative
  path, and resolving the repository _as the root package_ is not a
  consumed-by-version resolution. The App Store readiness gate now asserts the
  resolved pin carries a version, so reverting to a revision pin fails the
  release instead of silently breaking semver consumption again.

## 0.6.0 - 2026-07-29

### Changed

- **Breaking for Rust consumers.** `ghosttea-truffle` now pins
  `truffle-core = "=0.7.11"`, up from `=0.7.8`. The pin is exact by design —
  every crate sharing an application-owned Truffle node must resolve the same
  version and source so its `Node` type is identical — so a consumer still
  pinned to `=0.7.8` cannot resolve alongside this release and must move too.
  That is a loud resolver error rather than a silent type mismatch, which is
  what the exact pin is for. The Swift package follows the same revision.

  0.7.9 adds transport-derived caller identity (`whois(addr)`, node serve
  headers, QUIC accept identity). 0.7.10 replaces value-correlated sidecar RPC
  waiters with a reply broker keyed on request id, fixing an event burst that
  could surface a misleading timeout, two concurrent port-0 listens stealing
  each other's confirmations, and a synchronous failure burning a full 10s
  timeout. The QUIC peer handshake is unchanged between these releases, so this
  does not move the wire between an already-attached phone and desktop.

### Added

- GhostteaKit resolves as a SwiftPM URL dependency. It could previously only be
  consumed by relative path, because its manifest lived in a subdirectory and
  both the native XCFramework and the parity fonts were gitignored — and since
  `GhostteaCore` depends on both, a clean checkout failed at package-graph load
  for every product, including the pure-Swift ones. A root `Package.swift` now
  sources the XCFramework from a checksum-verified release asset, and the fonts
  ship in the tree.

  ```swift
  .package(url: "https://github.com/vibecook-dev/ghosttea.git", from: "0.6.0"),
  .product(name: "GhostteaTerminal", package: "ghosttea"),
  ```

  The dependency identity is `ghosttea`, which SwiftPM derives from the URL.
  The artifact is published under a content-addressed tag rather than a release
  version, because `.binaryTarget(url:checksum:)` needs a checksum already valid
  at the commit SwiftPM resolves and release assets are built after their
  release commit; only a change to the native sources moves it.

## 0.5.2 - 2026-07-28

### Fixed

- `@vibecook/ghosttead` works when a bundler inlines it. The resolver's
  direct `node_modules` walk runs from wherever the code actually sits, so a
  bundle under pnpm's layout found no platform package — and the failure was
  misreported as a pruned optional dependency. Resolution now recovers by
  locating the installed `@vibecook/ghosttead` from the bundle's own
  position and resolving the platform package from that directory's real
  path; only when the package itself is unreachable does it fail, naming
  bundling as the cause and `external` and `GHOSTTEAD_BIN` as the ways out.
- `@vibecook/ghosttead` and `@vibecook/ghosttea-native-tabs` can be
  `require()`d. Both packages exported only an `import` condition, so a
  CommonJS Electron main bundle could not consume them even when marked
  external. Their exports now carry a `require` condition for the same ESM
  module, which Node 22.12+ loads natively.

## 0.5.1 - 2026-07-28

### Fixed

- The prebuilt `ghosttead` daemon links harfbuzz statically. 0.5.0's macOS
  binary linked `/opt/homebrew/opt/harfbuzz/lib/libharfbuzz.0.dylib` and
  aborted in dyld on any machine without that formula, which is every machine
  0.5.0 promised would need neither this repository nor a toolchain. The cause
  was `harfbuzz-sys` probing pkg-config unless `HARFBUZZ_SYS_NO_PKG_CONFIG` is
  set: the release runner carries harfbuzz, so it linked against a prefix only
  the builder has, while a developer machine without the formula falls through
  and links the vendored source. The release now sets that variable on both
  platforms, so what ships no longer depends on what the runner happens to
  have installed.
- The release asserts that the daemon links nothing outside `/System` and
  `/usr/lib` before publishing it. Running the daemon on the runner that built
  it cannot catch a missing library that the runner itself supplies, so this
  gate checks the linkage instead — for every dependency, not only harfbuzz.

## 0.5.0 - 2026-07-27

### Added

- The `ghosttead` daemon ships prebuilt on npm. `@vibecook/ghosttead` resolves
  the binary for the current platform from `@vibecook/ghosttead-darwin-arm64`
  or `@vibecook/ghosttead-win32-x64`, honors the `GHOSTTEAD_BIN` override, and
  fails closed with the reason when it cannot resolve. Desktop consumers no
  longer need this repository checked out beside them, or a Rust toolchain.
- The macOS native window-tab ordering addon ships prebuilt as
  `@vibecook/ghosttea-native-tabs`, one universal (arm64 + x86_64) N-API
  binary that loads in every Node and Electron. Off macOS its exports return
  null, which is the contract consumers already code to.
- `ghosttead --version` prints the release the binary came from — its first
  and only argument; configuration stays entirely in the environment.
- A post-publish smoke workflow installs the published version from the
  registry on macOS, Windows, and Linux, runs the daemon, and loads the
  addon, so a release is verified as consumers receive it, not only as CI
  built it.

## 0.4.0 - 2026-07-25

### Added

- Support Windows as a desktop target. The pinned Ghostty VT core is now built
  and published for `x86_64-pc-windows-msvc`, and the same release gate runs on
  a Windows runner.

### Changed

- **Breaking.** `TerminalServiceListeners::new` takes `ipc::Listener` values
  instead of `tokio::net::UnixListener`. Windows has no filesystem socket that
  a client can dial, so the control and frame channels are named pipes there
  and the listener type had to stop naming one platform's transport. On Unix
  `ipc::Listener` converts from a `UnixListener` through `From`, so a host that
  binds its own socket adds `.into()`.
- A host supplying its own listeners now calls `ipc::remove_stale_endpoint`
  before binding, which is what `TerminalService::bind` has always done on its
  behalf. Only Unix has anything to remove; skipping it left a restarting
  embedder binding onto its own stale socket.

### Fixed

- Windows sessions report their exit. ConPTY holds its output pipe open until
  the pseudoconsole closes, so no session ever left the registry or delivered an
  exit code.
- Terminating a session reaches everything it started rather than only the
  process the PTY spawned.

## 0.3.0 - 2026-07-24

### Changed

- Pin the registry release of Truffle 0.7.6, replacing 0.7.2. Applications
  sharing an application-owned Truffle node must resolve the same version.
  The upgrade carries the Apple mesh runtime, accepted-peer identity, and
  listener-teardown fixes from 0.7.3 through 0.7.6, and introduces no
  breaking API changes.
- Advance the Swift package lock to the `truffle-v0.7.6` tag. Every
  hash-locked input—the TailscaleKit privacy manifest, libtailscale patch,
  materializer contracts, and pinned libtailscale revision—is byte-identical
  to the previous lock.

## 0.2.0 - 2026-07-23

### Added

- Separate Node, Electron, and React integration packages.
- Mounted-or-pinned frame subscriptions with explicit renderer-side session
  unregistration.
- Negotiated renderer/worker frame credits, targeted gap recovery, and bounded
  resynchronization concurrency.
- Catalog generations and bounded renderer glyph/style retention.
- Native and renderer lifecycle churn coverage, including process RSS and thread
  guardrails.
- Always-on desktop release, minimum-Rust, packaging, and dependency-audit CI
  gates.

### Fixed

- Release all per-session input and activity actors after natural PTY exit.
- Bound closed-owner and frame-gap lifecycle archives without steady-state
  allocation.
- Prevent inactive sessions from continuing to receive and decode terminal
  frames.
- Cap performance-measurement samples and retained CPU glyph pixels.

### Performance

- Preserve frame bytes through native fanout with shared ownership.
- Coalesce transport pressure behind byte credits without regressing the
  established native benchmark threshold.

## 0.1.0

- Initial Ghosttea protocol, frame decoder, browser client, Rust terminal
  service, and pinned Ghostty VT artifact.
