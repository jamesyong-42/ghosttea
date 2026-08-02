import type { TerminalShaderEffect } from "../renderers/types.js";

export interface GhostteaShaderOption {
  id: TerminalShaderEffect;
  name: string;
  description: string;
  license: string;
  animated: boolean;
}

/** Ports whose upstream files carry terms compatible with distribution here. */
export const GHOSTTEA_SHADER_OPTIONS: readonly GhostteaShaderOption[] = [
  {
    id: "ghosttea:better-crt",
    name: "Better CRT (legacy)",
    description: "Curved display and scanlines; retained for compatibility with the existing bundled effect.",
    license: "CC BY-NC-SA 3.0 upstream",
    animated: false,
  },
  {
    id: "ghosttea:crt",
    name: "CRT",
    description: "Public-domain Lottes-style scanline, mask, warp, and tone treatment.",
    license: "Unlicense / public domain",
    animated: false,
  },
  {
    id: "ghosttea:vhs",
    name: "VHS",
    description: "Animated tape wobble, chroma bleed, tracking noise, grain, and vignette.",
    license: "MIT",
    animated: true,
  },
  {
    id: "ghosttea:sparks-from-fire",
    name: "Sparks from Fire",
    description: "Animated ember overlay adapted from the attribution-licensed upstream shader.",
    license: "CC BY 3.0",
    animated: true,
  },
];

const GHOSTTEA_SHADER_IDS = new Set<TerminalShaderEffect>(GHOSTTEA_SHADER_OPTIONS.map((shader) => shader.id));

export function isGhostteaShaderEffect(id: string): id is TerminalShaderEffect {
  return GHOSTTEA_SHADER_IDS.has(id as TerminalShaderEffect);
}

/** Upstream names intentionally not bundled until their redistribution terms are cleared. */
export const UNAVAILABLE_UPSTREAM_SHADERS = [
  "animated-gradient-shader",
  "bloom",
  "cineShader-Lava",
  "cubes",
  "cursor_blaze",
  "cursor_lightning",
  "dither",
  "drunkard",
  "fireworks-rockets",
  "fireworks",
  "galaxy",
  "gears-and-belts",
  "glitchy",
  "glow-rgbsplit-twitchy",
  "gradient-background",
  "in-game-crt-cursor",
  "in-game-crt",
  "inside-the-matrix",
  "just-snow",
  "matrix-hallway",
  "mnoise",
  "negative",
  "retro-terminal",
  "sin-interference",
  "smear_cursor_blocks",
  "smoke-and-ghost",
  "spotlight",
  "starfield-colors",
  "starfield",
  "tft",
  "underwater",
  "water",
] as const;
