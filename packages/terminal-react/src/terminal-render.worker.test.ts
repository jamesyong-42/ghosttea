import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

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

  it("routes redraws through session membership and removes stale memberships", async () => {
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
    const settle = (): Promise<unknown> => new Promise((resolve) => setTimeout(resolve, 0));

    dispatch({ type: "renderer-config", forceCanvasFallback: true });
    dispatch({ type: "mount", surfaceId: "view-a", sessionHandle: "session-a", canvas: {} });
    dispatch({ type: "mount", surfaceId: "view-b", sessionHandle: "session-a", canvas: {} });
    dispatch({ type: "mount", surfaceId: "view-c", sessionHandle: "session-b", canvas: {} });
    await settle();
    renderer.renderBatch.mockClear();

    dispatch({ type: "force-full-redraw", sessionHandle: "session-a" });
    await settle();
    expect(renderer.renderBatch).toHaveBeenLastCalledWith([
      expect.objectContaining({ id: "view-a" }),
      expect.objectContaining({ id: "view-b" }),
    ]);

    renderer.renderBatch.mockClear();
    dispatch({ type: "unmount", surfaceId: "view-a" });
    dispatch({ type: "force-full-redraw", sessionHandle: "session-a" });
    await settle();
    expect(renderer.renderBatch).toHaveBeenLastCalledWith([expect.objectContaining({ id: "view-b" })]);

    renderer.renderBatch.mockClear();
    dispatch({ type: "drop-session", sessionHandle: "session-a" });
    dispatch({ type: "force-full-redraw", sessionHandle: "session-a" });
    await settle();
    expect(renderer.unmount).toHaveBeenCalledWith("view-b");
    expect(renderer.renderBatch).not.toHaveBeenCalled();

    dispatch({ type: "force-full-redraw", sessionHandle: "session-b" });
    await settle();
    expect(renderer.renderBatch).toHaveBeenLastCalledWith([expect.objectContaining({ id: "view-c" })]);
  });
});
