# Changelog

All notable changes to Ghosttea are documented here. The Rust and npm packages
share one version.

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
