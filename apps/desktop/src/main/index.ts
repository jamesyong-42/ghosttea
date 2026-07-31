import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join, resolve } from "node:path";
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeTheme, shell } from "electron";
import {
  allSettledWithin,
  GhostteaElectronBackend,
  installGhostteaClipboardHost,
  installGhostteaEditShortcuts,
  type GhostteaElectronBackendOptions,
} from "@vibecook/ghosttea-electron/main";
import { LEGACY_PROFILE_ENV, PROFILE_ENV, desktopProfile } from "./profile";
import { orderNativeTabs } from "./native-tab-order";
import { DesktopTabRegistry } from "./tab-registry";

app.setName("Ghosttea");
nativeTheme.themeSource = "dark";
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
const terminalConfigPath = join(app.getPath("userData"), "config.ghostty");

// Electron keys this lock from the configured user-data directory. Different
// profiles coexist; launching the same profile again activates its window.
const ownsProfile = app.requestSingleInstanceLock({ profile: profile.name });
if (!ownsProfile) app.quit();

const clipboardHost = installGhostteaClipboardHost(ipcMain, clipboard);

ipcMain.on("terminal-context-menu", (event, canCopy: boolean) => {
  const window = BrowserWindow.fromWebContents(event.sender);
  if (!window) return;
  const send = (action: string): void => window.webContents.send("terminal-menu-action", action);
  Menu.buildFromTemplate([
    { label: "Copy", enabled: Boolean(canCopy), click: () => send("copy") },
    { label: "Paste", click: () => send("paste") },
    { type: "separator" },
    { label: "Select All", click: () => send("select-all") },
    { label: "Clear Screen", click: () => send("clear-screen") },
  ]).popup({ window });
});

ipcMain.on("terminal-toggle-fullscreen", (event) => {
  const window = BrowserWindow.fromWebContents(event.sender);
  if (window) window.setFullScreen(!window.isFullScreen());
});

ipcMain.on("terminal-close-window", (event) => {
  BrowserWindow.fromWebContents(event.sender)?.close();
});

ipcMain.on("terminal-new-window", (event, cwd: unknown) => {
  void createWindow({
    initialCwd: typeof cwd === "string" && cwd.trim() ? cwd : undefined,
  }).catch((error) => console.error("failed to create window", error));
});

ipcMain.on("terminal-quit", () => {
  app.quit();
});

ipcMain.on("terminal-close-all-windows", () => {
  for (const window of BrowserWindow.getAllWindows()) window.close();
});

ipcMain.on("terminal-open-config", (event) => {
  if (externalBackendConfigured()) {
    void showExternalConfigOwnershipMessage(event.sender, "open");
    return;
  }
  if (!existsSync(terminalConfigPath)) {
    mkdirSync(app.getPath("userData"), { recursive: true, mode: 0o700 });
    writeFileSync(
      terminalConfigPath,
      [
        "# Ghosttea application overrides (Ghostty-compatible syntax).",
        "# Your existing Ghostty config files are imported before this file.",
        "# Enable Ghosttea's bundled CRT approximation with:",
        "# custom-shader = ghosttea:better-crt",
        "",
      ].join("\n"),
      { encoding: "utf8", mode: 0o600 },
    );
  }
  void shell
    .openPath(terminalConfigPath)
    .then((message) => {
      if (message) console.error("failed to open terminal config", message);
    })
    .catch((error) => console.error("failed to open terminal config", error));
});

ipcMain.on("terminal-reload-config", (event) => {
  if (externalBackendConfigured()) {
    void showExternalConfigOwnershipMessage(event.sender, "reload");
    return;
  }
  void ensureBackend()
    .then(() => backend!.automation.reloadConfig())
    .catch((error) => console.error("failed to reload terminal config", error));
});

ipcMain.on("terminal-new-tab", (event, cwd: unknown) => {
  const window = BrowserWindow.fromWebContents(event.sender);
  if (!window) return;
  void createWindow({ tabOf: window, initialCwd: typeof cwd === "string" && cwd.trim() ? cwd : undefined }).catch(
    (error) => console.error("failed to create tab", error),
  );
});

