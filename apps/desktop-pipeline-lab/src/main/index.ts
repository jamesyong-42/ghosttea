import { join } from "node:path";
import { app, BrowserWindow, ipcMain, nativeTheme } from "electron";

app.setName("Ghosttea Pipeline Lab");
nativeTheme.themeSource = "dark";
if (process.platform === "darwin") app.setActivationPolicy("regular");

const ownsProfile = app.requestSingleInstanceLock();
if (!ownsProfile) app.quit();

ipcMain.handle("lab-process-sample", () => {
  const samples = app.getAppMetrics().map((metric) => ({
    pid: metric.pid,
    type: metric.type,
    ...(metric.name ? { name: metric.name } : {}),
    cpuPercent: metric.cpu.percentCPUUsage,
    workingSetBytes: metric.memory.workingSetSize * 1024,
  }));
  const renderer = samples.find((sample) => sample.type === "Tab" || sample.type === "GPU");
  const gpu = samples.find((sample) => sample.type === "GPU");
  const cpuPercent = samples.reduce((sum, sample) => sum + sample.cpuPercent, 0);
  const workingSetBytes = samples.reduce((sum, sample) => sum + sample.workingSetBytes, 0);
  return {
    atMs: Date.now(),
    cpuPercent,
    workingSetBytes,
    rendererWorkingSetBytes: renderer?.workingSetBytes ?? 0,
    gpuWorkingSetBytes: gpu?.workingSetBytes ?? 0,
    processes: samples.length,
  };
});

async function createWindow(): Promise<void> {
  const window = new BrowserWindow({
    width: 1480,
    height: 940,
    minWidth: 960,
    minHeight: 640,
    show: false,
    title: "Ghosttea Pipeline Lab",
    backgroundColor: "#10110e",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    ...(process.platform === "darwin" ? { trafficLightPosition: { x: 16, y: 18 } } : {}),
    acceptFirstMouse: true,
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

  window.once("ready-to-show", () => window.show());

  if (process.env.ELECTRON_RENDERER_URL) {
    await window.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    await window.loadFile(join(__dirname, "../renderer/index.html"));
  }
}

app.whenReady().then(() => void createWindow());
app.on("window-all-closed", () => app.quit());
