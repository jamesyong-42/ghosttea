![Ghosttea — Build terminal experiences, not terminal emulators.](docs/og.png)

<div align="center">

# Ghosttea

### Build terminal experiences, not terminal emulators.

A Ghostty-powered terminal runtime for Electron and native Apple apps.
Local PTYs, GPU rendering, typed automation, and secure session sharing—one embeddable stack.

[Website](https://vibecook-dev.github.io/ghosttea/) ·
[API guide](https://vibecook-dev.github.io/ghosttea/api.html) ·
[npm](https://www.npmjs.com/org/vibecook) ·
[crates.io](https://crates.io/search?q=ghosttea)

[![Desktop release gates](https://github.com/vibecook-dev/ghosttea/actions/workflows/desktop-release-gates.yml/badge.svg)](https://github.com/vibecook-dev/ghosttea/actions/workflows/desktop-release-gates.yml)
[![npm](https://img.shields.io/npm/v/%40vibecook%2Fghosttea?label=npm&color=b6f36b)](https://www.npmjs.com/package/@vibecook/ghosttea)
[![MIT](https://img.shields.io/github/license/vibecook-dev/ghosttea?color=ff9e64)](LICENSE)

</div>

## Why Ghosttea?

- **Feels native.** Ghostty terminal semantics, native text shaping, and WebGPU or Metal rendering.
- **Built for apps.** Typed lifecycle APIs, sandboxed Electron transport, and human-safe automation.
- **Goes where your work goes.** Run local PTYs, connect over SSH, or share live sessions across devices.

Ghosttea is infrastructure for IDEs, AI coding tools, workbenches, and terminal-first products. You own the interface; Ghosttea owns the hard terminal machinery.

## Try the desktop demo

```bash
git clone https://github.com/vibecook-dev/ghosttea.git
cd ghosttea
npm install
npm run fetch:ghostty-vt
npm run dev
```

Requires Node 22+ and Rust 1.88+. Locked native artifacts are available for Apple Silicon macOS and x64 Windows.

## Embed it

```bash
npm install @vibecook/ghosttea-electron @vibecook/ghosttea-react
```

Choose the layer that fits your product:

| You need                         | Start with                           |
| -------------------------------- | ------------------------------------ |
| A complete terminal workspace    | `@vibecook/ghosttea-react/workspace` |
| Terminal surfaces in your own UI | `@vibecook/ghosttea-react`           |
| Electron lifecycle and transport | `@vibecook/ghosttea-electron`        |
| Headless Node automation         | `@vibecook/ghosttea-client`          |
| A native Rust host               | `ghosttea` + `ghosttea-core`         |

See the [API guide](https://vibecook-dev.github.io/ghosttea/api.html) for the shortest path from install to first terminal.

## One runtime, two paths

```text
Local   app → Ghosttea → PTY → Ghostty VT → WebGPU / Metal
Remote  app → Ghosttea → logical session sync → local GPU renderer
```

Frames skip Electron main and React state. Remote sessions send logical terminal state—not screenshots—so every device renders locally and stays sharp.

## What ships today

- Release-gated Electron desktop support on Apple Silicon macOS and x64 Windows.
- Published npm packages and Rust crates with one synchronized version.
- React workspace, split panes, native tabs, themes, selection, clipboard, and Ghostty-style input.
- Ordered automation that yields safely when a human starts typing.
- Read-only-by-default session sharing through Truffle and Tailscale.
- A native iOS 18.1+ app stack with SSH, Metal rendering, workspaces, and shared sessions.

> **iOS status:** the production app target is implemented and device-tested, but external release qualification is still in progress. See the [release-hardening record](apple/GhostteaKit/Compatibility/release-hardening.md).

## Develop

```bash
npm test
npm run check:desktop
```

Performance work is evidence-driven. The repository includes repeatable native, Electron/WebGPU, Truffle, and physical-device benchmark harnesses.

## Project

- [Documentation](https://vibecook-dev.github.io/ghosttea/)
- [Questions and bug reports](https://github.com/vibecook-dev/ghosttea/issues)
- [Publishing and package graph](PUBLISHING.md)
- [Ghostty UX coverage](bench/ghostty-ux/README.md)
- [Changelog](CHANGELOG.md)

MIT © 2026 James Yong. Ghosttea is an independent project built on Ghostty's terminal core.
