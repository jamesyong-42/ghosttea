import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

const createConnection = vi.fn();

vi.mock("node:net", () => ({ createConnection }));

class FakeSocket extends EventEmitter {
  readonly write = vi.fn(() => true);
  readonly destroy = vi.fn(() => this);
  #paused = false;

  isPaused(): boolean {
    return this.#paused;
  }

  pause(): this {
    this.#paused = true;
    return this;
  }

  resume(): this {
    this.#paused = false;
    this.emit("resume");
    return this;
  }
}

/**
 * `connectSocket` owns dialing, so it authenticates only after the endpoint is
 * connected. Let the connect settle before driving the authentication step.
 */
function connected(socket: FakeSocket): Promise<void> {
  queueMicrotask(() => socket.emit("connect"));
  return new Promise((resolve) => setImmediate(resolve));
}

describe("bridge socket authentication", () => {
  it("rejects if the socket closes before the authentication response", async () => {
    const socket = new FakeSocket();
    createConnection.mockReturnValue(socket);
    const { connectSocket } = await import("./bridge-socket");
    const onDisconnect = vi.fn();

    const connection = connectSocket("/tmp/control.sock", "token", 1024, vi.fn(), onDisconnect);
    const rejection = expect(connection).rejects.toThrow("closed during authentication");
    await connected(socket);
    socket.emit("close");

    await rejection;
    expect(onDisconnect).not.toHaveBeenCalled();
  });

  it("times out and destroys a socket that never authenticates", async () => {
    const socket = new FakeSocket();
    createConnection.mockReturnValue(socket);
    const { connectSocket } = await import("./bridge-socket");
    const onDisconnect = vi.fn();

    const connection = connectSocket("/tmp/control.sock", "token", 1024, vi.fn(), onDisconnect, 5);
    await connected(socket);
    await expect(connection).rejects.toThrow("timed out during authentication");

    expect(socket.destroy).toHaveBeenCalledOnce();
    expect(onDisconnect).not.toHaveBeenCalled();
  });

  it("authenticates as soon as the endpoint connects", async () => {
    const socket = new FakeSocket();
    createConnection.mockReturnValue(socket);
    const { connectSocket, packet } = await import("./bridge-socket");

    void connectSocket("/tmp/control.sock", "token", 1024, vi.fn(), vi.fn());
    await connected(socket);

    expect(socket.write).toHaveBeenCalledWith(packet(Buffer.from("token")));
  });

  it("keeps complete buffered packets queued while the consumer is paused", async () => {
    const socket = new FakeSocket();
    createConnection.mockReturnValue(socket);
    const { connectSocket, packet } = await import("./bridge-socket");
    const received: string[] = [];
    const connection = connectSocket(
      "/tmp/frames.sock",
      "token",
      1024,
      (bytes) => {
        received.push(bytes.toString());
        socket.pause();
      },
      vi.fn(),
    );
    await connected(socket);
    socket.emit(
      "data",
      Buffer.concat([packet(Buffer.from("ok")), packet(Buffer.from("one")), packet(Buffer.from("two"))]),
    );
    await connection;

    expect(received).toEqual(["one"]);
    socket.resume();
    expect(received).toEqual(["one", "two"]);
  });
});