ipcMain.on("terminal-select-tab", (event, target: unknown) => {
  const window = BrowserWindow.fromWebContents(event.sender);
  if (!window) return;
  if (target === "previous") {
    if (process.platform === "darwin") window.selectPreviousTab();
    else focusRelativeTab(window, -1);
  } else if (target === "next") {
    if (process.platform === "darwin") window.selectNextTab();
    else focusRelativeTab(window, 1);
  } else if (target === "last" || (typeof target === "number" && Number.isSafeInteger(target))) {
    const current = tabs.get(window);
    if (!current) return;
    const group = tabs.group(current.groupId);
    const orderedWindows = orderNativeTabs(group.map((record) => record.window));
    if (orderedWindows.length === 0) return;
    if (target === "last") {
      focusTab(orderedWindows[orderedWindows.length - 1]);
      return;
    }
    // Ghostty goto_tab: indexes above the tab count select the last tab.
    const index = Math.min(Math.max(target, 1), orderedWindows.length) - 1;
    focusTab(orderedWindows[index]);
  }
});

ipcMain.on("terminal-close-tab", (event) => {
  BrowserWindow.fromWebContents(event.sender)?.close();
});

ipcMain.on("terminal-tab-sessions", (event, sessionIds: unknown) => {
  const window = BrowserWindow.fromWebContents(event.sender);
  if (!window || !Array.isArray(sessionIds) || !sessionIds.every((id) => typeof id === "string")) return;
  tabs.updateSessions(window, sessionIds);
});

ipcMain.on("terminal-tab-active-cwd", (event, cwd: unknown) => {
  const window = BrowserWindow.fromWebContents(event.sender);
  if (!window) return;
  tabs.updateActiveCwd(window, typeof cwd === "string" && cwd.trim() ? cwd : undefined);
});

const tabs = new DesktopTabRegistry<BrowserWindow>();
let backend: GhostteaElectronBackend | undefined;
let quitting = false;
let quitCleanupComplete = false;
let quitCleanup: Promise<void> | undefined;
const QUIT_CLEANUP_TIMEOUT_MS = 5_000;
const closingSessionOwners = new Set<Promise<void>>();
let recoveringBackend: Promise<void> | undefined;
let lastFocusedWindow: BrowserWindow | undefined;

function externalBackendConfigured(): boolean {
  return Boolean(
    process.env.GHOSTTEA_EXTERNAL_CONTROL_SOCKET &&
    process.env.GHOSTTEA_EXTERNAL_FRAME_SOCKET &&
    process.env.GHOSTTEA_EXTERNAL_AUTH_TOKEN,
  );
}

async function showExternalConfigOwnershipMessage(
  sender: Electron.WebContents,
  action: "open" | "reload",
): Promise<void> {
  const owner = BrowserWindow.fromWebContents(sender);
  const options = {
    type: "info" as const,
    title: "Configuration managed externally",
    message: `Ghosttea cannot ${action} this configuration`,
    detail:
      "This window is connected to an externally managed daemon. Open or reload the configuration from the process that started that daemon.",
    buttons: ["OK"],
  };
  if (owner) await dialog.showMessageBox(owner, options);
  else await dialog.showMessageBox(options);
}

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
  const environment = {
    GHOSTTEA_CONFIG_PATH: terminalConfigPath,
    ...(!process.env.TRUFFLE_SIDECAR_PATH && !app.isPackaged && existsSync(developmentSidecar)
      ? { TRUFFLE_SIDECAR_PATH: developmentSidecar }
      : {}),
  };
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
      environment,
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
        for (const record of tabs.records()) {
          if (!record.window.isDestroyed()) record.window.webContents.reload();
        }
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
  const window =
    BrowserWindow.getFocusedWindow() ??
    (lastFocusedWindow && !lastFocusedWindow.isDestroyed() ? lastFocusedWindow : tabs.records()[0]?.window);
  if (!window || window.isDestroyed()) return;
  if (window.isMinimized()) window.restore();
  if (process.platform === "darwin") app.focus({ steal: true });
  window.show();
  window.focus();
}

function focusTab(window: BrowserWindow | undefined): void {
  if (!window || window.isDestroyed()) return;
  window.show();
  window.focus();
}

function focusRelativeTab(window: BrowserWindow, offset: -1 | 1): void {
  const current = tabs.get(window);
  if (!current) return;
  const group = tabs.group(current.groupId);
  const index = group.findIndex((record) => record.window === window);
  if (index < 0 || group.length < 2) return;
  focusTab(group[(index + offset + group.length) % group.length]?.window);
}

async function closeSessionOwner(ownerId: string, sessionIds: ReadonlySet<string>): Promise<void> {
  const client = backend?.automation;
  if (!client) return;
  try {
    await client.closeSessionOwner(ownerId);
  } catch (ownerError) {
    console.warn(`[terminal-runtime] failed to close tab session owner ${ownerId}`, ownerError);
    // Compatibility fallback for an externally managed older daemon. This is
    // observational only; current daemons close the owner transactionally.
    const orderedSessionIds = [...sessionIds];
    const results = await Promise.allSettled(
      orderedSessionIds.map(async (sessionId) => {
        await client.terminate(sessionId, "user");
      }),
    );
    results.forEach((result, index) => {
      if (result.status === "rejected") {
        const sessionId = orderedSessionIds[index];
        console.warn(`[terminal-runtime] failed to terminate closed-tab session ${sessionId}`, result.reason);
      }
    });
  }
}

