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
