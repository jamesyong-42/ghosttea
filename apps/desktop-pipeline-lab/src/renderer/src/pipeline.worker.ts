/// <reference lib="webworker" />
/// <reference types="@webgpu/types" />

import type { HostToWorker, WorkerToHost } from "../../shared/messages";
import { PipelineEngine } from "./gpu";

const engine = new PipelineEngine();
let running = false;
let measureStarted = 0;
let lastWorkloadAt = 0;

function post(message: WorkerToHost): void {
  self.postMessage(message);
}

function schedule(): void {
  if (running) return;
  running = true;
  const tick = (now: number): void => {
    self.requestAnimationFrame(tick);
    const interval = 1000 / Math.max(1, engine.config.hz);
    if (engine.config.workload !== "hold" && now - lastWorkloadAt >= interval) {
      engine.tick(now);
      lastWorkloadAt = now;
    }
    if (engine.needsContinuousPresent() || engine.counters.flushes === 0) {
      void engine.flush(now).catch((error: unknown) => {
        post({ type: "error", message: error instanceof Error ? error.message : String(error) });
      });
    }
  };
  self.requestAnimationFrame(tick);
}

self.onmessage = (event: MessageEvent<HostToWorker>) => {
  const message = event.data;
  void (async () => {
    try {
      if (message.type === "configure") {
        await engine.init();
        await engine.configure(message.config);
        post({ type: "ready", adapter: engine.adapterName });
        return;
      }
      if (message.type === "mount-stage") {
        engine.mountStage(message.canvas, message.width, message.height, message.dpr);
        schedule();
        return;
      }
      if (message.type === "mount-views") {
        await engine.mountViews(message.views, message.canvases);
        schedule();
        post({
          type: "status",
          running: true,
          views: message.views.length,
          sessions: new Set(message.views.map((view) => view.sessionId)).size,
        });
        return;
      }
      if (message.type === "layout") {
        engine.layout(message.slots, message.stageWidth, message.stageHeight, message.stageDpr);
        if (engine.config.architecture === "window-composite") schedule();
        return;
      }
      if (message.type === "resize-view") {
        engine.resizeView(message.viewId, message.width, message.height, message.dpr);
        return;
      }
      if (message.type === "measure-start") {
        measureStarted = performance.now();
        engine.snapshotAndReset(0);
        schedule();
        return;
      }
      if (message.type === "measure-stop") {
        const durationMs = performance.now() - measureStarted;
        const counters = engine.snapshotAndReset(durationMs);
        post({ type: "measure-result", requestId: message.requestId, durationMs, counters });
        return;
      }
    } catch (error) {
      post({ type: "error", message: error instanceof Error ? error.message : String(error) });
    }
  })();
};
