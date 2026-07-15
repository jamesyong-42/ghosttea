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
- terminal host discovery and logical-state mirroring over Truffle 0.7.1 QUIC.

## Run

Requirements: Node 22+, Rust 1.85+, Docker, and a POSIX host for the current
PTY backend. The current native artifact targets Apple Silicon macOS.

```sh
npm install
npm run bootstrap:ghostty-vt
npm run build:ghostty-vt
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

The desktop process starts `ghosttead` automatically with `cargo run` during
development. Set `GHOSTTEAD_BIN` to use a prebuilt service executable;
`TERMINALD_BIN` remains available as a compatibility alias.
Set `GHOSTTEA_FONT_FAMILY` to select a discovered system font; the
default preference order favors installed programming-ligature monospace fonts
before falling back to the platform monospace family.

## Terminal mirroring

The current development dependency targets Truffle 0.7.1 from the sibling
checkout at `../p008/truffle`. Put `TRUFFLE_TEST_AUTHKEY` in an untracked
`.env` to enable the Truffle node during development, or set
`GHOSTTEA_TRUFFLE_ENABLED=false` to keep the runtime local-only.

The reusable terminal crate depends on `truffle-core`, not the convenience
crate that provisions `sidecar-slim`. It accepts a host-owned
`Arc<Node<TailscaleProvider>>`; it neither creates nor stops that node and does
not package Truffle. The Electron demo resolves the sibling development
sidecar and its thin `ghosttead` binary acts as the application composition
root. A consuming application owns Truffle installation, identity, state, and
lifecycle once for all of its Rust services.

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
    .with_truffle_mesh(terminal_mesh)
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
the protocol and authority model.

## Verify

```sh
npm test
npm run test:integration
npm run check
npm run build

# opt-in live Truffle 0.7.1 QUIC smoke test (reads .env)
cargo test --manifest-path native/terminald/Cargo.toml \
  mesh::tests::latest_truffle_quic_round_trip -- --ignored
```

## Benchmark

Compare the `ghosttead` sidecar path against a classic `node-pty` + xterm.js
baseline (and manually against native Ghostty with the same payloads):

```sh
cargo build --release --manifest-path native/terminald/Cargo.toml
npm run bench
# or: npm run bench:json
```

See [`bench/README.md`](bench/README.md) for methodology and interpretation.

This implements the Phase 4 production text-engine vertical slice on macOS.
Phase 5 adds infinite-canvas virtualization, headless/thumbnail/visible states,
and shared GPU memory budgets across many terminal cards.
