import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

const utilityChildren: FakeUtilityProcess[] = [];
const automationClients: FakeAutomationClient[] = [];

class FakeAutomationClient {
  readonly connect = vi.fn(async () => undefined);
  readonly dispose = vi.fn();

  constructor() {
    automationClients.push(this);
  }
}

class FakeUtilityProcess extends EventEmitter {
  readonly postMessage = vi.fn();
  readonly kill = vi.fn();
}

class FakeMessageChannelMain {
  readonly port1 = { side: 1 };
  readonly port2 = { side: 2 };
}

vi.mock("electron", () => ({
  MessageChannelMain: FakeMessageChannelMain,
  utilityProcess: {
    fork: vi.fn(() => {
      const child = new FakeUtilityProcess();
      utilityChildren.push(child);
      return child;
    }),
  },
}));

vi.mock("./automation.js", () => ({ GhostteaAutomationClient: FakeAutomationClient }));

describe("GhostteaElectronBackend external mode", () => {
  beforeEach(() => {
    utilityChildren.splice(0);
    automationClients.splice(0);
  });

  it("attaches renderer ports without owning the Rust service", async () => {
    const { GhostteaElectronBackend } = await import("./backend.js");
    const connection = {
      controlSocket: "/service/control.sock",
      frameSocket: "/service/frames.sock",
      authToken: "host-owned-token",
    };
    const backend = new GhostteaElectronBackend({ mode: "external", connection });
    const postMessage = vi.fn();

    expect(backend.connection).toEqual(connection);
    await backend.start();
    expect(backend.running).toBe(true);
    expect(automationClients[0]!.connect).toHaveBeenCalledOnce();

    backend.attachRenderer({ postMessage } as never);
    expect(utilityChildren).toHaveLength(1);
    expect(utilityChildren[0]!.postMessage).toHaveBeenCalledWith({ type: "connect", connection }, [
      { side: 1 },
      { side: 1 },
    ]);
    expect(postMessage).toHaveBeenCalledWith("terminal-ports", null, [{ side: 2 }, { side: 2 }]);

    backend.stop();
    expect(backend.running).toBe(false);
    expect(utilityChildren[0]!.kill).toHaveBeenCalledOnce();
    expect(automationClients[0]!.dispose).toHaveBeenCalledOnce();
  });

  it("marks an external backend unhealthy when its daemon connection is lost", async () => {
    const { GhostteaElectronBackend } = await import("./backend.js");
    const backend = new GhostteaElectronBackend({
      mode: "external",
      connection: {
        controlSocket: "/service/control.sock",
        frameSocket: "/service/frames.sock",
        authToken: "host-owned-token",
      },
    });
    const lost = vi.fn();
    backend.on("unexpected-exit", lost);
    await backend.start();

    utilityChildren[0]!.emit("message", { type: "connection-lost", message: "daemon restarted" });

    expect(backend.running).toBe(false);
    expect(utilityChildren[0]!.kill).toHaveBeenCalledOnce();
    expect(lost).toHaveBeenCalledWith({
      source: "connection",
      code: null,
      signal: null,
      message: "daemon restarted",
    });
  });
});
