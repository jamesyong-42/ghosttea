export {};

declare global {
  interface Window {
    pipelineLab: {
      platform: string;
      sampleProcess: () => Promise<{
        atMs: number;
        cpuPercent: number;
        workingSetBytes: number;
        rendererWorkingSetBytes: number;
        gpuWorkingSetBytes: number;
        processes: number;
      }>;
    };
  }
}
