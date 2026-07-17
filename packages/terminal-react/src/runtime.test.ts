import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionSummary } from "@vibecook/ghosttea-protocol";
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
  closed = false;
  onmessage: ((event: MessageEvent<ArrayBuffer>) => void) | null = null;

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
            protocolMinor: message.protocolMinor,
            serverBuild: "test",
          },
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
    await Promise.resolve();
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
    await Promise.resolve();

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

  it("subscribes the frame bridge only to sessions registered in this runtime", async () => {
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

    expect(frames.messages).toEqual([
      { type: "subscribe", sessionHandles: [] },
      { type: "subscribe", sessionHandles: [session.handle] },
    ]);

    runtime.terminate(session.id);
    expect(frames.messages.at(-1)).toEqual({ type: "subscribe", sessionHandles: [] });
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
    await Promise.resolve();

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
    await Promise.resolve();

    runtime.dispose();
    runtime.dispose();
    await Promise.resolve();

    expect(control.messages.filter((message) => message.type === "detach-session")).toHaveLength(1);
    expect(control.closed).toBe(true);
    expect(frames.closed).toBe(true);
    expect(worker.terminated).toBe(true);
    await expect(runtime.connect()).rejects.toThrow("disposed");
  });

  it("detaches an obsolete view without unmounting its replacement worker surface", async () => {
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
    expect(worker.messages).not.toContainEqual({ type: "unmount", sessionHandle: "handle" });

    second.dispose();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(control.messages).toContainEqual({
      requestId: 0,
      type: "detach-session",
      sessionId: "session",
      viewId: "view-2",
    });
    expect(worker.messages).toContainEqual({ type: "unmount", sessionHandle: "handle" });
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
    await Promise.resolve();

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
    await Promise.resolve();

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
