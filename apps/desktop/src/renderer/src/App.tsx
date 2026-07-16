import { useEffect, useMemo, useState } from "react";
import { GhostteaWorkspace } from "@vibecook/ghosttea-react/workspace";

export function App() {
  const [active, setActive] = useState(document.visibilityState !== "hidden");
  const [tabCount, setTabCount] = useState(1);
  const platform = useMemo(
    () => ({
      defaultShell: window.desktop.defaultShell,
      readClipboard: window.desktop.readClipboard,
      showContextMenu: window.desktop.showContextMenu,
      toggleFullscreen: window.desktop.toggleFullscreen,
      closeWindow: window.desktop.closeWindow,
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

  useEffect(() => window.desktop.onTabCount(setTabCount), []);

  return (
    <GhostteaWorkspace
      platform={platform}
      storageKey={`ghosttea:workspace:v2:${window.desktop.tabId}`}
      claimExistingSessions={window.desktop.claimExistingSessions}
      active={active}
      showTitlebar={tabCount < 2}
      onSessionsChange={window.desktop.updateTabSessions}
      onActiveSessionChange={(session) => window.desktop.updateActiveCwd(session?.cwd ?? undefined)}
      {...(window.desktop.initialCwd ? { initialCwd: window.desktop.initialCwd } : {})}
    />
  );
}
