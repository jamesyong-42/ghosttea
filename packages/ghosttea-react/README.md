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

Protocol 1.10 supplies the shared versioned Ghostty configuration snapshot.
The daemon applies scrollback and model colors, while `GhostteaWorkspace`
applies presentation colors, single-stroke keybind mutations, and the opt-in
post-process effect automatically. Lower-level hosts can use
`terminalThemeFromConfig` and `terminalEffectsFromConfig`. See the repository's
[`Ghostty configuration compatibility`](../../docs/ghostty-config-compatibility.md)
matrix for deliberate gaps.

Desktop hosts may provide the exported `GhostteaConfigEditorBridge` through
`GhostteaWorkspacePlatform.configEditor`. The workspace then adds an Advanced
Settings section with a lossless raw overlay editor and a friendly managed
form. The bridge is intentionally capability-shaped: the host owns document
scope, validation, compare-and-swap persistence, and native import/export
dialogs; the React package owns only draft state and presentation.

Architecture:

1. **Match** — `matchGhostteaBinding` (Ghostty defaults + extensions)
2. **Route** — `resolveKeyEvent` → `workspace` | `terminal` | `platform` | `unhandled`
3. **Execute** — Workspace owns chrome/platform/unhandled; TerminalSurface owns terminal effects

**⌘⇧O** (`super+shift+o`) is a Ghosttea product extension (remote sessions) and is kept outside Ghostty defaults.

Open / deferred Ghostty UX work (font-size protocol, search, undo, jump_to_prompt, mouse goldens, etc.) is tracked in the monorepo at [`bench/ghostty-ux/OPEN-ITEMS.md`](../../bench/ghostty-ux/OPEN-ITEMS.md).
