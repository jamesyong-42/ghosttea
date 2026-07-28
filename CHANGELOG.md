# Changelog

All notable changes to Ghosttea are documented here. The Rust and npm packages
share one version.

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
