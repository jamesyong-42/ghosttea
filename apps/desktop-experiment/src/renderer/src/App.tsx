import { useEffect, useMemo, useState } from "react";
import { GhostteaWorkspace } from "@vibecook/ghosttea-react/workspace";
import { handleDomEditCommand } from "./dom-edit-commands";
import { RenderBenchmarkApp } from "./RenderBenchmarkApp";
import { ReplicatedRenderBenchmarkApp } from "./ReplicatedRenderBenchmarkApp";

export function App() {
  if (window.desktop.renderBenchmarkConfig) {
    if (window.desktop.renderBenchmarkConfig.replication) {
      return <ReplicatedRenderBenchmarkApp config={window.desktop.renderBenchmarkConfig} />;
    }
    return <RenderBenchmarkApp config={window.desktop.renderBenchmarkConfig} />;
  }
  return <DesktopApp />;
}

function DesktopApp() {
  const [active, setActive] = useState(document.visibilityState !== "hidden");
  const platform = useMemo(
    () => ({
      platform: window.desktop.platform,
      defaultShell: window.desktop.defaultShell,
      readClipboard: window.desktop.readClipboard,
      setCanCopy: window.desktop.setTerminalCanCopy,
      showContextMenu: window.desktop.showContextMenu,
      toggleFullscreen: window.desktop.toggleFullscreen,
      closeWindow: window.desktop.closeWindow,
      newWindow: window.desktop.newWindow,
      quit: window.desktop.quit,
      newTab: window.desktop.newTab,
      selectTab: window.desktop.selectTab,
      closeTab: window.desktop.closeTab,
      onMenuAction: window.desktop.onMenuAction,
    }),
    [],
  );

  useEffect(() => {
    const updateVisibility = (): void => setActive(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", updateVisibility);
    return () => document.removeEventListener("visibilitychange", updateVisibility);
  }, []);

  useEffect(
    () =>
      window.desktop.onMenuAction((action) => {
        if (action === "copy" || action === "paste" || action === "select-all") {
          void handleDomEditCommand(action, window.desktop).catch((error: unknown) =>
            console.error("[terminal-runtime] edit command failed", error),
          );
        }
      }),
    [],
  );

  return (
    <GhostteaWorkspace
      platform={platform}
      storageKey={`ghosttea:workspace:v2:${window.desktop.tabId}`}
      claimExistingSessions={window.desktop.claimExistingSessions}
      active={active}
      showTitlebar={false}
      onSessionsChange={window.desktop.updateTabSessions}
      onActiveSessionChange={(session) => window.desktop.updateActiveCwd(session?.cwd ?? undefined)}
      {...(window.desktop.initialCwd ? { initialCwd: window.desktop.initialCwd } : {})}
    />
  );
}
