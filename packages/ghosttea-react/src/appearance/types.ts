import type { GhostteaColorTheme } from "./catalog.js";
import type { TerminalShaderEffect } from "../renderers/types.js";

export interface GhostteaAppearanceUpdate {
  /** Omitted when the user keeps a non-catalog/custom color configuration. */
  theme?: GhostteaColorTheme;
  backgroundOpacity: number;
  backgroundOpacityCells: boolean;
  shaderEffects: TerminalShaderEffect[];
  shaderAnimation: boolean;
}
