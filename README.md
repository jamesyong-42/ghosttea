# Ghosttea

Ghosttea is a native Ghostty-powered terminal runtime and desktop experience
for Electron applications.

An implementation of the terminal runtime described in
[`draft/architecture-design.md`](draft/architecture-design.md).

The current vertical slice includes:

- a persistent Rust sidecar with PTY-backed sessions;
- independent authenticated control and frame Unix sockets;
- a pinned `libghostty-vt` terminal core with title, cwd, bell, damage,
  scrollback, reflow, and terminal-aware key encoding;
- revisioned full-viewport row-replacement frames with cursor state;
- an Electron utility-process bridge with transferable buffers;
- an isolated preload API;
- a worker-owned WebGPU renderer with rectangle and glyph pipelines;
- a native text engine with system-font discovery, HarfBuzz shaping, fallback,
  2× native rasterization, ligatures, combining marks, and styled face selection;
- persistent worker-owned monochrome and color GPU glyph atlases, with the
  Canvas2D rasterizer retained only as a diagnostic compatibility path;
- atomic row-replacement frames, cursor and selection primitives, live themes,
  device-loss recovery, and a diagnostic Canvas2D fallback;
- strict TypeScript frame decoding and protocol tests.
- view-aware input and resize authority shared by local and remote views;
- main-process automation ordered against accepted human input without taking
  renderer view or layout authority;
- explicit inherited or clean session environments, rich exit metadata, and
  process-group termination escalation;
- terminal host discovery and logical-state mirroring over Truffle 0.7.6 QUIC.

## Run

Requirements: Node 22+, Rust 1.88+, Docker, and a POSIX host for the current
PTY backend. The current native artifact targets Apple Silicon macOS.

```sh
npm install
npm run bootstrap:ghostty-vt
npm run build:ghostty-vt
npm run package:ghostty-vt
npm run dev
```

Create a packaged macOS build with the release terminal service under the
app's `Resources/bin` directory:

```sh
npm run dist
```

Code signing and notarization use the standard electron-builder environment
variables when release credentials are available.

Ghostty, Zig, and the build container are pinned in
[`native/ghostty.lock.json`](native/ghostty.lock.json). The build runs Zig in a
minimal Linux container and cross-compiles the static library for macOS, which
avoids coupling the output to the host macOS SDK.

`ghosttea-vt-sys` owns native artifact resolution. Repository builds use the
local pinned output; packaged consumers download the target bundle from its
locked release URL and verify SHA-256 checksums before compiling or linking.
Set `GHOSTTY_VT_PREFIX` for an unpacked artifact,
`GHOSTTEA_GHOSTTY_VT_BUNDLE` for a local release bundle, or
`GHOSTTEA_GHOSTTY_VT_OFFLINE=1` to prohibit download fallback. The deterministic
bundle contains Ghostty's license, build inputs, and an SPDX 2.3 SBOM.

The desktop process starts `ghosttead` automatically with `cargo run` during
development. Set `GHOSTTEAD_BIN` to use a prebuilt service executable;
`TERMINALD_BIN` remains available as a compatibility alias.
Set `GHOSTTEA_FONT_FAMILY` to select a discovered system font; the
default preference order favors installed programming-ligature monospace fonts
before falling back to the platform monospace family.

## Embed in Electron

Ghosttea's application integration is split into reusable packages:

- `@vibecook/ghosttea-client` is the Electron-free Node control-socket client
  for session lifecycle and epoch-guarded automation;
- `@vibecook/ghosttea-electron` owns daemon supervision, the utility-process
  socket bridge, transferred renderer ports, and isolated-preload helpers;
- `@vibecook/ghosttea-react` owns the shared renderer runtime, terminal surface,
  render worker, and WebGPU/Canvas renderers.

The private desktop demo consumes both packages and remains the visual and
behavioral reference application. Terminal frames still travel directly from
the utility process to the renderer and then to the render worker; Electron
main and React do not process frame payloads.

