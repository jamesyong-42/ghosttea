import { existsSync, mkdirSync } from "node:fs";
import { hostname } from "node:os";
import { join, resolve } from "node:path";
import { app, BrowserWindow, ipcMain, Menu } from "electron";
import { GhostteaElectronBackend, type GhostteaElectronBackendOptions } from "@vibecook/ghosttea-electron/main";
import { LEGACY_PROFILE_ENV, PROFILE_ENV, desktopProfile } from "./profile";

app.setName("Ghosttea");
if (process.platform === "darwin") app.setActivationPolicy("regular");
const profile = desktopProfile(app.getPath("userData"), process.env[PROFILE_ENV] ?? process.env[LEGACY_PROFILE_ENV]);
mkdirSync(profile.electronData, { recursive: true, mode: 0o700 });
if (profile.name !== "default") {
  app.setPath("userData", profile.electronData);
  app.setPath("sessionData", profile.electronData);
  // A named profile is an isolation boundary. Do not allow a shared `.env`
  // value to collapse multiple peers onto the same Truffle identity.
  process.env.GHOSTTEA_TRUFFLE_DEVICE_NAME = `${hostname()} · ${profile.name}`;
  process.env.GHOSTTEA_TRUFFLE_STATE_DIR = profile.truffleState;
} else if (!process.env.GHOSTTEA_TRUFFLE_STATE_DIR?.trim() && !process.env.TERMINALD_TRUFFLE_STATE_DIR?.trim()) {
  process.env.GHOSTTEA_TRUFFLE_STATE_DIR = profile.truffleState;
}

// Electron keys this lock from the configured user-data directory. Different
// profiles coexist; launching the same profile again activates its window.
const ownsProfile = app.requestSingleInstanceLock({ profile: profile.name });
if (!ownsProfile) app.quit();

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
let backend: GhostteaElectronBackend | undefined;
let quitting = false;
let recoveringBackend: Promise<void> | undefined;

function backendOptions(): GhostteaElectronBackendOptions {
  const externalControl = process.env.GHOSTTEA_EXTERNAL_CONTROL_SOCKET;
  const externalFrames = process.env.GHOSTTEA_EXTERNAL_FRAME_SOCKET;
  const externalToken = process.env.GHOSTTEA_EXTERNAL_AUTH_TOKEN;
  if (externalControl && externalFrames && externalToken) {
    return {
      mode: "external",
      connection: { controlSocket: externalControl, frameSocket: externalFrames, authToken: externalToken },
    };
  }

  const repositoryRoot = resolve(app.getAppPath(), "../..");
  const developmentSidecar = resolve(
    repositoryRoot,
    "../p008/truffle/packages/sidecar-slim",
    process.platform === "win32" ? "sidecar-slim.exe" : "sidecar-slim",
  );
  const configuredBinary =
    process.env.GHOSTTEAD_BIN ??
    process.env.TERMINALD_BIN ??
    (app.isPackaged
      ? join(process.resourcesPath, "bin", process.platform === "win32" ? "ghosttead.exe" : "ghosttead")
      : undefined);
  const environment =
    !process.env.TRUFFLE_SIDECAR_PATH && !app.isPackaged && existsSync(developmentSidecar)
      ? { TRUFFLE_SIDECAR_PATH: developmentSidecar }
      : undefined;
  return {
    mode: "managed",
    daemon: {
      binary: configuredBinary
        ? { kind: "executable", path: configuredBinary }
        : {
            kind: "cargo",
            manifestPath: join(repositoryRoot, "native/ghosttead/Cargo.toml"),
            release: (process.env.GHOSTTEA_DEV_PROFILE ?? process.env.TERMINALD_DEV_PROFILE) !== "debug",
          },
      ...(environment ? { environment } : {}),
    },
  };
}

async function ensureBackend(): Promise<void> {
  if (!backend) {
    backend = new GhostteaElectronBackend(backendOptions());
    backend.on("unexpected-exit", ({ source, code, signal }) => {
      if (quitting) return;
      console.error(`${source} exited unexpectedly (${code ?? signal ?? "unknown"}); restarting`);
      void recoverBackend();
    });
  }
  if (!backend.running) await backend.start();
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

function focusMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  if (process.platform === "darwin") app.focus({ steal: true });
  mainWindow.show();
  mainWindow.focus();
}

async function createWindow(): Promise<void> {
  if (mainWindow && !mainWindow.isDestroyed()) {
    focusMainWindow();
    return;
  }
  await ensureBackend();

  const window = new BrowserWindow({
    width: 800,
    height: 600,
    minWidth: 320,
    minHeight: 180,
    show: false,
    title: "Ghosttea",
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
  const revealWindow = (): void => {
    if (window.isDestroyed()) return;
    if (window.isMinimized()) window.restore();
    if (process.platform === "darwin") app.focus({ steal: true });
    window.show();
    window.focus();
    if (!app.isPackaged) {
      const bounds = window.getBounds();
      console.log(
        `[terminal-runtime] window revealed: visible=${window.isVisible()} focused=${window.isFocused()} bounds=${bounds.x},${bounds.y} ${bounds.width}x${bounds.height}`,
      );
    }
  };
  window.once("ready-to-show", revealWindow);
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
    if (window.isDestroyed() || !backend?.running) return;
    console.log("[terminal-runtime] renderer loaded; transferring ports");
    backend.attachRenderer(window.webContents);
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    await window.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    await window.loadFile(join(__dirname, "../renderer/index.html"));
  }
  // `ready-to-show` can be delayed indefinitely while an initially hidden
  // WebGPU renderer continuously paints. Loading has completed at this point,
  // so reveal explicitly while keeping the event listener as the fast path.
  revealWindow();
}

app
  .whenReady()
  .then(() => {
    if (!ownsProfile) return;
    return createWindow();
  })
  .catch((error) => {
    console.error(error);
    app.exit(1);
  });

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (!mainWindow) void createWindow().catch((error) => console.error("failed to recreate window", error));
});

app.on("second-instance", (_event, _argv, _workingDirectory, additionalData) => {
  if ((additionalData as { profile?: unknown }).profile !== profile.name) return;
  focusMainWindow();
});

app.on("before-quit", () => {
  quitting = true;
  backend?.stop();
});
