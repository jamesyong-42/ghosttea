# `@vibecook/ghosttea-react`

React terminal surface, renderer runtime, and worker-owned WebGPU renderer for
Ghosttea.

The package keeps terminal frames off the React and Electron main-process hot
paths. Create one runtime per renderer window, provide it through
`GhostteaProvider`, and share it across terminal surfaces.

Import `@vibecook/ghosttea-react/styles.css` once in the renderer entrypoint.
