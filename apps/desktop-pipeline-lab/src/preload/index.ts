import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("pipelineLab", {
  platform: process.platform,
  sampleProcess: () => ipcRenderer.invoke("lab-process-sample") as Promise<ProcessSample>,
});

interface ProcessSample {
  atMs: number;
  cpuPercent: number;
  workingSetBytes: number;
  rendererWorkingSetBytes: number;
  gpuWorkingSetBytes: number;
  processes: number;
}

declare global {
  interface Window {
    pipelineLab: {
      platform: string;
      sampleProcess: () => Promise<ProcessSample>;
    };
  }
}
