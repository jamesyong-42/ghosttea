export {};

declare global {
  interface Window {
    desktop: {
      platform: string;
      tabId: string;
      claimExistingSessions: boolean;
      initialCwd?: string;
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
      onTabCount: (listener: (count: number) => void) => () => void;
      onMenuAction: (listener: (action: "copy" | "paste" | "select-all" | "clear-screen") => void) => () => void;
    };
  }
}
