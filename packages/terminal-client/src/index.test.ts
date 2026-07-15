import { describe, expect, it } from "vitest";
import { ControlClient } from "./index";

describe("ControlClient", () => {
  it("uses request id zero for notifications and does not allocate a pending response", async () => {
    const channel = new MessageChannel();
    const client = new ControlClient(channel.port1);
    const command = new Promise<unknown>((resolve) =>
      channel.port2.addEventListener("message", (event) => resolve(event.data), { once: true }),
    );
    channel.port2.start();
    client.notify({ type: "focus", sessionId: "session", focused: true });
    await expect(command).resolves.toMatchObject({ requestId: 0, type: "focus" });
    client.dispose();
    channel.port2.close();
  });

  it("rejects pending work immediately when the bridge reports a fatal error", async () => {
    const channel = new MessageChannel();
    const client = new ControlClient(channel.port1);
    channel.port2.start();
    const pending = client.request({ type: "list-sessions" });
    channel.port2.postMessage({ requestId: 0, type: "bridge-error", message: "bad daemon payload" });
    await expect(pending).rejects.toThrow("bad daemon payload");
    client.dispose();
    channel.port2.close();
  });
});
