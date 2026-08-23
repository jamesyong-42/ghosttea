export { GhostteaProvider, useGhostteaRuntime, type GhostteaProviderProps } from "./context.js";
export {
  TerminalSurface,
  type TerminalInputPolicy,
  type TerminalMenuAction,
  type TerminalSurfaceProps,
} from "./TerminalSurface.js";
export {
  expireRoutedActivationLeases,
  initialRoutedActivation,
  reduceRoutedActivation,
  type RoutedActivationEvent,
  type RoutedActivationPhase,
  type RoutedActivationState,
  type RoutedInputPolicy,
} from "./routed-activation.js";
export { rendererTheme, terminalEffectsFromConfig, terminalThemeFromConfig } from "./config.js";
export {
  GhostteaTerminalRuntime,
  createGhostteaTerminalRuntime,
  waitForGhostteaRendererPorts,
  type GhostteaRendererPlatform,
  type GhostteaRendererPorts,
  type GhostteaPortTerminalRuntimeOptions,
  type GhostteaRoutedHost,
  type GhostteaRoutedTerminalRuntimeOptions,
  type GhostteaTerminalRuntimeOptions,
  type RoutedTerminalInputContext,
  type RoutedTerminalInputOperation,
  sessionIsFrozen,
  showsStaleScreen,
  type RemoteInputSuppression,
  type RemoteSessionRuntimeState,
  type SelectionScope,
  type TerminalMount,
} from "./runtime.js";
export {
  DEFAULT_EFFECTS,
  DEFAULT_THEME,
  type CellPoint,
  type CellSelection,
  type TerminalEffects,
  type TerminalShaderEffect,
  type TerminalTheme,
} from "./renderers/types.js";
export type {
  TerminalRenderCounterSnapshot,
  TerminalRenderMetrics,
  TerminalRenderPerformanceSnapshot,
} from "./performance.js";
