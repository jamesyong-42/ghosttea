import type { TerminalTheme } from "@vibecook/ghosttea-react";

export const TERMINAL_THEMES = {
  midnight: {
    // Ghostty's built-in dark defaults (the active config does not override
    // these). Keep the renderer and OSC 10/11/12 responses on one palette.
    background: [40 / 255, 44 / 255, 52 / 255, 1],
    foreground: [1, 1, 1, 1],
    cursor: [1, 1, 1, 1],
    selection: [1, 1, 1, 1],
    selectionForeground: [40 / 255, 44 / 255, 52 / 255, 1],
  },
  daylight: {
    background: [0.925, 0.91, 0.862, 1],
    foreground: [0.118, 0.133, 0.153, 1],
    cursor: [0.11, 0.35, 0.62, 0.68],
    selection: [0.18, 0.45, 0.72, 0.3],
    selectionForeground: [0.118, 0.133, 0.153, 1],
  },
} as const satisfies Record<string, TerminalTheme>;

export type TerminalThemeName = keyof typeof TERMINAL_THEMES;
