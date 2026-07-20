import { clipboard, contextBridge, ipcRenderer } from "electron";
import type { RendererPortBootstrapMessage } from "@vibecook/ghosttea-electron/types";
import type { RenderBenchmarkConfig } from "../benchmark/types";

console.info("[terminal-runtime] preload ready");

function argument(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length);
}

const tabId = argument("ghosttea-tab-id") ?? "default";
const claimExistingSessions = argument("ghosttea-tab-claim-existing") !== "0";
const renderBenchmark = argument("ghosttea-render-benchmark") === "1";
const encodedRenderBenchmarkConfig = argument("ghosttea-render-benchmark-config");
let renderBenchmarkConfig: RenderBenchmarkConfig | undefined;
try {
  renderBenchmarkConfig = encodedRenderBenchmarkConfig
    ? (JSON.parse(decodeURIComponent(encodedRenderBenchmarkConfig)) as RenderBenchmarkConfig)
    : undefined;
} catch {
  renderBenchmarkConfig = undefined;
}
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

contextBridge.exposeInMainWorld("desktop", {
  platform: process.platform,
  tabId,
  claimExistingSessions,
  initialCwd,
  renderBenchmark,
  renderBenchmarkConfig,
  defaultShell:
    process.platform === "win32" ? (process.env.COMSPEC ?? "powershell.exe") : (process.env.SHELL ?? "/bin/zsh"),
  writeClipboard: (text: string) => clipboard.writeText(text),
  readClipboard: () => clipboard.readText(),
  showContextMenu: (canCopy: boolean) => ipcRenderer.send("terminal-context-menu", canCopy),
  toggleFullscreen: () => ipcRenderer.send("terminal-toggle-fullscreen"),
  closeWindow: () => ipcRenderer.send("terminal-close-window"),
  newTab: (cwd?: string) => ipcRenderer.send("terminal-new-tab", cwd),
  selectTab: (target: "previous" | "next" | number) => ipcRenderer.send("terminal-select-tab", target),
  closeTab: () => ipcRenderer.send("terminal-close-tab"),
  updateTabSessions: (sessionIds: readonly string[]) => ipcRenderer.send("terminal-tab-sessions", sessionIds),
  updateActiveCwd: (cwd?: string) => ipcRenderer.send("terminal-tab-active-cwd", cwd),
  startRenderBenchmarkCase: (caseName: string, iteration: number) =>
    ipcRenderer.invoke("render-benchmark-case-start", caseName, iteration) as Promise<void>,
  finishRenderBenchmarkCase: () => ipcRenderer.invoke("render-benchmark-case-finish") as Promise<unknown>,
  renderBenchmarkFrameHash: () => ipcRenderer.invoke("render-benchmark-frame-hash") as Promise<string>,
  waitForRenderBenchmarkCompletion: (key: string, timeoutMs: number) =>
    ipcRenderer.invoke("render-benchmark-wait-for-completion", key, timeoutMs) as Promise<unknown>,
  completeRenderBenchmark: (report: unknown) =>
    ipcRenderer.invoke("render-benchmark-complete", report) as Promise<void>,
  failRenderBenchmark: (message: string) => ipcRenderer.invoke("render-benchmark-failed", message) as Promise<void>,
  onMenuAction: (listener: (action: string) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, action: string): void => listener(action);
    ipcRenderer.on("terminal-menu-action", handler);
    return () => ipcRenderer.removeListener("terminal-menu-action", handler);
  },
});
