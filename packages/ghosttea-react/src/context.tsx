import { createContext, useContext, type ReactNode } from "react";
import type { GhostteaTerminalRuntime } from "./runtime.js";

const GhostteaRuntimeContext = createContext<GhostteaTerminalRuntime | null>(null);

export interface GhostteaProviderProps {
  runtime: GhostteaTerminalRuntime;
  children: ReactNode;
}

export function GhostteaProvider({ runtime, children }: GhostteaProviderProps) {
  return <GhostteaRuntimeContext.Provider value={runtime}>{children}</GhostteaRuntimeContext.Provider>;
}

export function useGhostteaRuntime(): GhostteaTerminalRuntime {
  const runtime = useContext(GhostteaRuntimeContext);
  if (!runtime) throw new Error("TerminalSurface must be rendered inside GhostteaProvider");
  return runtime;
}
