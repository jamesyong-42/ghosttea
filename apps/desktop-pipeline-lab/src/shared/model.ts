export const ARCHITECTURES = ["per-view-scene", "shared-scene", "window-composite", "bitmap-mirrors"] as const;
export type ArchitectureId = (typeof ARCHITECTURES)[number];

export const SCENE_RESOLUTIONS = ["view", "authority", "grid-native"] as const;
export type SceneResolution = (typeof SCENE_RESOLUTIONS)[number];

export const LAYOUTS = ["grid", "stage-and-tiles", "thumbnails"] as const;
export type LayoutId = (typeof LAYOUTS)[number];

export const WORKLOADS = ["hold", "repaint", "blink", "sparse", "flood", "scroll"] as const;
export type WorkloadId = (typeof WORKLOADS)[number];

export const FIT_MODES = ["letterbox", "stretch"] as const;
export type FitMode = (typeof FIT_MODES)[number];

export const EFFECT_SCOPES = ["off", "scene", "view"] as const;
export type EffectScope = (typeof EFFECT_SCOPES)[number];

export interface LabConfig {
  architecture: ArchitectureId;
  sceneResolution: SceneResolution;
  effectScope: EffectScope;
  devicePerView: boolean;
  sessions: number;
  viewsPerSession: number;
  cols: number;
  rows: number;
  cellWidth: number;
  cellHeight: number;
  layout: LayoutId;
  workload: WorkloadId;
  hz: number;
}

export const DEFAULT_LAB_CONFIG: LabConfig = {
  architecture: "shared-scene",
  sceneResolution: "grid-native",
  effectScope: "off",
  devicePerView: false,
  sessions: 1,
  viewsPerSession: 4,
  cols: 80,
  rows: 24,
  cellWidth: 8,
  cellHeight: 16,
  layout: "stage-and-tiles",
  workload: "sparse",
  hz: 60,
};

export interface ArchitectureSpec {
  id: ArchitectureId;
  gate: string;
  title: string;
  claim: string;
  winsWhen: string;
  losesWhen: string;
  scenePasses: string;
  presents: string;
}

export const ARCHITECTURE_SPECS: readonly ArchitectureSpec[] = [
  {
    id: "per-view-scene",
    gate: "PER-VIEW",
    title: "One scene per canvas",
    claim: "Today’s Electron path: each view rebuilds the grid into its own scene texture and swapchain.",
    winsWhen:
      "Every view is a different session, or views are so different in size that a shared texture would just be resampled waste.",
    losesWhen:
      "The same session is shown more than once — deck tile + stage, ICE widget, thumbnail. Scene cost scales with views, not sessions.",
    scenePasses: "sessions × views",
    presents: "N canvases",
  },
  {
    id: "shared-scene",
    gate: "SHARED",
    title: "One scene, N views",
    claim:
      "Decode and paint the grid once per session. Each view is a blit, letterbox, or view-local effect onto its own canvas.",
    winsWhen: "Mirrors of one session. Authority still drives the grid; mirrors never resize the PTY.",
    losesWhen: "Every view is a unique session — then this collapses to per-view plus a blit. N swapchains remain.",
    scenePasses: "sessions",
    presents: "N canvases",
  },
  {
    id: "window-composite",
    gate: "WINDOW",
    title: "One swapchain for the stage",
    claim:
      "One OffscreenCanvas covers the contact sheet. The worker composites every view rect in WebGPU. Chromium sees one layer.",
    winsWhen: "A deck of many tiles, or any layout where CSS-per-canvas layer tax dominates.",
    losesWhen: "You need per-tile CSS clips, rounded corners, transforms, or DOM hit testing on the canvas itself.",
    scenePasses: "sessions (if shared) or views",
    presents: "1 canvas",
  },
  {
    id: "bitmap-mirrors",
    gate: "BITMAP",
    title: "ImageBitmap mirrors",
    claim:
      "Authority stays WebGPU. Mirrors are bitmaprenderer canvases fed snapshots of the scene. Measures the copy hop.",
    winsWhen: "Tiny, static, or rarely updated thumbnails where a copy is cheaper than a second WebGPU context.",
    losesWhen: "Live 60 Hz mirrors — GPU wait + createImageBitmap per view is the thing we expect to lose.",
    scenePasses: "sessions",
    presents: "1 WebGPU + N bitmaps",
  },
];

