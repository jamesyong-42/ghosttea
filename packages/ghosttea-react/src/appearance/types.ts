import type { GhostteaColorTheme } from "./catalog.js";
import type { TerminalShaderEffect } from "../renderers/types.js";

export interface GhostteaAppearanceUpdate {
  theme: GhostteaColorTheme;
  backgroundOpacity: number;
  backgroundOpacityCells: boolean;
  shaderEffects: TerminalShaderEffect[];
  shaderAnimation: boolean;
}
