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

afterEach(() => vi.unstubAllGlobals());

describe("GhostteaTerminalRuntime mount ownership", () => {
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
});