function terminateClosedTabSessions(ownerId: string, sessionIds: ReadonlySet<string>): void {
  if (quitting || !backend) return;
  const task = closeSessionOwner(ownerId, sessionIds);
  closingSessionOwners.add(task);
  void task.finally(() => closingSessionOwners.delete(task));
}

interface CreateWindowOptions {
  tabOf?: BrowserWindow;
  initialCwd?: string | undefined;
  claimExistingSessions?: boolean;
}

async function createWindow(options: CreateWindowOptions = {}): Promise<BrowserWindow> {
  await ensureBackend();

  const parentRecord = options.tabOf ? tabs.get(options.tabOf) : undefined;
  const groupId = parentRecord?.groupId ?? `ghosttea-${profile.name}-${randomUUID()}`;
  const tabId = randomUUID();
  const claimExistingSessions = options.claimExistingSessions ?? tabs.records().length === 0;
  const additionalArguments = [
    `--ghosttea-tab-id=${tabId}`,
    `--ghosttea-tab-claim-existing=${claimExistingSessions ? "1" : "0"}`,
    ...(options.initialCwd ? [`--ghosttea-tab-cwd=${encodeURIComponent(options.initialCwd)}`] : []),
  ];

  const window = new BrowserWindow({
    width: 800,
    height: 600,
    minWidth: 320,
    minHeight: 180,
    show: false,
    title: "Ghosttea",
    backgroundColor: "#282c34",
    titleBarStyle: "default",
    ...(process.platform === "darwin" ? { tabbingIdentifier: groupId } : {}),
    acceptFirstMouse: true,
    fullscreenable: true,
    autoHideMenuBar: process.platform !== "darwin",
    webPreferences: {
      preload: join(__dirname, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      backgroundThrottling: true,
      additionalArguments,
    },
  });
  const record = tabs.add(window, tabId, groupId);
  if (options.tabOf && process.platform === "darwin" && !options.tabOf.isDestroyed()) {
    options.tabOf.addTabbedWindow(window);
  }
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
  window.on("focus", () => {
    lastFocusedWindow = window;
  });
  window.on("new-window-for-tab", () => {
    void createWindow({ tabOf: window, initialCwd: record.activeCwd }).catch((error) =>
      console.error("failed to create native tab", error),
    );
  });
  window.once("closed", () => {
    const closed = tabs.delete(window);
    if (lastFocusedWindow === window) lastFocusedWindow = undefined;
    if (!closed) return;
    terminateClosedTabSessions(closed.id, closed.sessionIds);
  });
  window.webContents.on("preload-error", (_event, preloadPath, error) => {
    console.error(`[terminal-runtime] preload failed at ${preloadPath}: ${error.stack ?? error.message}`);
  });
  // Terminal selections live in the render worker rather than the DOM, so
  // Electron's native edit role cannot copy them. Route the shortcut through
  // the same renderer command path as the terminal context menu.
  installGhostteaEditShortcuts(
    window.webContents,
    (command) => window.webContents.send("terminal-menu-action", command),
    process.platform,
    (command) => command !== "copy" || clipboardHost.canCopy(window.webContents),
  );

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
  return window;
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
  if (tabs.records().length === 0) {
    void createWindow({ claimExistingSessions: true }).catch((error) =>
      console.error("failed to recreate window", error),
    );
  } else {
    focusMainWindow();
  }
});

app.on("second-instance", (_event, _argv, _workingDirectory, additionalData) => {
  if ((additionalData as { profile?: unknown }).profile !== profile.name) return;
  focusMainWindow();
});

app.on("before-quit", (event) => {
  if (quitCleanupComplete) {
    quitting = true;
    backend?.stop();
    return;
  }
  event.preventDefault();
  if (quitCleanup) return;
  quitting = true;
  const ownerClosures = tabs.records().map((record) => closeSessionOwner(record.id, record.sessionIds));
  quitCleanup = allSettledWithin([...closingSessionOwners, ...ownerClosures], QUIT_CLEANUP_TIMEOUT_MS).then(
    (settled) => {
      if (!settled) console.warn("terminal session cleanup timed out during quit");
      try {
        backend?.stop();
      } catch (error) {
        console.error("terminal backend shutdown failed", error);
      }
      quitCleanupComplete = true;
      app.quit();
    },
  );
});
