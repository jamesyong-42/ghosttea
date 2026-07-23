import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

const createConnection = vi.fn();

vi.mock("node:net", () => ({ createConnection }));

class FakeSocket extends EventEmitter {
  readonly write = vi.fn(() => true);
  readonly destroy = vi.fn(() => this);
}

describe("bridge socket authentication", () => {
  it("rejects if the socket closes before the authentication response", async () => {
    const socket = new FakeSocket();
    createConnection.mockReturnValue(socket);
    const { connectSocket } = await import("./bridge-socket");
    const onDisconnect = vi.fn();

    const connection = connectSocket("/tmp/control.sock", "token", 1024, vi.fn(), onDisconnect);
    const rejection = expect(connection).rejects.toThrow("closed during authentication");
    socket.emit("close");

    await rejection;
    expect(onDisconnect).not.toHaveBeenCalled();
  });
});
