import { afterEach, describe, expect, it, vi } from "vitest";

const renderer = vi.hoisted(() => ({
  mount: vi.fn(),
  unmount: vi.fn(),
  resize: vi.fn(),
  render: vi.fn(),
  renderBatch: vi.fn(() => []),
}));

vi.mock("./renderers/canvas-renderer.js", () => ({
  CanvasTerminalRenderer: class {
    readonly kind = "canvas2d" as const;
    readonly mount = renderer.mount;
    readonly unmount = renderer.unmount;
    readonly resize = renderer.resize;
    readonly render = renderer.render;
    readonly renderBatch = renderer.renderBatch;
  },
}));

vi.mock("./renderers/webgpu-renderer.js", () => ({
  WebGpuTerminalRenderer: class {
    static create(): Promise<never> {
      return Promise.reject(new Error("WebGPU disabled by test"));
    }
  },
}));

describe("terminal render worker surfaces", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("mounts and redraws multiple surfaces backed by one session snapshot", async () => {
    const workerScope = {
      onmessage: null as ((event: MessageEvent) => void) | null,
      postMessage: vi.fn(),
      requestAnimationFrame: (callback: FrameRequestCallback): number => {
        callback(performance.now());
        return 1;
      },
    };
    vi.stubGlobal("self", workerScope);
    await import("./terminal-render.worker.js");
    const dispatch = (data: unknown): void => workerScope.onmessage?.({ data } as MessageEvent);

    dispatch({ type: "renderer-config", forceCanvasFallback: true });
    dispatch({ type: "mount", surfaceId: "view-a", sessionHandle: "session", canvas: {} });
    dispatch({ type: "mount", surfaceId: "view-b", sessionHandle: "session", canvas: {} });
    await new Promise((resolve) => setTimeout(resolve, 0));
    dispatch({ type: "force-full-redraw", sessionHandle: "session" });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(renderer.mount.mock.calls.map(([surfaceId]) => surfaceId)).toEqual(["view-a", "view-b"]);
    expect(renderer.renderBatch).toHaveBeenCalledWith([
      expect.objectContaining({ id: "view-a" }),
      expect.objectContaining({ id: "view-b" }),
    ]);
  });
});
