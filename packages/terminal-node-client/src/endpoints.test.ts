import { EventEmitter } from "node:events";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Hoisted so the mock factory, which vitest lifts above this file's imports,
// can reach the spy before `./endpoints.js` is evaluated.
const { createConnection } = vi.hoisted(() => ({ createConnection: vi.fn() }));

vi.mock("node:net", () => ({ createConnection }));

import { endpointPersists, localEndpoints, openEndpoint } from "./endpoints.js";

class FakeSocket extends EventEmitter {
  readonly destroy = vi.fn(() => this);
}

function busy(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}

beforeEach(() => {
  createConnection.mockReset();
});

describe("local endpoints", () => {
  it("names each Windows channel uniquely in the shared pipe namespace", () => {
    const { controlSocket, frameSocket } = localEndpoints("/ignored", "win32");
    expect(controlSocket).toMatch(/^\\\\\.\\pipe\\ghosttea-/);
    expect(frameSocket).toMatch(/^\\\\\.\\pipe\\ghosttea-/);
    expect(controlSocket).not.toBe(frameSocket);
    // Two instances must not collide in the machine-wide namespace.
    expect(localEndpoints("/ignored", "win32").controlSocket).not.toBe(controlSocket);
  });

  it("keeps both Unix channels inside the private runtime directory", () => {
    const { controlSocket, frameSocket } = localEndpoints("/run/ghosttea", "darwin");
    expect(controlSocket).toBe(join("/run/ghosttea", "control.sock"));
    expect(frameSocket).toBe(join("/run/ghosttea", "frames.sock"));
  });

  it("reports only Unix sockets as persisting past their process", () => {
    expect(endpointPersists("darwin")).toBe(true);
    expect(endpointPersists("linux")).toBe(true);
    expect(endpointPersists("win32")).toBe(false);
  });
});

describe("opening an endpoint", () => {
  it("retries on Windows until an idle pipe instance is free", async () => {
    const rejected = new FakeSocket();
    const accepted = new FakeSocket();
    createConnection.mockReturnValueOnce(rejected).mockReturnValueOnce(accepted);

    const opened = openEndpoint("\\\\.\\pipe\\ghosttea-test", Date.now() + 1_000, "win32");
    rejected.emit("error", busy("EBUSY"));
    await vi.waitFor(() => expect(createConnection).toHaveBeenCalledTimes(2));
    accepted.emit("connect");

    expect(await opened).toBe(accepted);
    expect(rejected.destroy).toHaveBeenCalledOnce();
  });

  it("does not retry a Unix socket, where the kernel queues connections", async () => {
    const socket = new FakeSocket();
    createConnection.mockReturnValueOnce(socket);

    const opened = openEndpoint("/run/ghosttea/control.sock", Date.now() + 1_000, "darwin");
    socket.emit("error", busy("EBUSY"));

    await expect(opened).rejects.toThrow("EBUSY");
    expect(createConnection).toHaveBeenCalledOnce();
  });

  it("gives up quickly when nothing is listening, rather than hanging", async () => {
    createConnection.mockImplementation(() => {
      const socket = new FakeSocket();
      queueMicrotask(() => socket.emit("error", busy("ENOENT")));
      return socket;
    });

    // An unpublished name is momentary while the service replaces an instance,
    // but it is also what a service that never started looks like.
    const started = Date.now();
    await expect(openEndpoint("\\\\.\\pipe\\ghosttea-test", Date.now() + 30_000, "win32")).rejects.toThrow("ENOENT");
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("keeps waiting on a busy endpoint for the caller's whole budget", async () => {
    let attempts = 0;
    createConnection.mockImplementation(() => {
      const socket = new FakeSocket();
      attempts += 1;
      // Busy for longer than the grace an unpublished name would get.
      queueMicrotask(() => socket.emit(attempts > 80 ? "connect" : "error", busy("EBUSY")));
      return socket;
    });

    const opened = await openEndpoint("\\\\.\\pipe\\ghosttea-test", Date.now() + 30_000, "win32");
    expect(opened).toBeDefined();
    expect(attempts).toBeGreaterThan(80);
  });

  it("stops retrying once the caller's deadline passes", async () => {
    const socket = new FakeSocket();
    createConnection.mockReturnValue(socket);

    const opened = openEndpoint("\\\\.\\pipe\\ghosttea-test", Date.now(), "win32");
    socket.emit("error", busy("ENOENT"));

    await expect(opened).rejects.toThrow("ENOENT");
  });

  it("surfaces an error Windows does not raise for a busy endpoint", async () => {
    const socket = new FakeSocket();
    createConnection.mockReturnValueOnce(socket);

    const opened = openEndpoint("\\\\.\\pipe\\ghosttea-test", Date.now() + 1_000, "win32");
    socket.emit("error", busy("EACCES"));

    await expect(opened).rejects.toThrow("EACCES");
    expect(createConnection).toHaveBeenCalledOnce();
  });
});
