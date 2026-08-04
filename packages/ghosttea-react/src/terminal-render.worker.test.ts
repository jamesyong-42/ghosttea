import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const renderer = vi.hoisted(() => ({
  mount: vi.fn(),
  unmount: vi.fn(),
  resize: vi.fn(),
  render: vi.fn(),
  renderBatch: vi.fn((_entries: ReadonlyArray<{ id: string; view: { effects?: unknown } }>) => []),
}));

const webgpu = vi.hoisted(() => ({ enabled: false }));

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
    static async create() {
      if (!webgpu.enabled) throw new Error("WebGPU disabled by test");
      return {
        kind: "webgpu" as const,
        mount: renderer.mount,
        unmount: renderer.unmount,
        resize: renderer.resize,
        render: renderer.render,
        renderBatch: renderer.renderBatch,
      };
    }
  },
}));

describe("terminal render worker surfaces", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    webgpu.enabled = false;
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

  it("keeps shader effects isolated between two surfaces for one session", async () => {
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
    const localEffects = {
      postProcess: "none",
      shaderEffects: ["ghosttea:vhs"],
      animate: true,
    } as const;
    const configEffects = {
      postProcess: "none",
      shaderEffects: ["ghosttea:crt"],
      animate: false,
    } as const;

    dispatch({ type: "renderer-config", forceCanvasFallback: true });
    dispatch({ type: "mount", surfaceId: "view-local", sessionHandle: "session", canvas: {} });
    dispatch({ type: "mount", surfaceId: "view-config", sessionHandle: "session", canvas: {} });
    await settle();
    dispatch({ type: "effects", surfaceId: "view-local", sessionHandle: "session", effects: localEffects });
    dispatch({ type: "effects", surfaceId: "view-config", sessionHandle: "session", effects: configEffects });
    await settle();
    renderer.renderBatch.mockClear();

    dispatch({ type: "force-full-redraw", sessionHandle: "session" });
    await settle();

    const entries = renderer.renderBatch.mock.calls.at(-1)?.[0] as
      Array<{ id: string; view: { effects: unknown } }> | undefined;
    expect(entries?.find((entry) => entry.id === "view-local")?.view.effects).toEqual(localEffects);
    expect(entries?.find((entry) => entry.id === "view-config")?.view.effects).toEqual(configEffects);
  });

  it("does not schedule shader animation for an occluded surface", async () => {
    webgpu.enabled = true;
    const animationFrames: FrameRequestCallback[] = [];
    const requestAnimationFrame = vi.fn((callback: FrameRequestCallback): number => {
      animationFrames.push(callback);
      return animationFrames.length;
    });
    const workerScope = {
      onmessage: null as ((event: MessageEvent) => void) | null,
      postMessage: vi.fn(),
      requestAnimationFrame,
    };
    vi.stubGlobal("self", workerScope);
    await import("./terminal-render.worker.js");
    const dispatch = (data: unknown): void => workerScope.onmessage?.({ data } as MessageEvent);
    const settle = (): Promise<unknown> => new Promise((resolve) => setTimeout(resolve, 0));

    dispatch({ type: "renderer-config", forceCanvasFallback: false });
    dispatch({ type: "mount", surfaceId: "hidden-view", sessionHandle: "session", canvas: {} });
    await settle();
    expect(workerScope.postMessage).toHaveBeenCalledWith({ type: "renderer-status", backend: "webgpu" });
    while (animationFrames.length > 0) animationFrames.shift()!(performance.now());
    await settle();
    requestAnimationFrame.mockClear();

    dispatch({ type: "visibility", surfaceId: "hidden-view", sessionHandle: "session", visible: false });
    dispatch({ type: "focus", surfaceId: "hidden-view", sessionHandle: "session", focused: true });
    dispatch({
      type: "effects",
      surfaceId: "hidden-view",
      sessionHandle: "session",
      effects: { postProcess: "none", shaderEffects: ["ghosttea:vhs"], animate: true },
    });
    await settle();

    expect(requestAnimationFrame).not.toHaveBeenCalled();
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

  it("returns byte credits after frame processing and requests full state after a transport gap", async () => {
    const workerScope = {
      onmessage: null as ((event: MessageEvent) => void) | null,
      postMessage: vi.fn(),
      requestAnimationFrame: (callback: FrameRequestCallback): number => {
        callback(performance.now());
        return 1;
      },
    };
    vi.stubGlobal("self", workerScope);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await import("./terminal-render.worker.js");
    const dispatch = (data: unknown): void => workerScope.onmessage?.({ data } as MessageEvent);

    dispatch({ type: "frame-gap", sessionHandles: ["session-a", "session-b"] });
    dispatch({ type: "frame", packet: new ArrayBuffer(7) });
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(workerScope.postMessage).toHaveBeenCalledWith({
      type: "frame-resync-needed",
      sessionHandle: "session-a",
    });
    expect(workerScope.postMessage).toHaveBeenCalledWith({
      type: "frame-resync-needed",
      sessionHandle: "session-b",
    });
    expect(workerScope.postMessage).toHaveBeenCalledWith({ type: "frame-credit", bytes: 7 });
    error.mockRestore();
  });
});