The Electron package supports two Rust-service ownership modes. In managed
mode it starts a configured `ghosttead` or application service executable. In
external mode the host application starts its own Rust composition service and
passes an authenticated `TerminalDaemonConnection` to
`GhostteaElectronBackend`. This allows one application-owned Rust process to
share a single Truffle node across Ghosttea and other services.

Rust hosts can also supply pre-bound control and frame listeners, private
environment prefixes, a text engine, and a terminal mesh directly to
`TerminalService`. Listener ownership, cancellation behavior, stable external
connection requirements, and shared-Truffle rules are documented in the
[`ghosttea` crate embedding guide](native/terminald/README.md#embedded-service-mode).

Application automation uses the backend's control-only client. It does not
open the frame socket, attach a renderer view, or participate in focus and
resize authority. Each operation is committed by `ghosttead` only if no human
input has been accepted since the application observed the session's input
epoch. Paste-and-submit is one atomic PTY operation, so the command and Return
cannot be interleaved with user input.

Session creation requires an explicit environment policy for isolated agent
processes: use `{ mode: "clean", variables }` for a curated environment or
`{ mode: "inherit", overrides }` for an ordinary shell. In inherited mode,
Ghosttea removes its private service and transport credentials before spawning
the child. Session summaries and exit events include PID, creation time, exit
code or signal, requested termination source, and classified exit outcome.

For development, the demo can attach to an already-running service with
`GHOSTTEA_EXTERNAL_CONTROL_SOCKET`, `GHOSTTEA_EXTERNAL_FRAME_SOCKET`, and
`GHOSTTEA_EXTERNAL_AUTH_TOKEN`.

## Terminal mirroring

The current dependency pins the registry release of Truffle 0.7.6 so clean
checkouts and published consumers resolve the same transport implementation.
Put `TRUFFLE_TEST_AUTHKEY` in an untracked `.env` to enable the Truffle node
during development, or set
`GHOSTTEA_TRUFFLE_ENABLED=false` to keep the runtime local-only.

The reusable `ghosttea` crate is transport-neutral and does not depend on
Truffle. The separate `ghosttea-truffle` adapter depends on `truffle-core` and
accepts a host-owned `Arc<Node<TailscaleProvider>>`; it neither creates nor
stops that node and does not package Truffle. The Electron demo resolves the
sibling development sidecar and its thin `ghosttead` binary acts as the
application composition root. A consuming application owns Truffle
installation, identity, state, and lifecycle once for all of its Rust services.

Remote peers are read-only by default. Set `GHOSTTEA_TRUFFLE_CAPABILITY` to
require a shared write capability, or explicitly set
`GHOSTTEA_TRUFFLE_ALLOW_WRITE=true` to grant write access to every same-app
peer on the tailnet. The demo app ID, terminal service scope, and QUIC port
default to `ghosttea-terminal`, `terminal.v1`, and `9420`.

### Embedding in a Rust application service

Create one Truffle node in the host service and pass a clone of the same
`Arc` to the terminal adapter and to other application services:

```rust,ignore
let truffle = Arc::new(build_application_truffle_node().await?);
let app_sync = AppSyncService::new(Arc::clone(&truffle));
let terminal_mesh = TruffleTerminalMesh::new(
    Arc::clone(&truffle),
    TruffleTerminalConfig {
        service_name: "terminal.v1".into(),
        quic_port: 9420,
        ..Default::default()
    },
)?;

TerminalService::new(local_terminal_config)
    .with_terminal_mesh(terminal_mesh)
    .run()
    .await?;
```

Cargo deduplicates the `truffle-core` code, while passing the same `Arc` is
what shares the live node, peer registry, identity, and sidecar process. Give
each application feature its own service namespace and QUIC port. Never open
the same Truffle state directory from two processes.

Press <kbd>⌘</kbd><kbd>⇧</kbd><kbd>O</kbd> to open the remote-session palette.
Choose an advertised session with the arrow keys and Return; it opens as a new
pane using the same renderer, focus, and resize behavior as a local terminal.

### Two-peer development

Build once and launch two durable desktop profiles from one terminal:

```sh
npm run dev:peers -- alpha beta
```

This build-once launcher intentionally avoids running two `electron-vite`
watchers against the same output directory. For normal HMR development of one
named profile, use `npm run dev:peer -- alpha` instead.

Each profile has isolated Electron data, Truffle state, and network identity
under the Ghosttea application-data directory. Profile names are stable across
restarts, so the same `alpha` and `beta` devices are reused instead of enrolling
new tailnet devices. Only one process may use a given profile at a time.
Launching the same profile again activates its existing window instead of
creating a competing runtime.

The launcher sets `GHOSTTEA_PROFILE`; it can also be set directly for
automation. Both peers keep the same Truffle app ID so they discover each
other. To test typing and resize authority, enable a write policy in `.env` as
described above; otherwise remote panes intentionally attach view-only.

The network protocol sends logical terminal rows and typed terminal input; it
does not send local glyph atlases, WebGPU display lists, or raw renderer
frames. See [`draft/terminal-tunneling.md`](draft/terminal-tunneling.md) for
the protocol and authority model. Session liveness, shell-idle/foreground-job
semantics, delivery, and compatibility are documented in
[`docs/session-activity.md`](docs/session-activity.md).

## Verify

```sh
npm test
npm run test:integration
npm run check
npm run build

# opt-in live Truffle 0.7.6 QUIC smoke test (reads .env)
cargo test --package ghosttea-truffle \
  latest_truffle_quic_round_trip -- --ignored
```

The live test needs `TRUFFLE_SIDECAR_PATH` in `.env` as well as
`TRUFFLE_TEST_AUTHKEY`. `ghosttea-truffle` depends on `truffle-core`, which
does not carry the build-time sidecar downloader, so supply the binary
explicitly. Download the `tsnet-sidecar-<platform>` asset from the matching
`truffle-vX.Y.Z` release, verify it against the pinned checksum in that
version's `crates/truffle-sidecar/sidecar-checksums.json`, then point
`TRUFFLE_SIDECAR_PATH` at the executable. Release assets are built after the
release commit, so a version's checksums appear in the commit that follows its
tag rather than at the tag itself. The test enrolls two ephemeral, randomly
named Tailscale devices under the `ghosttea-test` app ID and stops both on
completion.

## Benchmark

Compare the `ghosttead` sidecar path against a classic `node-pty` + xterm.js
baseline (and manually against native Ghostty with the same payloads):

```sh
cargo build --release --package ghosttead
npm run bench
# or: npm run bench:json
```

See [`bench/README.md`](bench/README.md) for methodology and interpretation.

Packaging boundaries, dry-run checks, and release order are documented in
[`PUBLISHING.md`](PUBLISHING.md).

This implements the Phase 4 production text-engine vertical slice on macOS.
Phase 5 adds infinite-canvas virtualization, headless/thumbnail/visible states,
and shared GPU memory budgets across many terminal cards.

## Release qualification

`npm run ci:desktop` is the local equivalent of the required desktop release
gate. It runs formatting, lint, TypeScript checks, JavaScript and Rust tests,
strict Clippy, C ABI/font parity and sanitizer checks, the daemon integration
smoke, benchmark-harness tests, external package-consumer checks, and a
release-daemon lifecycle soak. The soak creates, attaches, subscribes to,
naturally exits, and forgets at least 256 sessions, then requires daemon thread
count and RSS to return within fixed guardrails.

GitHub also checks the declared Rust 1.88 minimum and audits npm and Rust
dependencies. The scheduled desktop workflow extends the lifecycle soak to
4,096 sessions. Machine-local WebGPU comparisons remain a pre-release evidence
step because GitHub-hosted GPU timing is not a stable performance baseline.
