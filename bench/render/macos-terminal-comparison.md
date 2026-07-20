# macOS terminal comparison smoke run

Date: 2026-07-19

Machine: Apple M1 Max, macOS Darwin 25.5.0

Workload: `doom-fire-1`, seed `218165742`

This is a preliminary single-sample comparison, not optimization evidence. It
exists to validate the external workload and identify what a fair cross-product
benchmark still needs.

## Matched workload

- 120 columns by 40 rows, with 39 rows of half-block fire cells;
- 180 independently generated truecolor frames;
- one frame written every 16 ms, for 2.88 seconds nominal duration;
- 20,120,303 payload bytes in the same frame boundaries for every terminal.

The native terminals ran the workload through
`external-terminal-workload.mjs`. Ghosttea ran the equivalent built-in payload
through its real PTY, terminald, TRF1 bridge, render worker, and WebGPU renderer.

## Result

| Terminal            |        Producer |  Visible/render updates | What was measured                        |
| ------------------- | --------------: | ----------------------: | ---------------------------------------- |
| Ghosttea experiment | 62.5 target FPS |    59–62 render calls/s | Internal WebGPU render telemetry         |
| macOS Terminal      |       62.48 FPS | approximately 42–44 FPS | Changes in a window-only macOS recording |
| iTerm 3.6.5         |       62.50 FPS | approximately 10–12 FPS | Changes in a window-only macOS recording |

Both native terminals reported zero blocked writes and zero drain wait. That
means their PTYs accepted the entire workload at the requested cadence; it does
not mean every accepted frame reached the screen.

For Ghosttea, one live run produced 173 WebGPU render calls during the active
window, about 59.4 render calls per second. The final delayed-capture run
produced all 180 render calls; subtracting the configured 300 ms quiet tail from
its 3,199.3 ms end-to-idle duration gives about 62.1 render calls per second.

## Recording analysis

macOS `screencapture` recorded only the target window. The Terminal recording
contained 284 captured frames over 5.025 seconds; the iTerm recording contained
287 over 5.008 seconds. Consecutive frames were differenced with FFmpeg's
`tblend=all_mode=difference` and `signalstats` filters. Counts were restricted
to the nominal 2.88-second workload window, and the meaningful-change threshold
was calibrated above the noise in the static tail. Varying the threshold around
that boundary produced the visible-FPS ranges in the table instead of a
single over-precise number.

The recorder itself sampled at roughly 56–57 FPS, so it cannot demonstrate a
present rate above that ceiling.

## Interpretation and limitation

On this exact high-bandwidth truecolor workload, Ghosttea appears faster than
both native terminals. The comparison is not yet apples-to-apples enough for a
public "we beat them" claim: Ghosttea's number is internal render submissions,
while the other two numbers are compositor-visible window changes.

The same window-only macOS capture path returned an all-black recording for the
Electron/WebGPU window even though Ghosttea's internal telemetry showed normal
rendering. A defensible cross-product result therefore needs one of:

1. a capture path that records Ghosttea's actual WebGPU window contents;
2. platform presentation feedback for Ghosttea and equivalent instrumentation
   for the native terminals; or
3. a high-speed external camera measurement.

Before treating the result as optimization evidence, run at least five
interleaved repetitions per terminal, randomize product order, and report the
distribution rather than the best sample.
