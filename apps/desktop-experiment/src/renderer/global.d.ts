export {};

import type { RenderBenchmarkConfig } from "../benchmark/types";

declare global {
  interface Window {
    desktop: {
      platform: string;
      tabId: string;
      claimExistingSessions: boolean;
      initialCwd?: string;
      renderBenchmark: boolean;
      renderBenchmarkConfig?: RenderBenchmarkConfig;
      defaultShell: string;
      writeClipboard: (text: string) => void;
      readClipboard: () => string;
      showContextMenu: (canCopy: boolean) => void;
      toggleFullscreen: () => void;
      closeWindow: () => void;
      newTab: (cwd?: string) => void;
      selectTab: (target: "previous" | "next" | number) => void;
      closeTab: () => void;
      updateTabSessions: (sessionIds: readonly string[]) => void;
      updateActiveCwd: (cwd?: string) => void;
      startRenderBenchmarkCase: (caseName: string, iteration: number) => Promise<void>;
      finishRenderBenchmarkCase: () => Promise<unknown>;
      completeRenderBenchmark: (report: unknown) => Promise<void>;
      failRenderBenchmark: (message: string) => Promise<void>;
      onMenuAction: (listener: (action: "copy" | "paste" | "select-all" | "clear-screen") => void) => () => void;
    };
  }
}
