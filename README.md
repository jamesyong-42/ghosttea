# Electron Ghostty Runtime

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

## Run

Requirements: Node 22+, Rust 1.85+, Docker, and a POSIX host for the current
PTY backend. The current native artifact targets Apple Silicon macOS.

```sh
npm install
npm run bootstrap:ghostty-vt
npm run build:ghostty-vt
npm run dev
```

Create a packaged macOS build with the release sidecar bundled under the app's
`Resources/bin` directory:

```sh
npm run dist
```

Code signing and notarization use the standard electron-builder environment
variables when release credentials are available.

Ghostty, Zig, and the build container are pinned in
[`native/ghostty.lock.json`](native/ghostty.lock.json). The build runs Zig in a
minimal Linux container and cross-compiles the static library for macOS, which
avoids coupling the output to the host macOS SDK.

The desktop process starts `terminald` automatically with `cargo run` during
development. Set `TERMINALD_BIN` to use a prebuilt sidecar.
Set `ELECTRON_GHOSTTY_FONT_FAMILY` to select a discovered system font; the
default preference order favors installed programming-ligature monospace fonts
before falling back to the platform monospace family.

## Verify

```sh
npm test
npm run test:integration
npm run check
npm run build
```

This implements the Phase 4 production text-engine vertical slice on macOS.
Phase 5 adds infinite-canvas virtualization, headless/thumbnail/visible states,
and shared GPU memory budgets across many terminal cards.
