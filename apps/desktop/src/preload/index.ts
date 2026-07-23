import { contextBridge, ipcRenderer } from "electron";
import { createGhostteaClipboardBridge } from "@vibecook/ghosttea-electron/preload";
import type { RendererPortBootstrapMessage } from "@vibecook/ghosttea-electron/types";

console.info("[terminal-runtime] preload ready");

function argument(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length);
}

const tabId = argument("ghosttea-tab-id") ?? "default";
const claimExistingSessions = argument("ghosttea-tab-claim-existing") !== "0";
const encodedInitialCwd = argument("ghosttea-tab-cwd");
let initialCwd: string | undefined;
try {
  initialCwd = encodedInitialCwd ? decodeURIComponent(encodedInitialCwd) : undefined;
} catch {
  initialCwd = undefined;
}

ipcRenderer.on("terminal-ports", (event) => {
  console.info(`[terminal-runtime] preload received ${event.ports.length} ports`);
  window.postMessage({ type: "ghosttea:ports" } satisfies RendererPortBootstrapMessage, "*", event.ports);
});

const clipboardBridge = createGhostteaClipboardBridge(ipcRenderer);

contextBridge.exposeInMainWorld("desktop", {
  platform: process.platform,
  tabId,
  claimExistingSessions,
  initialCwd,
  defaultShell:
    process.platform === "win32" ? (process.env.COMSPEC ?? "powershell.exe") : (process.env.SHELL ?? "/bin/zsh"),
  writeClipboard: clipboardBridge.writeText,
  readClipboard: clipboardBridge.readText,
  setTerminalCanCopy: clipboardBridge.setCanCopy,
  showContextMenu: (canCopy: boolean) => ipcRenderer.send("terminal-context-menu", canCopy),
  toggleFullscreen: () => ipcRenderer.send("terminal-toggle-fullscreen"),
  closeWindow: () => ipcRenderer.send("terminal-close-window"),
  newWindow: (cwd?: string) => ipcRenderer.send("terminal-new-window", cwd),
  quit: () => ipcRenderer.send("terminal-quit"),
  closeAllWindows: () => ipcRenderer.send("terminal-close-all-windows"),
  openConfig: () => ipcRenderer.send("terminal-open-config"),
  reloadConfig: () => ipcRenderer.send("terminal-reload-config"),
  newTab: (cwd?: string) => ipcRenderer.send("terminal-new-tab", cwd),
  selectTab: (target: "previous" | "next" | "last" | number) => ipcRenderer.send("terminal-select-tab", target),
  closeTab: () => ipcRenderer.send("terminal-close-tab"),
  updateTabSessions: (sessionIds: readonly string[]) => ipcRenderer.send("terminal-tab-sessions", sessionIds),
  updateActiveCwd: (cwd?: string) => ipcRenderer.send("terminal-tab-active-cwd", cwd),
  onMenuAction: (listener: (action: string) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, action: string): void => listener(action);
    ipcRenderer.on("terminal-menu-action", handler);
    return () => ipcRenderer.removeListener("terminal-menu-action", handler);
  },
});
