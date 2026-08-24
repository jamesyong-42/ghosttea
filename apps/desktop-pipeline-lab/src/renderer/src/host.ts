import type { HostToWorker, SlotLayout, ViewMountSpec, WorkerToHost } from "../../shared/messages";
import {
  clampConfig,
  expandViews,
  usesBitmapMirrors,
  usesDomCanvases,
  type LabConfig,
  type WorkerCounters,
} from "../../shared/model";

export class PipelineHost {
  #worker: Worker;
  #ready: Promise<string>;
  #readyResolve: (adapter: string) => void = () => undefined;
  #measures = new Map<number, (result: { durationMs: number; counters: WorkerCounters }) => void>();
  #requestId = 1;
  adapter = "starting";
  onError: ((message: string) => void) | undefined;

  constructor() {
    this.#worker = new Worker(new URL("./pipeline.worker.ts", import.meta.url), { type: "module" });
    this.#ready = new Promise((resolve) => {
      this.#readyResolve = resolve;
    });
    this.#worker.onmessage = (event: MessageEvent<WorkerToHost>) => {
      const message = event.data;
      if (message.type === "ready") {
        this.adapter = message.adapter;
        this.#readyResolve(message.adapter);
      } else if (message.type === "error") {
        this.onError?.(message.message);
      } else if (message.type === "measure-result") {
        this.#measures.get(message.requestId)?.({ durationMs: message.durationMs, counters: message.counters });
        this.#measures.delete(message.requestId);
      }
    };
  }

  async configure(config: LabConfig): Promise<string> {
    this.#ready = new Promise((resolve) => {
      this.#readyResolve = resolve;
    });
    this.#post({ type: "configure", config: clampConfig(config) });
    return this.#ready;
  }

  mountViews(
    config: LabConfig,
    canvases: Map<string, OffscreenCanvas>,
    sizes: Map<string, { width: number; height: number; dpr: number }>,
  ): void {
    const views = expandViews(config.sessions, config.viewsPerSession);
    const specs: ViewMountSpec[] = [];
    const transferred: OffscreenCanvas[] = [];
    for (const view of views) {
      const canvas = canvases.get(view.viewId);
      const size = sizes.get(view.viewId);
      if (!canvas || !size) continue;
      specs.push({
        ...view,
        width: size.width,
        height: size.height,
        dpr: size.dpr,
        bitmap: usesBitmapMirrors(config.architecture) && view.role === "mirror",
      });
      transferred.push(canvas);
    }
    this.#post({ type: "mount-views", views: specs, canvases: transferred }, transferred);
  }

  mountStage(canvas: OffscreenCanvas, width: number, height: number, dpr: number): void {
    this.#post({ type: "mount-stage", canvas, width, height, dpr }, [canvas]);
  }

  layout(slots: SlotLayout[], stageWidth: number, stageHeight: number, stageDpr: number): void {
    this.#post({ type: "layout", slots, stageWidth, stageHeight, stageDpr });
  }

  resizeView(viewId: string, width: number, height: number, dpr: number): void {
    this.#post({ type: "resize-view", viewId, width, height, dpr });
  }

  usesCanvases(config: LabConfig): boolean {
    return usesDomCanvases(config.architecture);
  }

  async measure(durationMs: number): Promise<{ durationMs: number; counters: WorkerCounters }> {
    const requestId = this.#requestId++;
    const result = new Promise<{ durationMs: number; counters: WorkerCounters }>((resolve) => {
      this.#measures.set(requestId, resolve);
    });
    this.#post({ type: "measure-start", requestId });
    await new Promise((resolve) => window.setTimeout(resolve, durationMs));
    this.#post({ type: "measure-stop", requestId });
    return result;
  }

  #post(message: HostToWorker, transfer: Transferable[] = []): void {
    this.#worker.postMessage(message, transfer);
  }
}
