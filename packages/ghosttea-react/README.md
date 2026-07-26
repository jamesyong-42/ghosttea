# `@vibecook/ghosttea-react`

React terminal surface, renderer runtime, and worker-owned WebGPU renderer for
Ghosttea.

The package keeps terminal frames off the React and Electron main-process hot
paths. Create one runtime per renderer window, provide it through
`GhostteaProvider`, and share it across terminal surfaces.

Import `@vibecook/ghosttea-react/styles.css` once in the renderer entrypoint.

For applications that want the complete Ghostty-style desktop experience, use
`GhostteaWorkspace` from `@vibecook/ghosttea-react/workspace` and import
`@vibecook/ghosttea-react/workspace.css`. It owns the titlebar, persisted pane
tree, split/focus/resize hotkeys, remote-session palette, and terminal focus
semantics. An optional sidebar component receives the active session plus
`addSession`/`activateSession` actions, so application UI can sit beside the
terminal without creating a parallel terminal layout or transport.

The workspace entry point also exports the versioned, UI-independent pane and
tab reducers used for cross-platform restoration and conformance. Their JSON
documents contain only stable layout IDs and opaque session IDs; resolve those
IDs against live sessions in the host rather than persisting transport or
credential state.

Ghostty-style application shortcuts expose stable `ghosttea.workspace.*`
command IDs through `workspaceCommandId`. These IDs are shared with the Swift
workspace package even where platform-default key bindings eventually differ.

Default macOS keybinds are table-driven from the Ghostty ground-truth dump
(`src/bindings/fixtures/keybinds-macos-default.json`, refreshed via
`npm run extract:ghostty-ux`).

Architecture:

1. **Match** — `matchGhostteaBinding` (Ghostty defaults + extensions)
2. **Route** — `resolveKeyEvent` → `workspace` | `terminal` | `platform` | `unhandled`
3. **Execute** — Workspace owns chrome/platform/unhandled; TerminalSurface owns terminal effects

**⌘⇧O** (`super+shift+o`) is a Ghosttea product extension (remote sessions) and is kept outside Ghostty defaults.

Open / deferred Ghostty UX work (font-size protocol, search, undo, jump_to_prompt, mouse goldens, etc.) is tracked in the monorepo at [`bench/ghostty-ux/OPEN-ITEMS.md`](../../bench/ghostty-ux/OPEN-ITEMS.md).
