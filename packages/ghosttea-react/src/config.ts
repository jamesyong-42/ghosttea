import type { ConfigSnapshot, RendererConfig } from "@vibecook/ghosttea-protocol";
import type { TerminalEffects, TerminalTheme } from "./renderers/types.js";

function rgba(color: readonly [number, number, number]): [number, number, number, number] {
  return [color[0] / 255, color[1] / 255, color[2] / 255, 1];
}

export function terminalThemeFromConfig(config: Pick<ConfigSnapshot, "renderer">): TerminalTheme {
  const renderer = config.renderer;
  return {
    background: rgba(renderer.background),
    foreground: rgba(renderer.foreground),
    cursor: rgba(renderer.cursor),
    selection: rgba(renderer.selectionBackground),
    selectionForeground: rgba(renderer.selectionForeground),
  };
}

export function terminalEffectsFromConfig(config: Pick<ConfigSnapshot, "renderer">): TerminalEffects {
  return { postProcess: config.renderer.postProcess };
}

/** Public alias useful to hosts that cache only the renderer projection. */
export function rendererTheme(renderer: RendererConfig): TerminalTheme {
  return terminalThemeFromConfig({ renderer });
}