export interface Recipe {
  id: string;
  title: string;
  question: string;
  patch: Partial<LabConfig>;
}

export const RECIPES: readonly Recipe[] = [
  {
    id: "mirror-tax",
    title: "Mirror tax",
    question: "Does one session × eight views make shared-scene win, or is present still the cost?",
    patch: {
      sessions: 1,
      viewsPerSession: 8,
      layout: "grid",
      workload: "flood",
      sceneResolution: "grid-native",
      effectScope: "off",
      devicePerView: false,
    },
  },
  {
    id: "stranger-deck",
    title: "Deck of strangers",
    question: "Eight different sessions, one view each. Is the Chromium canvas compositor the bottleneck?",
    patch: {
      sessions: 8,
      viewsPerSession: 1,
      layout: "grid",
      workload: "flood",
      sceneResolution: "view",
      effectScope: "off",
      devicePerView: false,
    },
  },
  {
    id: "stage-tiles",
    title: "Stage + tiles",
    question: "The product shape: one authority, many letterboxed mirrors, sparse typing.",
    patch: {
      sessions: 1,
      viewsPerSession: 8,
      layout: "stage-and-tiles",
      workload: "sparse",
      sceneResolution: "grid-native",
      effectScope: "off",
      devicePerView: false,
    },
  },
  {
    id: "present-tax",
    title: "Present tax",
    question: "Sixteen thumbnails, no content change. Does swapping N canvases every vsync show up?",
    patch: {
      sessions: 16,
      viewsPerSession: 1,
      layout: "thumbnails",
      workload: "repaint",
      sceneResolution: "view",
      effectScope: "off",
      devicePerView: false,
      cols: 40,
      rows: 12,
    },
  },
  {
    id: "effect-scope",
    title: "Effect scope",
    question: "CRT on the scene once, or per view? Shared-scene + view effects still pays N fullscreen samples.",
    patch: {
      sessions: 1,
      viewsPerSession: 6,
      layout: "stage-and-tiles",
      workload: "repaint",
      sceneResolution: "grid-native",
      effectScope: "view",
      devicePerView: false,
    },
  },
  {
    id: "device-tax",
    title: "Device tax",
    question: "Negative control. One GPUDevice per view should lose on memory and compile time.",
    patch: {
      architecture: "per-view-scene",
      sessions: 1,
      viewsPerSession: 4,
      layout: "grid",
      workload: "flood",
      sceneResolution: "view",
      effectScope: "off",
      devicePerView: true,
    },
  },
];

export interface ViewRole {
  sessionIndex: number;
  viewIndex: number;
  viewId: string;
  sessionId: string;
  role: "authority" | "mirror";
}

export function expandViews(sessions: number, viewsPerSession: number): ViewRole[] {
  const sessionCount = Math.max(1, Math.trunc(sessions));
  const viewCount = Math.max(1, Math.trunc(viewsPerSession));
  const views: ViewRole[] = [];
  for (let sessionIndex = 0; sessionIndex < sessionCount; sessionIndex += 1) {
    for (let viewIndex = 0; viewIndex < viewCount; viewIndex += 1) {
      views.push({
        sessionIndex,
        viewIndex,
        sessionId: `s${sessionIndex}`,
        viewId: `s${sessionIndex}:v${viewIndex}`,
        role: viewIndex === 0 ? "authority" : "mirror",
      });
    }
  }
  return views;
}

export function usesDomCanvases(architecture: ArchitectureId): boolean {
  return architecture !== "window-composite";
}

export function usesBitmapMirrors(architecture: ArchitectureId): boolean {
  return architecture === "bitmap-mirrors";
}

export function effectiveSceneResolution(config: LabConfig): SceneResolution {
  if (config.architecture === "per-view-scene" && config.sceneResolution === "authority") return "view";
  if (config.architecture !== "per-view-scene" && config.sceneResolution === "view") return "grid-native";
  return config.sceneResolution;
}

export function effectiveDevicePerView(config: LabConfig): boolean {
  return config.architecture === "per-view-scene" && config.devicePerView;
}

