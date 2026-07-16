import { clipboard, contextBridge, ipcRenderer } from "electron";
import type { RendererPortBootstrapMessage } from "@vibecook/ghosttea-electron/types";

console.info("[terminal-runtime] preload ready");

ipcRenderer.on("terminal-ports", (event) => {
  console.info(`[terminal-runtime] preload received ${event.ports.length} ports`);
  window.postMessage({ type: "ghosttea:ports" } satisfies RendererPortBootstrapMessage, "*", event.ports);
});

contextBridge.exposeInMainWorld("desktop", {
  platform: process.platform,
  defaultShell:
    process.platform === "win32" ? (process.env.COMSPEC ?? "powershell.exe") : (process.env.SHELL ?? "/bin/zsh"),
  writeClipboard: (text: string) => clipboard.writeText(text),
  readClipboard: () => clipboard.readText(),
  showContextMenu: (canCopy: boolean) => ipcRenderer.send("terminal-context-menu", canCopy),
  toggleFullscreen: () => ipcRenderer.send("terminal-toggle-fullscreen"),
  closeWindow: () => ipcRenderer.send("terminal-close-window"),
  onMenuAction: (listener: (action: string) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, action: string): void => listener(action);
    ipcRenderer.on("terminal-menu-action", handler);
    return () => ipcRenderer.removeListener("terminal-menu-action", handler);
  },
});
