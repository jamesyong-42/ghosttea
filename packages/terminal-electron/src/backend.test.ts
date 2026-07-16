import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

const utilityChildren: FakeUtilityProcess[] = [];

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

describe("GhostteaElectronBackend external mode", () => {
  beforeEach(() => utilityChildren.splice(0));

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
  });
});