export interface FitRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function fitRect(
  sourceWidth: number,
  sourceHeight: number,
  destWidth: number,
  destHeight: number,
  mode: FitMode,
): FitRect {
  const destW = Math.max(0, destWidth);
  const destH = Math.max(0, destHeight);
  if (mode === "stretch" || sourceWidth <= 0 || sourceHeight <= 0 || destW <= 0 || destH <= 0) {
    return { x: 0, y: 0, width: destW, height: destH };
  }
  const scale = Math.min(destW / sourceWidth, destH / sourceHeight);
  const width = sourceWidth * scale;
  const height = sourceHeight * scale;
  return { x: (destW - width) / 2, y: (destH - height) / 2, width, height };
}

/** Place a cols×rows grid of fixed-aspect cells inside a pixel box. Integer zoom when it fits. */
export function fitGrid(
  cols: number,
  rows: number,
  cellWidth: number,
  cellHeight: number,
  destWidth: number,
  destHeight: number,
): FitRect & { scale: number; cellW: number; cellH: number } {
  const nativeW = Math.max(1, cols * cellWidth);
  const nativeH = Math.max(1, rows * cellHeight);
  const destW = Math.max(1, destWidth);
  const destH = Math.max(1, destHeight);
  let scale = Math.min(destW / nativeW, destH / nativeH);
  if (scale >= 1) scale = Math.floor(scale);
  const cellW = cellWidth * scale;
  const cellH = cellHeight * scale;
  const width = cols * cellW;
  const height = rows * cellH;
  return {
    x: (destW - width) / 2,
    y: (destH - height) / 2,
    width,
    height,
    scale,
    cellW,
    cellH,
  };
}

export function gridNativeSize(
  config: Pick<LabConfig, "cols" | "rows" | "cellWidth" | "cellHeight">,
  dpr: number,
): {
  width: number;
  height: number;
} {
  const scale = Math.max(1, dpr);
  return {
    width: Math.max(1, Math.round(config.cols * config.cellWidth * scale)),
    height: Math.max(1, Math.round(config.rows * config.cellHeight * scale)),
  };
}

export function sessionHue(sessionIndex: number): number {
  return (sessionIndex * 47 + 18) % 360;
}

export interface WorkerCounters {
  flushes: number;
  scenePasses: number;
  blitPasses: number;
  effectPasses: number;
  swapchainAcquires: number;
  queueSubmits: number;
  cellsDrawn: number;
  uploadBytes: number;
  bitmapTransfers: number;
  devices: number;
  sceneTextures: number;
  canvasContexts: number;
  renderCpuMs: number[];
  flushIntervalsMs: number[];
}

export function emptyWorkerCounters(): WorkerCounters {
  return {
    flushes: 0,
    scenePasses: 0,
    blitPasses: 0,
    effectPasses: 0,
    swapchainAcquires: 0,
    queueSubmits: 0,
    cellsDrawn: 0,
    uploadBytes: 0,
    bitmapTransfers: 0,
    devices: 0,
    sceneTextures: 0,
    canvasContexts: 0,
    renderCpuMs: [],
    flushIntervalsMs: [],
  };
}

export interface ProcessSample {
  atMs: number;
  cpuPercent: number;
  workingSetBytes: number;
}

export interface LabRun {
  id: string;
  at: number;
  config: LabConfig;
  durationMs: number;
  counters: WorkerCounters;
  process: {
    cpuPercent: number;
    workingSetBytes: number;
    samples: number;
  };
}

export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index] ?? null;
}

export function mean(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
}

export function formatMs(value: number | null): string {
  if (value === null) return "—";
  return `${value.toFixed(2)} ms`;
}

export function clampConfig(config: LabConfig): LabConfig {
  return {
    ...config,
    sessions: Math.min(32, Math.max(1, Math.trunc(config.sessions))),
    viewsPerSession: Math.min(16, Math.max(1, Math.trunc(config.viewsPerSession))),
    cols: Math.min(240, Math.max(20, Math.trunc(config.cols))),
    rows: Math.min(80, Math.max(6, Math.trunc(config.rows))),
    cellWidth: Math.min(16, Math.max(6, Math.trunc(config.cellWidth))),
    cellHeight: Math.min(24, Math.max(10, Math.trunc(config.cellHeight))),
    hz: Math.min(120, Math.max(1, Math.trunc(config.hz))),
    devicePerView: effectiveDevicePerView(config),
    sceneResolution: effectiveSceneResolution(config),
  };
}
