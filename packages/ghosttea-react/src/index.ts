export { GhostteaProvider, useGhostteaRuntime, type GhostteaProviderProps } from "./context.js";
export { TerminalSurface, type TerminalMenuAction, type TerminalSurfaceProps } from "./TerminalSurface.js";
export { rendererTheme, terminalEffectsFromConfig, terminalThemeFromConfig } from "./config.js";
export {
  GhostteaTerminalRuntime,
  createGhostteaTerminalRuntime,
  waitForGhostteaRendererPorts,
  type GhostteaRendererPlatform,
  type GhostteaRendererPorts,
  type GhostteaTerminalRuntimeOptions,
  sessionIsFrozen,
  showsStaleScreen,
  type RemoteInputSuppression,
  type RemoteSessionRuntimeState,
  type SelectionScope,
  type TerminalMount,
} from "./runtime.js";
export { DEFAULT_THEME, type CellPoint, type CellSelection, type TerminalTheme } from "./renderers/types.js";
export type { TerminalRenderMetrics, TerminalRenderPerformanceSnapshot } from "./performance.js";
