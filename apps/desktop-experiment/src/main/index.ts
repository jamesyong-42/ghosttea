import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join, resolve } from "node:path";
import { app, BrowserWindow, ipcMain, Menu, nativeTheme, powerMonitor, screen } from "electron";
import {
  allSettledWithin,
  GhostteaElectronBackend,
  installGhostteaEditShortcuts,
  type GhostteaElectronBackendOptions,
} from "@vibecook/ghosttea-electron/main";
import { LEGACY_PROFILE_ENV, PROFILE_ENV, desktopProfile } from "./profile";
import { orderNativeTabs } from "./native-tab-order";
import { DesktopTabRegistry } from "./tab-registry";
import type { ElectronCaseSamples, ElectronProcessSample, RenderBenchmarkConfig } from "../benchmark/types";

function renderBenchmarkConfiguration(): RenderBenchmarkConfig | undefined {
  const serialized = process.env.GHOSTTEA_RENDER_BENCH_CONFIG;
  if (!serialized) return undefined;
  const parsed = JSON.parse(serialized) as RenderBenchmarkConfig;
  if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.cases)) {
    throw new Error("Unsupported rendering benchmark configuration");
  }
  return parsed;
}

const renderBenchmark = renderBenchmarkConfiguration();
const renderBenchmarkOutput = process.env.GHOSTTEA_RENDER_BENCH_OUTPUT;
const renderBenchmarkWindowIdOutput = process.env.GHOSTTEA_RENDER_BENCH_WINDOW_ID_OUTPUT;

app.setName("Ghosttea Experiment");
nativeTheme.themeSource = "dark";
if (process.platform === "darwin") app.setActivationPolicy("regular");
const profile = desktopProfile(app.getPath("userData"), process.env[PROFILE_ENV] ?? process.env[LEGACY_PROFILE_ENV]);
const replicatedBenchmarkState = renderBenchmark?.replication
  ? process.env.GHOSTTEA_TRUFFLE_BENCHMARK_STATE_DIR?.trim()
  : undefined;
mkdirSync(profile.electronData, { recursive: true, mode: 0o700 });
if (profile.name !== "default") {
  app.setPath("userData", profile.electronData);
  app.setPath("sessionData", profile.electronData);
  // A named profile is an isolation boundary. Do not allow a shared `.env`
  // value to collapse multiple peers onto the same Truffle identity.
  process.env.GHOSTTEA_TRUFFLE_DEVICE_NAME = `${hostname()} · ${profile.name}`;
  process.env.GHOSTTEA_TRUFFLE_STATE_DIR = replicatedBenchmarkState || profile.truffleState;
} else if (!process.env.GHOSTTEA_TRUFFLE_STATE_DIR?.trim() && !process.env.TERMINALD_TRUFFLE_STATE_DIR?.trim()) {
  process.env.GHOSTTEA_TRUFFLE_STATE_DIR = profile.truffleState;
}

// Electron keys this lock from the configured user-data directory. Different
// profiles coexist; launching the same profile again activates its window.
const ownsProfile = app.requestSingleInstanceLock({ profile: profile.name });
if (!ownsProfile) app.quit();

let benchmarkSampler: ReturnType<typeof setInterval> | undefined;
let benchmarkSamples: ElectronProcessSample[] = [];
let benchmarkCaseName = "";
let benchmarkIteration = 0;

function takeElectronProcessSample(): ElectronProcessSample {
  return {
    atMs: Date.now(),
    thermalState: powerMonitor.getCurrentThermalState(),
    processes: app.getAppMetrics().map((metric) => ({
      pid: metric.pid,
      type: metric.type,
      ...(metric.name ? { name: metric.name } : {}),
      ...(metric.serviceName ? { serviceName: metric.serviceName } : {}),
      cpuPercent: metric.cpu.percentCPUUsage,
      idleWakeupsPerSecond: metric.cpu.idleWakeupsPerSecond,
      workingSetBytes: metric.memory.workingSetSize * 1024,
    })),
  };
}

