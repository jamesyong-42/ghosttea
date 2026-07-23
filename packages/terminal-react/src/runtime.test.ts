import { afterEach, describe, expect, it, vi } from "vitest";
import { unknownSessionActivity, type SessionSummary } from "@vibecook/ghosttea-protocol";
import { GhostteaTerminalRuntime } from "./runtime";

class FakeWorker extends EventTarget {
  readonly messages: unknown[] = [];
  terminated = false;

  postMessage(message: unknown): void {
    this.messages.push(message);
  }

  terminate(): void {
    this.terminated = true;
  }
}

class FakePort extends EventTarget {
  readonly messages: Array<Record<string, unknown>> = [];
  attachReadWrite = true;
  subscriptionAcknowledgements = true;
  helloProtocolMinor: number | undefined;
  closed = false;
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;

  postMessage(message: Record<string, unknown>): void {
    this.messages.push(message);
    const requestId = Number(message.requestId);
    if (message.type === "hello") {
      this.dispatchEvent(
        new MessageEvent("message", {
          data: {
            requestId,
            type: "hello",
            protocolMajor: message.protocolMajor,
            protocolMinor: this.helloProtocolMinor ?? message.protocolMinor,
            serverBuild: "test",
          },
        }),
      );
    } else if (message.type === "subscribe" && this.subscriptionAcknowledgements) {
      this.onmessage?.(
        new MessageEvent("message", {
          data: { type: "subscription-ack", requestId },
        }),
      );
    } else if (message.type === "attach-session") {
      this.dispatchEvent(
        new MessageEvent("message", {
          data: {
            requestId,
            type: "view-attached",
            sessionId: message.sessionId,
            viewId: message.viewId,
            attachmentEpoch: requestId,
            readWrite: this.attachReadWrite,
          },
        }),
      );
    } else if (message.type === "selection-text") {
      this.dispatchEvent(
        new MessageEvent("message", {
          data: { requestId, type: "selection-text", text: "copied from terminal" },
        }),
      );
    }
  }

  start(): void {}
  close(): void {
    this.closed = true;
  }
}

function canvas(): HTMLCanvasElement {
  return {
    transferControlToOffscreen: () => ({}) as OffscreenCanvas,
  } as HTMLCanvasElement;
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 4; index += 1) await Promise.resolve();
}

const session = {
  id: "session",
  handle: "handle",
  executable: "/bin/zsh",
  cols: 80,
  rows: 24,
  exited: false,
  readWrite: true,
  title: null,
  cwd: null,
  bellCount: 0,
  pid: 1,
  createdAtMs: 1,
  exitCode: null,
  exitSignal: null,
  requestedTermination: null,
  exitOutcome: null,
  ownerId: null,
  activity: unknownSessionActivity(),
} as const;

