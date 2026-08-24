# Ghosttea Pipeline Lab

An isolated Electron app that races compositor topologies for terminal panes. It does **not** speak to `ghosttead`. The grid is synthetic so a difference in the log is a difference in the Electron/WebGPU end, not in VT or shaping.

```bash
npm install
npm run dev:pipeline-lab
```

## Why this exists

The production path already decodes TRF1 once per session. What it still duplicates is the thing after that: scene passes, swapchains, and Chromium canvas layers. This lab holds the paint cost constant and changes only that topology.

## Candidates

| Gate     | Topology                                                     | Hypothesis                                            |
| -------- | ------------------------------------------------------------ | ----------------------------------------------------- |
| PER-VIEW | One scene texture and one WebGPU canvas per view             | Control. Today’s product. Costs scale with views.     |
| SHARED   | One scene per session, blit/letterbox to N canvases          | The product bet for deck + stage + ICE + thumbnails.  |
| WINDOW   | One stage canvas; worker composites every view rect          | Wins if N swapchains / compositor layers are the tax. |
| BITMAP   | Authority stays WebGPU; mirrors take `ImageBitmap` snapshots | Viable only for cold or tiny thumbnails.              |

Toggles that matter:

- **Scene size** — `view` / `authority` / `grid-native`. Shared + grid-native is the “one scene, N views” design.
- **Effects** — off, on the scene once, or on every view (the remaining full-pane sample).
- **GPUDevice per view** — negative control. Only legal on PER-VIEW.

## Recipes

1. **Mirror tax** — 1 session × 8 views, flood. SHARED should drop `scene` from 8 to 1. If `present` stays 8 and CPU barely moves, the swapchain is the leftover cost.
2. **Deck of strangers** — 8 sessions × 1 view. SHARED cannot help. WINDOW should drop `present` to 1.
3. **Stage + tiles** — the product shape, sparse typing.
4. **Present tax** — 16 thumbnails, `repaint` (present every vsync, no content change).
5. **Effect scope** — CRT on the scene vs per view.
6. **Device tax** — should lose.

Arm records 2.5 s after a 700 ms warmup. Compare `scene`, `present`, `submit`, render CPU p95, upload, bitmap copies, RSS. Do not crown a winner from one run.

## What this will not tell you

- Typing latency through the real TRF1 / native text engine path (`bench/render` already owns that).
- Whether CSS rounded corners on a DOM canvas are worth a second swapchain. WINDOW gives that up on purpose.
