export interface RenderBenchmarkCase {
  name: string;
  panes: number;
  kind: "idle" | "repaint" | "payload" | "interactive" | "resize";
  payloadPath?: string;
  payloadBytes?: number;
  durationMs?: number;
  chunkBytes?: number;
  chunkBytesSequence?: number[];
  intervalMs?: number;
  operations?: number;
  seed?: number;
  source?: string;
  resizeDelta?: number;
  inputText?: string;
}

export interface RenderBenchmarkConfig {
  schemaVersion: 1;
  suite: string;
  width: number;
  height: number;
  cols: number;
  rows: number;
  warmupIterations: number;
  measuredIterations: number;
  cooldownMs: number;
  quietMs: number;
  startDelayMs?: number;
  workloadExecutable: string;
  workloadScript: string;
  verifyPixels?: boolean;
  forceFullRendering?: boolean;
  cases: RenderBenchmarkCase[];
  runner: Record<string, unknown>;
}

export interface ElectronProcessSample {
  atMs: number;
  thermalState: string;
  processes: Array<{
    pid: number;
    type: string;
    name?: string;
    serviceName?: string;
    cpuPercent: number;
    idleWakeupsPerSecond: number;
    workingSetBytes: number;
  }>;
}

export interface ElectronCaseSamples {
  caseName: string;
  iteration: number;
  samples: ElectronProcessSample[];
}