function controlChanged(control: FakePort, controllerViewId: string, cols: number, rows: number): void {
  control.dispatchEvent(
    new MessageEvent("message", {
      data: {
        requestId: 0,
        type: "control-changed",
        sessionId: session.id,
        controllerViewId,
        controlEpoch: 7,
        cols,
        rows,
        layoutEpoch: 2,
      },
    }),
  );
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("GhostteaTerminalRuntime mount ownership", () => {
  it("round-trips isolated performance measurements through the render worker", async () => {
    vi.stubGlobal("window", globalThis);
    const worker = new FakeWorker();
    const runtime = new GhostteaTerminalRuntime({
      ports: { control: new FakePort() as unknown as MessagePort, frames: new FakePort() as unknown as MessagePort },
      platform: {
        writeClipboard: () => undefined,
        forceCanvasFallback: () => false,
        setForceCanvasFallback: () => undefined,
        reload: () => undefined,
      },
      workerFactory: () => worker as unknown as Worker,
    });

    runtime.setPartialRenderingEnabled(false);
    expect(worker.messages.at(-1)).toEqual({ type: "partial-rendering", enabled: false });
    runtime.forceFullRedraw("pane-handle");
    expect(worker.messages.at(-1)).toEqual({ type: "force-full-redraw", sessionHandle: "pane-handle" });
    runtime.forceRowRedraw("pane-handle", 7);
    expect(worker.messages.at(-1)).toEqual({ type: "force-row-redraw", sessionHandle: "pane-handle", row: 7 });

    const started = runtime.startPerformanceMeasurement();
    const startMessage = worker.messages.at(-1) as { requestId: number; type: string };
    expect(startMessage.type).toBe("performance-start");
    worker.dispatchEvent(
      new MessageEvent("message", { data: { type: "performance-started", requestId: startMessage.requestId } }),
    );
    await expect(started).resolves.toBeUndefined();

    const finished = runtime.finishPerformanceMeasurement({ quietMs: 50, timeoutMs: 1_000 });
    const finishMessage = worker.messages.at(-1) as { requestId: number; type: string };
    expect(finishMessage).toMatchObject({ type: "performance-finish", quietMs: 50, timeoutMs: 1_050 });
    const snapshot = {
      backend: "webgpu",
      durationMs: 100,
      timedOutWaitingForIdle: false,
      gpuQueueDrainMs: 1,
      frames: {
        received: 1,
        bytes: 16,
        full: 1,
        incremental: 0,
        stale: 0,
        resyncRequested: 0,
        rowsDecoded: 24,
        glyphDefinitions: 10,
      },
      scheduling: { flushes: 1, renderCalls: 1, maximumDirtyPanes: 1, panesPerFlush: [1] },
      renderer: {
        queueSubmits: 1,
        fullRenders: 1,
        partialRenders: 0,
        damagedRows: 24,
        geometryCacheHits: 0,
        geometryCacheMisses: 0,
        canvasPixelFrames: 100,
        renderPasses: 2,
        drawCalls: 2,
        rectangleVertices: 6,
        monoGlyphVertices: 6,
        colorGlyphVertices: 0,
        fallbackGlyphVertices: 0,
        vertexUploadBytes: 336,
        atlasUploadBytes: 0,
        atlasUploadCalls: 0,
      },
      samples: { frameApplyMs: [1], renderCpuMs: [2], dirtyToRenderMs: [8], frameArrivalToRenderMs: [9] },
    };
    worker.dispatchEvent(
      new MessageEvent("message", {
        data: { type: "performance-result", requestId: finishMessage.requestId, snapshot },
      }),
    );
    await expect(finished).resolves.toEqual(snapshot);
    runtime.dispose();
  });

  it("copies stable terminal-owned selection text through the platform clipboard", async () => {
    vi.stubGlobal("window", globalThis);
    const worker = new FakeWorker();
    const writeClipboard = vi.fn();
    const runtime = new GhostteaTerminalRuntime({
      ports: { control: new FakePort() as unknown as MessagePort, frames: new FakePort() as unknown as MessagePort },
      platform: {
        writeClipboard,
        forceCanvasFallback: () => false,
        setForceCanvasFallback: () => undefined,
        reload: () => undefined,
      },
      workerFactory: () => worker as unknown as Worker,
    });
    await runtime.connect();
    runtime.registerSession(session);
    runtime.mount(session.id, session.handle, "view-1", canvas());
    await flushMicrotasks();
    const selection = { anchor: { column: 1, row: 42 }, focus: { column: 4, row: 45 } };

    await expect(runtime.copySelection(session.id, "view-1", selection)).resolves.toBe("copied from terminal");
    expect(writeClipboard).toHaveBeenCalledOnce();
    expect(writeClipboard).toHaveBeenCalledWith("copied from terminal");
  });

  it("publishes scrollbar state and sends absolute scroll positions through the attached view", async () => {
    vi.stubGlobal("window", globalThis);
    const worker = new FakeWorker();
    const control = new FakePort();
    const frames = new FakePort();
    const runtime = new GhostteaTerminalRuntime({
      ports: { control: control as unknown as MessagePort, frames: frames as unknown as MessagePort },
      platform: {
        writeClipboard: () => undefined,
        forceCanvasFallback: () => false,
        setForceCanvasFallback: () => undefined,
        reload: () => undefined,
      },
      workerFactory: () => worker as unknown as Worker,
    });
    await runtime.connect();
    runtime.registerSession(session);
    runtime.mount(session.id, session.handle, "view-1", canvas());
    await flushMicrotasks();

    const observed: unknown[] = [];
    runtime.addEventListener("scrollbar-state", (event) => observed.push((event as CustomEvent).detail));
    worker.dispatchEvent(
      new MessageEvent("message", {
        data: {
          type: "scrollbar-state",
          sessionHandle: session.handle,
          scrollbar: { total: 100, offset: 52, length: 24 },
        },
      }),
    );
    runtime.scrollTo(session.id, "view-1", 18);

    expect(runtime.scrollbar(session.handle)).toEqual({ total: 100, offset: 52, length: 24 });
    expect(observed).toEqual([{ sessionHandle: session.handle, scrollbar: { total: 100, offset: 52, length: 24 } }]);
    expect(control.messages).toContainEqual({
      requestId: 0,
      type: "scroll-to",
      sessionId: session.id,
      viewId: "view-1",
      attachmentEpoch: 2,
      inputSequence: 1,
      row: 18,
    });
  });

  it("forwards tab visibility to the renderer without detaching the terminal view", async () => {
    vi.stubGlobal("window", globalThis);
    const worker = new FakeWorker();
    const control = new FakePort();
    const frames = new FakePort();
    const runtime = new GhostteaTerminalRuntime({
      ports: { control: control as unknown as MessagePort, frames: frames as unknown as MessagePort },
      platform: {
        writeClipboard: () => undefined,
        forceCanvasFallback: () => false,
        setForceCanvasFallback: () => undefined,
        reload: () => undefined,
      },
      workerFactory: () => worker as unknown as Worker,
    });
    await runtime.connect();

    runtime.setVisible("handle", false);
    runtime.setVisible("handle", true);

    expect(worker.messages).toContainEqual({ type: "visibility", sessionHandle: "handle", visible: false });
    expect(worker.messages).toContainEqual({ type: "visibility", sessionHandle: "handle", visible: true });
    expect(control.messages.some((message) => message.type === "detach-session")).toBe(false);
  });

  it("subscribes the frame bridge only while a session is mounted", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("window", globalThis);
    const frames = new FakePort();
    const runtime = new GhostteaTerminalRuntime({
      ports: { control: new FakePort() as unknown as MessagePort, frames: frames as unknown as MessagePort },
      platform: {
        writeClipboard: () => undefined,
        forceCanvasFallback: () => false,
        setForceCanvasFallback: () => undefined,
        reload: () => undefined,
      },
      workerFactory: () => new FakeWorker() as unknown as Worker,
    });
    await runtime.connect();
    runtime.registerSession(session);
    expect(
      frames.messages.filter((message) => message.type === "subscribe").map((message) => message.sessionHandles),
    ).toEqual([[]]);
    const mount = runtime.mount(session.id, session.handle, "view-subscription", canvas());
    await flushMicrotasks();

    expect(
      frames.messages.filter((message) => message.type === "subscribe").map((message) => message.sessionHandles),
    ).toEqual([[], [session.handle]]);

    mount.dispose();
    await vi.advanceTimersByTimeAsync(1_001);
    expect(frames.messages.at(-1)).toMatchObject({ type: "subscribe", sessionHandles: [] });
  });

  it("keeps older daemons responsive without enabling unsupported frame credits", async () => {
    vi.stubGlobal("window", globalThis);
    const worker = new FakeWorker();
    const control = new FakePort();
    const frames = new FakePort();
    control.helloProtocolMinor = 6;
    frames.subscriptionAcknowledgements = false;
    const runtime = new GhostteaTerminalRuntime({
      ports: { control: control as unknown as MessagePort, frames: frames as unknown as MessagePort },
      platform: {
        writeClipboard: () => undefined,
        forceCanvasFallback: () => false,
        setForceCanvasFallback: () => undefined,
        reload: () => undefined,
      },
      workerFactory: () => worker as unknown as Worker,
    });

    await runtime.connect();
    runtime.registerSession(session);
    runtime.mount(session.id, session.handle, "legacy-view", canvas());
    await flushMicrotasks();
    worker.dispatchEvent(new MessageEvent("message", { data: { type: "frame-credit", bytes: 512 } }));

    expect(control.messages).toContainEqual(
      expect.objectContaining({ type: "attach-session", sessionId: session.id, viewId: "legacy-view" }),
    );
    expect(frames.messages.filter((message) => message.type === "subscribe")).not.toContainEqual(
      expect.objectContaining({ frameCredits: true }),
    );
    expect(frames.messages.some((message) => message.type === "frame-credit")).toBe(false);
  });

  it("unregisters renderer state without terminating the underlying PTY", async () => {
    vi.stubGlobal("window", globalThis);
    const worker = new FakeWorker();
    const control = new FakePort();
    const frames = new FakePort();
    const runtime = new GhostteaTerminalRuntime({
      ports: { control: control as unknown as MessagePort, frames: frames as unknown as MessagePort },
      platform: {
        writeClipboard: () => undefined,
        forceCanvasFallback: () => false,
        setForceCanvasFallback: () => undefined,
        reload: () => undefined,
      },
      workerFactory: () => worker as unknown as Worker,
    });
    await runtime.connect();
    runtime.registerSession(session);
    runtime.mount(session.id, session.handle, "view-unregister", canvas());
    await flushMicrotasks();

    runtime.unregisterSession(session.id);

    expect(control.messages.some((message) => message.type === "terminate")).toBe(false);
    expect(control.messages).toContainEqual({
      requestId: 0,
      type: "detach-session",
      sessionId: session.id,
      viewId: "view-unregister",
    });
    expect(runtime.sessionMetadata(session.handle)).toBeUndefined();
    expect(worker.messages).toContainEqual({ type: "drop-session", sessionHandle: session.handle });
    expect(frames.messages.at(-1)).toMatchObject({ type: "subscribe", sessionHandles: [] });
  });

  it("applies unsolicited activity changes without waiting for a terminal frame", async () => {
    vi.stubGlobal("window", globalThis);
    const control = new FakePort();
    const runtime = new GhostteaTerminalRuntime({
      ports: { control: control as unknown as MessagePort, frames: new FakePort() as unknown as MessagePort },
      platform: {
        writeClipboard: () => undefined,
        forceCanvasFallback: () => false,
        setForceCanvasFallback: () => undefined,
        reload: () => undefined,
      },
      workerFactory: () => new FakeWorker() as unknown as Worker,
    });
    await runtime.connect();
    runtime.registerSession(session);
    const activities: unknown[] = [];
    const metadata: SessionSummary[] = [];
    runtime.addEventListener("session-activity", (event) => activities.push((event as CustomEvent).detail));
    runtime.addEventListener("session-metadata", (event) =>
      metadata.push((event as CustomEvent<SessionSummary>).detail),
    );

    const activity = {
      kind: "foreground-job",
      source: "process-group",
      confidence: "heuristic",
      rootProcessGroupId: 42,
      foregroundProcessGroupId: 43,
      observedAtMs: 100,
    } as const;
    control.dispatchEvent(
      new MessageEvent("message", {
        data: {
          requestId: 0,
          type: "session-activity-changed",
          sessionId: session.id,
          activity,
        },
      }),
    );

    expect(runtime.sessionMetadata(session.handle)?.activity).toEqual(activity);
    expect(activities).toEqual([{ requestId: 0, type: "session-activity-changed", sessionId: session.id, activity }]);
    expect(metadata.at(-1)?.activity).toEqual(activity);
  });

  it("cancels metadata refreshes and preserves complete exit metadata when a session exits", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("window", globalThis);
    const control = new FakePort();
    const frames = new FakePort();
    const runtime = new GhostteaTerminalRuntime({
      ports: { control: control as unknown as MessagePort, frames: frames as unknown as MessagePort },
      platform: {
        writeClipboard: () => undefined,
        forceCanvasFallback: () => false,
        setForceCanvasFallback: () => undefined,
        reload: () => undefined,
      },
      workerFactory: () => new FakeWorker() as unknown as Worker,
    });
    await runtime.connect();
    const exitingSession = { ...session, handle: "7" };
    runtime.registerSession(exitingSession);
    runtime.setSessionPinned(exitingSession.handle, true);
    const updates: SessionSummary[] = [];
    runtime.addEventListener("session-metadata", (event) =>
      updates.push((event as CustomEvent<SessionSummary>).detail),
    );

    const frame = new ArrayBuffer(16);
    new DataView(frame).setBigUint64(8, BigInt(exitingSession.handle), true);
    frames.onmessage?.(new MessageEvent("message", { data: frame }));
    control.dispatchEvent(
      new MessageEvent("message", {
        data: {
          requestId: 0,
          type: "session-exited",
          sessionId: exitingSession.id,
          exitCode: null,
          exitSignal: "SIGTERM",
          requestedTermination: "user",
          exitOutcome: "user-terminated",
        },
      }),
    );
    await vi.advanceTimersByTimeAsync(250);

    expect(control.messages.some((message) => message.type === "get-session")).toBe(false);
    expect(updates.at(-1)).toMatchObject({
      exited: true,
      exitCode: null,
      exitSignal: "SIGTERM",
      requestedTermination: "user",
      exitOutcome: "user-terminated",
    });
  });

  it("suppresses an in-flight metadata failure after the session has exited", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("window", globalThis);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const control = new FakePort();
    const frames = new FakePort();
    const runtime = new GhostteaTerminalRuntime({
      ports: { control: control as unknown as MessagePort, frames: frames as unknown as MessagePort },
      platform: {
        writeClipboard: () => undefined,
        forceCanvasFallback: () => false,
        setForceCanvasFallback: () => undefined,
        reload: () => undefined,
      },
      workerFactory: () => new FakeWorker() as unknown as Worker,
    });
    await runtime.connect();
    const exitingSession = { ...session, handle: "8" };
    runtime.registerSession(exitingSession);
    runtime.setSessionPinned(exitingSession.handle, true);

    const frame = new ArrayBuffer(16);
    new DataView(frame).setBigUint64(8, BigInt(exitingSession.handle), true);
    frames.onmessage?.(new MessageEvent("message", { data: frame }));
    await vi.advanceTimersByTimeAsync(200);
    const refresh = control.messages.find((message) => message.type === "get-session");
    expect(refresh).toBeDefined();

    control.dispatchEvent(
      new MessageEvent("message", {
        data: {
          requestId: 0,
          type: "session-exited",
          sessionId: exitingSession.id,
          exitCode: 0,
          exitSignal: null,
          requestedTermination: null,
          exitOutcome: "completed",
        },
      }),
    );
    frames.onmessage?.(new MessageEvent("message", { data: frame }));
    control.dispatchEvent(
      new MessageEvent("message", {
        data: { requestId: refresh!.requestId, type: "error", message: "unknown session" },
      }),
    );
    await vi.advanceTimersByTimeAsync(250);

    expect(control.messages.filter((message) => message.type === "get-session")).toHaveLength(1);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("propagates actual read-only attachment access and suppresses terminal input", async () => {
    vi.stubGlobal("window", globalThis);
    const control = new FakePort();
    control.attachReadWrite = false;
    const runtime = new GhostteaTerminalRuntime({
      ports: { control: control as unknown as MessagePort, frames: new FakePort() as unknown as MessagePort },
      platform: {
        writeClipboard: () => undefined,
        forceCanvasFallback: () => false,
        setForceCanvasFallback: () => undefined,
        reload: () => undefined,
      },
      workerFactory: () => new FakeWorker() as unknown as Worker,
    });
    await runtime.connect();
    runtime.registerSession(session);
    const updates: SessionSummary[] = [];
    runtime.addEventListener("session-metadata", (event) =>
      updates.push((event as CustomEvent<SessionSummary>).detail),
    );
    runtime.mount(session.id, session.handle, "view-only", canvas());
    await flushMicrotasks();

    runtime.sendText(session.id, "view-only", "blocked");

    expect(updates.at(-1)?.readWrite).toBe(false);
    expect(control.messages.some((message) => message.type === "send-text")).toBe(false);
  });

  it("disposes mounted views, ports, timers, and the render worker exactly once", async () => {
    vi.stubGlobal("window", globalThis);
    const worker = new FakeWorker();
    const control = new FakePort();
    const frames = new FakePort();
    const runtime = new GhostteaTerminalRuntime({
      ports: { control: control as unknown as MessagePort, frames: frames as unknown as MessagePort },
      platform: {
        writeClipboard: () => undefined,
        forceCanvasFallback: () => false,
        setForceCanvasFallback: () => undefined,
        reload: () => undefined,
      },
      workerFactory: () => worker as unknown as Worker,
    });
    await runtime.connect();
    runtime.registerSession(session);
    runtime.mount(session.id, session.handle, "view-1", canvas());
    await flushMicrotasks();

    runtime.dispose();
    runtime.dispose();
    await flushMicrotasks();

    expect(control.messages.filter((message) => message.type === "detach-session")).toHaveLength(1);
    expect(control.closed).toBe(true);
    expect(frames.closed).toBe(true);
    expect(worker.terminated).toBe(true);
    await expect(runtime.connect()).rejects.toThrow("disposed");
  });

  it("mounts and unmounts mirrored session views as independent worker surfaces", async () => {
    vi.stubGlobal("window", globalThis);
    const worker = new FakeWorker();
    const control = new FakePort();
    const frames = new FakePort();
    const runtime = new GhostteaTerminalRuntime({
      ports: { control: control as unknown as MessagePort, frames: frames as unknown as MessagePort },
      platform: {
        writeClipboard: () => undefined,
        forceCanvasFallback: () => false,
        setForceCanvasFallback: () => undefined,
        reload: () => undefined,
      },
      workerFactory: () => worker as unknown as Worker,
    });
    await runtime.connect();

    const first = runtime.mount("session", "handle", "view-1", canvas());
    first.dispose();
    const second = runtime.mount("session", "handle", "view-2", canvas());
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(control.messages).toContainEqual({
      requestId: 0,
      type: "detach-session",
      sessionId: "session",
      viewId: "view-1",
    });
    expect(worker.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "mount", surfaceId: "view-1", sessionHandle: "handle" }),
        expect.objectContaining({ type: "mount", surfaceId: "view-2", sessionHandle: "handle" }),
        { type: "unmount", surfaceId: "view-1" },
      ]),
    );
    expect(worker.messages).not.toContainEqual({ type: "unmount", surfaceId: "view-2" });

    second.dispose();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(control.messages).toContainEqual({
      requestId: 0,
      type: "detach-session",
      sessionId: "session",
      viewId: "view-2",
    });
    expect(worker.messages).toContainEqual({ type: "unmount", surfaceId: "view-2" });
  });

  it("keeps resizing an unfocused view while it remains controller of its own PTY", async () => {
    vi.stubGlobal("window", globalThis);
    const worker = new FakeWorker();
    const control = new FakePort();
    const frames = new FakePort();
    const runtime = new GhostteaTerminalRuntime({
      ports: { control: control as unknown as MessagePort, frames: frames as unknown as MessagePort },
      platform: {
        writeClipboard: () => undefined,
        forceCanvasFallback: () => false,
        setForceCanvasFallback: () => undefined,
        reload: () => undefined,
      },
      workerFactory: () => worker as unknown as Worker,
    });
    await runtime.connect();
    runtime.registerSession(session);
    runtime.mount(session.id, session.handle, "view-1", canvas());
    await flushMicrotasks();

    runtime.claimResizeControl(session.handle, "view-1", 80, 24);
    controlChanged(control, "view-1", 80, 24);
    runtime.resize(session.id, "view-1", 100, 30);

    expect(control.messages).toContainEqual({
      requestId: 0,
      type: "resize",
      sessionId: session.id,
      viewId: "view-1",
      attachmentEpoch: 2,
      controlEpoch: 7,
      resizeSequence: 1,
      cols: 100,
      rows: 30,
    });

    const resizeCount = control.messages.filter((message) => message.type === "resize").length;
    controlChanged(control, "view-2", 120, 40);
    runtime.resize(session.id, "view-1", 101, 30);
    expect(control.messages.filter((message) => message.type === "resize")).toHaveLength(resizeCount);
  });

  it("replays the latest measured geometry after an initial control claim", async () => {
    vi.stubGlobal("window", globalThis);
    const worker = new FakeWorker();
    const control = new FakePort();
    const frames = new FakePort();
    const runtime = new GhostteaTerminalRuntime({
      ports: { control: control as unknown as MessagePort, frames: frames as unknown as MessagePort },
      platform: {
        writeClipboard: () => undefined,
        forceCanvasFallback: () => false,
        setForceCanvasFallback: () => undefined,
        reload: () => undefined,
      },
      workerFactory: () => worker as unknown as Worker,
    });
    await runtime.connect();
    runtime.registerSession(session);
    runtime.mount(session.id, session.handle, "view-1", canvas());
    await flushMicrotasks();

    runtime.setFocused(session.handle, "view-1", true, 80, 24);
    runtime.resize(session.id, "view-1", 110, 31);
    controlChanged(control, "view-1", 80, 24);

    expect(control.messages).toContainEqual({
      requestId: 0,
      type: "resize",
      sessionId: session.id,
      viewId: "view-1",
      attachmentEpoch: 2,
      controlEpoch: 7,
      resizeSequence: 1,
      cols: 110,
      rows: 31,
    });
  });
});
