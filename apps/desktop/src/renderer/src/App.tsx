import { GhostteaWorkspace } from "@vibecook/ghosttea-react/workspace";

export function App() {
  return (
    <GhostteaWorkspace
      platform={{
        defaultShell: window.desktop.defaultShell,
        readClipboard: window.desktop.readClipboard,
        showContextMenu: window.desktop.showContextMenu,
        toggleFullscreen: window.desktop.toggleFullscreen,
        closeWindow: window.desktop.closeWindow,
        onMenuAction: window.desktop.onMenuAction,
      }}
    />
  );
}
