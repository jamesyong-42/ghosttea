import { EventEmitter } from "node:events";
import type { Socket } from "node:net";
import { beforeEach, describe, expect, it, vi } from "vitest";

const commands: Record<string, unknown>[] = [];
let socketBehavior: "normal" | "close-during-auth" = "normal";

function packet(value: string | object): Buffer {
  const body = Buffer.from(typeof value === "string" ? value : JSON.stringify(value));
  const framed = Buffer.allocUnsafe(4 + body.byteLength);
  framed.writeUInt32LE(body.byteLength, 0);
  framed.set(body, 4);
  return framed;
}

class FakeSocket extends EventEmitter {
  #authenticated = false;

  write(framed: Buffer): boolean {
    const length = framed.readUInt32LE(0);
    const body = framed.subarray(4, 4 + length);
    if (!this.#authenticated) {
      expect(body.toString()).toBe("secret");
      this.#authenticated = true;
      if (socketBehavior === "close-during-auth") queueMicrotask(() => this.emit("close"));
      else queueMicrotask(() => this.emit("data", packet("ok")));
      return true;
    }
    const command = JSON.parse(body.toString()) as Record<string, unknown>;
    commands.push(command);
    const requestId = command.requestId;
    if (command.type === "hello") {
      queueMicrotask(() =>
        this.emit(
          "data",
          packet({ requestId, type: "hello", protocolMajor: 1, protocolMinor: 2, serverBuild: "test" }),
        ),
      );
    } else if (command.type === "get-automation-state") {
      queueMicrotask(() =>
        this.emit(
          "data",
          packet({ requestId, type: "automation-state", sessionId: command.sessionId, humanInputEpoch: 4 }),
        ),
      );
    } else if (command.type === "automation-input") {
      queueMicrotask(() =>
        this.emit(
          "data",
          packet({
            requestId,
            type: "automation-input-result",
            sessionId: command.sessionId,
            accepted: true,
            humanInputEpoch: 4,
            inputSequence: 9,
            reason: null,
          }),
        ),
      );
    } else if (command.type === "get-session") {
      queueMicrotask(() =>
        this.emit(
          "data",
          packet({
            requestId,
            type: "session",
            session: {
              id: command.sessionId,
              handle: "1",
              executable: "/bin/zsh",
              cols: 80,
              rows: 24,
              exited: false,
              title: null,
              cwd: null,
              bellCount: 0,
              pid: 10,
              createdAtMs: 1,
              exitCode: null,
              exitSignal: null,
              requestedTermination: null,
              exitOutcome: null,
            },
          }),
        ),
      );
    } else if (command.type === "terminate") {
      queueMicrotask(() => {
        if (command.sessionId === "missing") {
          this.emit("data", packet({ requestId, type: "error", message: "unknown session" }));
          return;
        }
        this.emit("data", packet({ requestId, type: "ok" }));
        this.emit(
          "data",
          packet({
            requestId: 0,
            type: "session-exited",
            sessionId: command.sessionId,
            exitCode: null,
            exitSignal: "SIGTERM",
            requestedTermination: command.source,
            exitOutcome: "application-terminated",
          }),
        );
      });
    }
    return true;
  }

  destroy(): this {
    queueMicrotask(() => this.emit("close"));
    return this;
  }
}

vi.mock("node:net", () => ({
  createConnection: vi.fn(() => {
    const socket = new FakeSocket();
    queueMicrotask(() => socket.emit("connect"));
    return socket as unknown as Socket;
  }),
}));

import { GhostteaAutomationClient } from "./automation.js";

describe("GhostteaAutomationClient", () => {
  beforeEach(() => {
    commands.splice(0);
    socketBehavior = "normal";
  });

  it("sends atomic automation input without attaching a view or claiming layout control", async () => {
    const client = new GhostteaAutomationClient({
      controlSocket: "control.sock",
      frameSocket: "unused",
      authToken: "secret",
    });
    const result = await client.pasteAndSubmit("session", "hello");
    expect(result).toMatchObject({ accepted: true, humanInputEpoch: 4, inputSequence: 9 });
    expect(commands.map((command) => command.type)).toEqual(["hello", "get-automation-state", "automation-input"]);
    expect(commands[2]).toMatchObject({
      sessionId: "session",
      expectedHumanInputEpoch: 4,
      operation: { kind: "paste", text: "hello", submit: true },
    });
    expect(commands.some((command) => command.type === "attach-session" || command.type === "focus-and-resize")).toBe(
      false,
    );
    client.dispose();
  });

  it("rejects an authentication close and can reconnect cleanly", async () => {
    const client = new GhostteaAutomationClient({
      controlSocket: "control.sock",
      frameSocket: "unused",
      authToken: "secret",
    });
    socketBehavior = "close-during-auth";
    await expect(client.connect()).rejects.toThrow("closed during authentication");

    socketBehavior = "normal";
    await expect(client.connect()).resolves.toBeUndefined();
    expect(commands.map((command) => command.type)).toEqual(["hello"]);
    client.dispose();
  });

  it("waits for the rich exit event when terminating a managed session", async () => {
    const client = new GhostteaAutomationClient({
      controlSocket: "control.sock",
      frameSocket: "unused",
      authToken: "secret",
    });
    await expect(client.terminateAndWait("session")).resolves.toMatchObject({
      sessionId: "session",
      requestedTermination: "application",
      exitOutcome: "application-terminated",
    });
    expect(commands.map((command) => command.type)).toEqual(["hello", "get-session", "terminate"]);
    client.dispose();
  });

  it("cancels the exit waiter when termination is rejected", async () => {
    const client = new GhostteaAutomationClient({
      controlSocket: "control.sock",
      frameSocket: "unused",
      authToken: "secret",
    });

    await expect(client.terminateAndWait("missing", "application", 50)).rejects.toThrow("unknown session");
    expect(client.listenerCount("session-exited")).toBe(0);
    client.dispose();
  });
});
