import { join } from "node:path";
import { app, BrowserWindow, ipcMain, Menu, MessageChannelMain, utilityProcess } from "electron";
import { TerminalSupervisor } from "./terminal-supervisor";
import type { MainToBridgeMessage } from "../shared/terminal-ipc";

app.setName("Ghostty");

ipcMain.on("terminal-context-menu", (event, canCopy: boolean) => {
  if (!mainWindow || event.sender !== mainWindow.webContents) return;
  const send = (action: string): void => mainWindow?.webContents.send("terminal-menu-action", action);
  Menu.buildFromTemplate([
    { label: "Copy", enabled: Boolean(canCopy), click: () => send("copy") },
    { label: "Paste", click: () => send("paste") },
    { type: "separator" },
    { label: "Select All", click: () => send("select-all") },
    { label: "Clear Screen", click: () => send("clear-screen") },
  ]).popup({ window: mainWindow });
});

ipcMain.on("terminal-toggle-fullscreen", (event) => {
  if (!mainWindow || event.sender !== mainWindow.webContents) return;
  mainWindow.setFullScreen(!mainWindow.isFullScreen());
});

ipcMain.on("terminal-close-window", (event) => {
  if (!mainWindow || event.sender !== mainWindow.webContents) return;
  mainWindow.close();
});

let mainWindow: BrowserWindow | undefined;
let supervisor: TerminalSupervisor | undefined;
let bridge: Electron.UtilityProcess | undefined;
let quitting = false;
let recoveringBackend: Promise<void> | undefined;

function startBridge(): void {
  if (bridge) return;
  const bridgeEntry = join(__dirname, "terminal-bridge.js");
  const next = utilityProcess.fork(bridgeEntry, [], { serviceName: "terminal-bridge" });
  bridge = next;
  next.on("exit", (code) => {
    if (bridge === next) bridge = undefined;
    if (quitting) return;
    console.error(`terminal-bridge exited (${code}); restarting`);
    void recoverBackend();
  });
}

async function ensureBackend(): Promise<void> {
  if (!supervisor) {
    supervisor = new TerminalSupervisor();
    supervisor.on("unexpected-exit", ({ code, signal }) => {
      if (quitting) return;
      console.error(`terminald exited unexpectedly (${code ?? signal ?? "unknown"}); restarting`);
      void recoverBackend();
    });
  }
  if (!supervisor.running) await supervisor.start();
  startBridge();
}

function recoverBackend(): Promise<void> {
  recoveringBackend ??= (async () => {
    let lastError: unknown;
    for (let attempt = 0; attempt < 5 && !quitting; attempt += 1) {
      try {
        await ensureBackend();
        mainWindow?.webContents.reload();
        return;
      } catch (error) {
        lastError = error;
        await new Promise((resolveDelay) => setTimeout(resolveDelay, Math.min(5_000, 250 * 2 ** attempt)));
      }
    }
    if (lastError) console.error("terminal backend recovery failed", lastError);
  })().finally(() => {
    recoveringBackend = undefined;
  });
  return recoveringBackend;
}

async function createWindow(): Promise<void> {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.focus();
    return;
  }
  await ensureBackend();

  const window = new BrowserWindow({
    width: 800,
    height: 600,
    minWidth: 320,
    minHeight: 180,
    show: false,
    title: "Ghostty",
    backgroundColor: "#282c34",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    ...(process.platform === "darwin" ? { trafficLightPosition: { x: 12, y: 8 } } : {}),
    acceptFirstMouse: true,
    fullscreenable: true,
    autoHideMenuBar: process.platform !== "darwin",
    webPreferences: {
      preload: join(__dirname, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      backgroundThrottling: false,
    },
  });
  mainWindow = window;
  window.once("ready-to-show", () => window.show());
  window.once("closed", () => {
    if (mainWindow === window) mainWindow = undefined;
  });
  window.webContents.on("preload-error", (_event, preloadPath, error) => {
    console.error(`[terminal-runtime] preload failed at ${preloadPath}: ${error.stack ?? error.message}`);
  });

  if (!app.isPackaged) {
    window.webContents.on("console-message", (details) => {
      if (details.message.startsWith("[terminal-runtime]")) {
        console.log(details.message);
      }
    });
  }

  window.webContents.on("did-finish-load", () => {
    if (window.isDestroyed() || !bridge || !supervisor) return;
    console.log("[terminal-runtime] renderer loaded; transferring ports");
    const control = new MessageChannelMain();
    const frames = new MessageChannelMain();
    bridge.postMessage({ type: "connect", connection: supervisor.connection } satisfies MainToBridgeMessage, [
      control.port1,
      frames.port1,
    ]);
    window.webContents.postMessage("terminal-ports", null, [control.port2, frames.port2]);
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    await window.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    await window.loadFile(join(__dirname, "../renderer/index.html"));
  }
}

app
  .whenReady()
  .then(createWindow)
  .catch((error) => {
    console.error(error);
    app.quit();
  });

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (!mainWindow) void createWindow().catch((error) => console.error("failed to recreate window", error));
});

app.on("before-quit", () => {
  quitting = true;
  bridge?.kill();
  supervisor?.stop();
});
