import { afterEach, describe, expect, it, vi } from "vitest";
import { GhostteaTerminalRuntime } from "./runtime";

class FakeWorker extends EventTarget {
  readonly messages: unknown[] = [];

  postMessage(message: unknown): void {
    this.messages.push(message);
  }
}

class FakePort extends EventTarget {
  readonly messages: Array<Record<string, unknown>> = [];

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
          },
        }),
      );
    }
  }

  start(): void {}
  close(): void {}
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
  title: null,
  cwd: null,
  bellCount: 0,
  pid: 1,
  createdAtMs: 1,
  exitCode: null,
  exitSignal: null,
  requestedTermination: null,
  exitOutcome: null,
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

afterEach(() => vi.unstubAllGlobals());

describe("GhostteaTerminalRuntime mount ownership", () => {
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
