import { EventEmitter } from "node:events";
import type { Socket } from "node:net";
import { beforeEach, describe, expect, it, vi } from "vitest";

const commands: Record<string, unknown>[] = [];
let socketBehavior: "normal" | "close-during-auth" | "silent-auth" = "normal";
let serverProtocolMinor = 11;

const config = {
  schemaVersion: 1,
  revision: "config-1",
  compatibility: {
    ghosttyVersion: "1.3.1",
    ghosttyCommit: "332b2aef",
    knownKeyCount: 202,
  },
  sources: [],
  diagnostics: [],
  configuredKeys: [],
  terminal: {
    scrollbackBytes: 10_000_000,
    foreground: [255, 255, 255],
    background: [40, 44, 52],
    cursor: [255, 255, 255],
  },
  renderer: {
    foreground: [255, 255, 255],
    background: [40, 44, 52],
    cursor: [255, 255, 255],
    selectionBackground: [255, 255, 255],
    selectionForeground: [40, 44, 52],
    fontSize: 13,
    fontFamilies: [],
    paddingX: [2, 2],
    paddingY: [2, 2],
    postProcess: "none",
    customShaderPaths: [],
  },
  workspace: { keybindings: [], clearKeybindings: false },
};

const document = {
  schemaVersion: 1,
  revision: "document-1",
  path: "/tmp/config.ghostty",
  exists: true,
  contents: "# exact\r\n",
};

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
      else if (socketBehavior === "normal") queueMicrotask(() => this.emit("data", packet("ok")));
      return true;
    }
    const command = JSON.parse(body.toString()) as Record<string, unknown>;
    commands.push(command);
    const requestId = command.requestId;
    if (command.type === "hello") {
      queueMicrotask(() =>
        this.emit(
          "data",
          packet({
            requestId,
            type: "hello",
            protocolMajor: 1,
            protocolMinor: serverProtocolMinor,
            serverBuild: "test",
          }),
        ),
      );
    } else if (command.type === "get-config-document") {
      queueMicrotask(() => this.emit("data", packet({ requestId, type: "config-document", document })));
    } else if (command.type === "validate-config-document") {
      queueMicrotask(() =>
        this.emit(
          "data",
          packet({
            requestId,
            type: "config-document-validation",
            documentRevision: "candidate-2",
            config,
          }),
        ),
      );
    } else if (command.type === "replace-config-document") {
      queueMicrotask(() => {
        if (command.expectedRevision === "stale") {
          this.emit("data", packet({ requestId, type: "config-document-conflict", document }));
        } else {
          this.emit(
            "data",
            packet({
              requestId,
              type: "config-document-updated",
              document: { ...document, revision: "document-2", contents: command.contents },
              config,
            }),
          );
        }
      });
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
              readWrite: true,
              title: null,
              cwd: null,
              bellCount: 0,
              pid: 10,
              createdAtMs: 1,
              exitCode: null,
              exitSignal: null,
              requestedTermination: null,
              exitOutcome: null,
              ownerId: null,
            },
          }),
        ),
      );
    } else if (command.type === "close-session-owner") {
      queueMicrotask(() => this.emit("data", packet({ requestId, type: "ok" })));
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

import { GhostteaAutomationClient, GhostteaConfigDocumentConflictError } from "./index.js";

describe("GhostteaAutomationClient", () => {
  beforeEach(() => {
    commands.splice(0);
    socketBehavior = "normal";
    serverProtocolMinor = 11;
  });

  it("reads, validates, and compare-and-swaps exact configuration documents", async () => {
    const client = new GhostteaAutomationClient({ controlSocket: "control.sock", authToken: "secret" });
    await expect(client.getConfigDocument()).resolves.toEqual(document);
    await expect(client.validateConfigDocument("# candidate\r\n")).resolves.toMatchObject({
      documentRevision: "candidate-2",
      config: { revision: "config-1" },
    });
    await expect(client.replaceConfigDocument("document-1", "# replacement\r\n")).resolves.toMatchObject({
      document: { revision: "document-2", contents: "# replacement\r\n" },
      config: { revision: "config-1" },
    });
    await expect(client.replaceConfigDocument("stale", "# clobber\r\n")).rejects.toMatchObject({
      name: "GhostteaConfigDocumentConflictError",
      document,
    } satisfies Partial<GhostteaConfigDocumentConflictError>);
    expect(commands.map((command) => command.type)).toEqual([
      "hello",
      "get-config-document",
      "validate-config-document",
      "replace-config-document",
      "replace-config-document",
    ]);
    client.dispose();
  });

  it("rejects document operations locally against an older daemon", async () => {
    serverProtocolMinor = 10;
    const client = new GhostteaAutomationClient({ controlSocket: "control.sock", authToken: "secret" });
    await expect(client.getConfigDocument()).rejects.toThrow("requires protocol 1.11");
    await expect(client.request({ type: "get-config-document" })).rejects.toThrow("requires protocol 1.11");
    expect(commands.map((command) => command.type)).toEqual(["hello"]);
    client.dispose();
  });

  it("closes an application session owner atomically", async () => {
    const client = new GhostteaAutomationClient({ controlSocket: "control.sock", authToken: "secret" });
    await client.closeSessionOwner("tab-a");
    expect(commands.at(-1)).toMatchObject({ type: "close-session-owner", ownerId: "tab-a" });
    client.dispose();
  });

  it("sends epoch-gated automation without claiming view authority", async () => {
    const client = new GhostteaAutomationClient({ controlSocket: "control.sock", authToken: "secret" });
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

  it("rejects an authentication close and reconnects cleanly", async () => {
    const client = new GhostteaAutomationClient({ controlSocket: "control.sock", authToken: "secret" });
    socketBehavior = "close-during-auth";
    await expect(client.connect()).rejects.toThrow("closed during authentication");

    socketBehavior = "normal";
    await expect(client.connect()).resolves.toBeUndefined();
    expect(commands.map((command) => command.type)).toEqual(["hello"]);
    client.dispose();
  });

  it("times out a silent authentication peer and reconnects cleanly", async () => {
    const client = new GhostteaAutomationClient(
      { controlSocket: "control.sock", authToken: "secret" },
      { connectTimeoutMs: 5 },
    );
    socketBehavior = "silent-auth";
    await expect(client.connect()).rejects.toThrow("timed out during authentication");

    socketBehavior = "normal";
    await expect(client.connect()).resolves.toBeUndefined();
    expect(commands.map((command) => command.type)).toEqual(["hello"]);
    client.dispose();
  });

  it("waits for rich exit metadata when terminating a session", async () => {
    const client = new GhostteaAutomationClient({ controlSocket: "control.sock", authToken: "secret" });
    await expect(client.terminateAndWait("session")).resolves.toMatchObject({
      sessionId: "session",
      requestedTermination: "application",
      exitOutcome: "application-terminated",
    });
    expect(commands.map((command) => command.type)).toEqual(["hello", "get-session", "terminate"]);
    client.dispose();
  });

  it("cancels the exit waiter when termination is rejected", async () => {
    const client = new GhostteaAutomationClient({ controlSocket: "control.sock", authToken: "secret" });
    await expect(client.terminateAndWait("missing", "application", 50)).rejects.toThrow("unknown session");
    expect(client.listenerCount("session-exited")).toBe(0);
    client.dispose();
  });
});
