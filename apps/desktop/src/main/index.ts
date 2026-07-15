import { join } from "node:path";
import { app, BrowserWindow, ipcMain, Menu, MessageChannelMain, utilityProcess } from "electron";
import { TerminalSupervisor } from "./terminal-supervisor";

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

async function createWindow(): Promise<void> {
  supervisor = new TerminalSupervisor();
  await supervisor.start();

  mainWindow = new BrowserWindow({
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
  mainWindow.once("ready-to-show", () => mainWindow?.show());
  mainWindow.webContents.on("preload-error", (_event, preloadPath, error) => {
    console.error(`[terminal-runtime] preload failed at ${preloadPath}: ${error.stack ?? error.message}`);
  });

  const bridgeEntry = join(__dirname, "terminal-bridge.js");
  bridge = utilityProcess.fork(bridgeEntry, [], { serviceName: "terminal-bridge" });
  bridge.on("exit", (code) => console.error(`terminal-bridge exited (${code})`));

  if (!app.isPackaged) {
    mainWindow.webContents.on("console-message", (details) => {
      if (details.message.startsWith("[terminal-runtime]")) {
        console.log(details.message);
      }
    });
  }

  mainWindow.webContents.on("did-finish-load", () => {
    if (!mainWindow || !bridge || !supervisor) return;
    console.log("[terminal-runtime] renderer loaded; transferring ports");
    const control = new MessageChannelMain();
    const frames = new MessageChannelMain();
    bridge.postMessage({ type: "connect", connection: supervisor.connection }, [control.port1, frames.port1]);
    mainWindow.webContents.postMessage("terminal-ports", null, [control.port2, frames.port2]);
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    await mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    await mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
  }
}

app.whenReady().then(createWindow).catch((error) => {
  console.error(error);
  app.quit();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  bridge?.kill();
  supervisor?.stop();
});