if (renderBenchmark) {
  ipcMain.handle("render-benchmark-wait-for-completion", async (_event, key: unknown, timeoutMs: unknown) => {
    const replication = renderBenchmark.replication;
    if (!replication) throw new Error("The active rendering benchmark is not replicated");
    if (typeof key !== "string" || !/^[A-Za-z0-9._-]{1,160}$/.test(key)) {
      throw new Error("Invalid replicated benchmark completion key");
    }
    if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new Error("Invalid replicated benchmark completion timeout");
    }
    const completionPath = join(replication.completionDirectory, `${key}.json`);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        return JSON.parse(readFileSync(completionPath, "utf8")) as unknown;
      } catch (error) {
        if (error instanceof SyntaxError) throw error;
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
      }
    }
    throw new Error(`Timed out waiting for replicated benchmark completion ${key}`);
  });

  ipcMain.handle("render-benchmark-case-start", (_event, caseName: unknown, iteration: unknown) => {
    if (benchmarkSampler) throw new Error("A rendering benchmark case is already active");
    benchmarkCaseName = typeof caseName === "string" ? caseName : "unknown";
    benchmarkIteration = typeof iteration === "number" ? iteration : -1;
    benchmarkSamples = [];
    // Prime Electron's interval CPU counters; the first value is documented as zero.
    app.getAppMetrics();
    benchmarkSampler = setInterval(() => benchmarkSamples.push(takeElectronProcessSample()), 100);
  });

  ipcMain.handle("render-benchmark-case-finish", (): ElectronCaseSamples => {
    if (benchmarkSampler) clearInterval(benchmarkSampler);
    benchmarkSampler = undefined;
    benchmarkSamples.push(takeElectronProcessSample());
    return {
      caseName: benchmarkCaseName,
      iteration: benchmarkIteration,
      samples: benchmarkSamples.splice(0),
    };
  });

  ipcMain.handle("render-benchmark-frame-hash", async (event): Promise<string> => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window) throw new Error("Rendering benchmark window is unavailable");
    const image = await window.webContents.capturePage();
    return createHash("sha256").update(image.toBitmap()).digest("hex");
  });

  ipcMain.handle("render-benchmark-complete", async (_event, report: unknown) => {
    if (!renderBenchmarkOutput) throw new Error("GHOSTTEA_RENDER_BENCH_OUTPUT is required");
    const display = screen.getPrimaryDisplay();
    const complete = {
      ...(typeof report === "object" && report ? report : { report }),
      electron: {
        versions: process.versions,
        gpuFeatureStatus: app.getGPUFeatureStatus(),
        gpuInfo: await app.getGPUInfo("basic"),
        display: {
          size: display.size,
          workAreaSize: display.workAreaSize,
          scaleFactor: display.scaleFactor,
          displayFrequency: display.displayFrequency,
          colorSpace: display.colorSpace,
        },
        finalThermalState: powerMonitor.getCurrentThermalState(),
      },
    };
    mkdirSync(resolve(renderBenchmarkOutput, ".."), { recursive: true });
    writeFileSync(renderBenchmarkOutput, `${JSON.stringify(complete, null, 2)}\n`);
    console.log(`[render-bench] wrote ${renderBenchmarkOutput}`);
    setTimeout(() => app.quit(), 50);
  });

  ipcMain.handle("render-benchmark-failed", (_event, message: unknown) => {
    console.error(`[render-bench] ${String(message)}`);
    process.exitCode = 1;
    setTimeout(() => app.quit(), 50);
  });
}

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

ipcMain.on("terminal-new-window", (_event, cwd: unknown) => {
  void createWindow({
    initialCwd: typeof cwd === "string" && cwd.trim() ? cwd : undefined,
  }).catch((error) => console.error("failed to create window", error));
});

ipcMain.on("terminal-quit", () => {
  app.quit();
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
  const groupId = parentRecord?.groupId ?? `ghosttea-experiment-${profile.name}-${randomUUID()}`;
  const tabId = randomUUID();
  const claimExistingSessions = options.claimExistingSessions ?? tabs.records().length === 0;
  const additionalArguments = [
    `--ghosttea-tab-id=${tabId}`,
    `--ghosttea-tab-claim-existing=${claimExistingSessions ? "1" : "0"}`,
    ...(options.initialCwd ? [`--ghosttea-tab-cwd=${encodeURIComponent(options.initialCwd)}`] : []),
    ...(renderBenchmark
      ? [
          "--ghosttea-render-benchmark=1",
          `--ghosttea-render-benchmark-config=${encodeURIComponent(JSON.stringify(renderBenchmark))}`,
        ]
      : []),
  ];

  const windowWidth = renderBenchmark?.width ?? 800;
  const windowHeight = renderBenchmark?.height ?? 600;
  const replicatedRole = renderBenchmark?.replication?.role;
  const workArea = replicatedRole ? screen.getPrimaryDisplay().workArea : undefined;
  const window = new BrowserWindow({
    width: windowWidth,
    height: windowHeight,
    ...(workArea && replicatedRole
      ? {
          x: replicatedRole === "host" ? workArea.x + 20 : workArea.x + workArea.width - windowWidth - 20,
          y: workArea.y + 40,
        }
      : {}),
    minWidth: 320,
    minHeight: 180,
    show: false,
    title: "Ghosttea Experiment",
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
      backgroundThrottling: !renderBenchmark,
      additionalArguments,
    },
  });
  const record = tabs.add(window, tabId, groupId);
  let wroteBenchmarkWindowId = false;
  if (options.tabOf && process.platform === "darwin" && !options.tabOf.isDestroyed()) {
    options.tabOf.addTabbedWindow(window);
  }
  const revealWindow = (): void => {
    if (window.isDestroyed()) return;
    if (window.isMinimized()) window.restore();
    if (process.platform === "darwin") app.focus({ steal: true });
    window.show();
    window.focus();
    if (renderBenchmarkWindowIdOutput && !wroteBenchmarkWindowId) {
      writeFileSync(
        renderBenchmarkWindowIdOutput,
        `${JSON.stringify({ mediaSourceId: window.getMediaSourceId(), processId: process.pid })}\n`,
      );
      wroteBenchmarkWindowId = true;
    }
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
  installGhostteaEditShortcuts(window.webContents, (command) =>
    window.webContents.send("terminal-menu-action", command),
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
  if (renderBenchmark) return;
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
  if (benchmarkSampler) clearInterval(benchmarkSampler);
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
