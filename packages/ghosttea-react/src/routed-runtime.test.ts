import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_ROUTED_PROTOCOL_LIMITS,
  encodeRoutedMessage,
  unknownSessionActivity,
  type RoutedCellTransportGrant,
  type RoutedSessionAttachGrant,
  type RoutedTerminalOpenTicket,
  type SessionSummary,
} from "@vibecook/ghosttea-protocol";
import { GhostteaTerminalRuntime, type GhostteaRoutedHost } from "./runtime";

class FakeWorker extends EventTarget {
  readonly messages: unknown[] = [];
  terminated = false;

  postMessage(message: unknown): void {
    this.messages.push(message);
  }

  emit(data: unknown): void {
    this.dispatchEvent(new MessageEvent("message", { data }));
  }

  terminate(): void {
    this.terminated = true;
  }
}

class FakeSocket extends EventTarget {
  readyState = 0;
  binaryType = "blob";
  readonly sent: string[] = [];
  closeCode: number | undefined;

  send(data: string): void {
    this.sent.push(data);
  }

  open(): void {
    this.readyState = 1;
    this.dispatchEvent(new Event("open"));
  }

  receive(data: string): void {
    this.dispatchEvent(new MessageEvent("message", { data }));
  }

  close(code = 1000, reason = ""): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.closeCode = code;
    const event = new Event("close") as Event & { code: number; reason: string };
    Object.assign(event, { code, reason });
    this.dispatchEvent(event);
  }
}

function grantPair(cellBootId: string, sessionId: string, connectionSetId: string) {
  const protectedBase = {
    v: 1 as const,
    iss: "fieldd" as const,
    alg: "HS256" as const,
    kid: { cellBootId, keyGeneration: 1 },
  };
  const transportGrant: RoutedCellTransportGrant = {
    protected: { ...protectedBase, typ: "CellTransportGrant" },
    claims: {
      audienceCellBootId: cellBootId,
      clientId: "window-1",
      connectionSetId,
      allowedChannels: ["control", "frames"],
      transportGrantGeneration: 1,
      issuedAt: 1,
      expiresAt: 999_999_999_999_999,
      nonce: `nonce-${cellBootId}`,
    },
    mac: "opaque",
  };
  const attachGrant: RoutedSessionAttachGrant = {
    protected: { ...protectedBase, typ: "SessionAttachGrant" },
    claims: {
      audienceCellBootId: cellBootId,
      clientId: "window-1",
      sessionId,
      leaseEpoch: 4,
      routeRevision: 2,
      grantGeneration: 1,
      rights: ["geometry", "input", "read"],
      issuedAt: 1,
      expiresAt: 999_999_999_999_999,
    },
    mac: "opaque",
  };
  return { transportGrant, attachGrant };
}

function ticket(cellBootId: string, sessionId: string, connectionSetId: string): RoutedTerminalOpenTicket {
  const grants = grantPair(cellBootId, sessionId, connectionSetId);
  return {
    route: { cellBootId, routeRevision: 2, leaseEpoch: 4 },
    endpoints: {
      controlUrl: `ws://127.0.0.1/${cellBootId}/control`,
      framesUrl: `ws://127.0.0.1/${cellBootId}/frames`,
    },
    ...grants,
  };
}

function session(id: string, handle: string): SessionSummary {
  return {
    id,
    handle,
    executable: "/bin/zsh",
    cols: 80,
    rows: 24,
    exited: false,
    readWrite: true,
    title: null,
    cwd: null,
    bellCount: 0,
    pid: 1,
    createdAtMs: 1,
    exitCode: null,
    exitSignal: null,
    requestedTermination: null,
    exitOutcome: null,
    ownerId: null,
    persistence: null,
    activity: unknownSessionActivity(),
  };
}

function canvas(): HTMLCanvasElement {
  return { transferControlToOffscreen: () => ({}) as OffscreenCanvas } as HTMLCanvasElement;
}

async function flush(): Promise<void> {
  for (let index = 0; index < 12; index += 1) await Promise.resolve();
}

describe("routed terminal runtime", () => {
  it("keeps routed input closed when T1 has no negotiated input encoder", async () => {
    vi.stubGlobal("window", globalThis);
    const worker = new FakeWorker();
    const sockets: FakeSocket[] = [];
    const runtime = new GhostteaTerminalRuntime({
      transport: "routed",
      host: { openTicket: async () => ticket("cell-a", "session-a", "set-a") },
      platform: {
        writeClipboard: () => undefined,
        forceCanvasFallback: () => false,
        setForceCanvasFallback: () => undefined,
        reload: () => undefined,
      },
      websocketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket as unknown as WebSocket;
      },
      workerFactory: () => worker as unknown as Worker,
    });
    const first = session("session-a", "11");
    runtime.registerSession(first);
    runtime.mount(first.id, first.handle, "view-a", canvas());
    await flush();

    expect(runtime.routedActivation(first.id)?.inputPolicy).toBe("read-only");
    expect(runtime.routedViewInputAllowed("view-a")).toBe(false);
    const suppressed = vi.fn();
    runtime.addEventListener("routed-input-suppressed", suppressed);
    const workerMessagesBeforeInput = worker.messages.length;
    runtime.sendText(first.id, "view-a", "blocked");
    expect(worker.messages).toHaveLength(workerMessagesBeforeInput);
    expect(suppressed).toHaveBeenCalledOnce();
    expect((suppressed.mock.calls[0]![0] as CustomEvent).detail.reason).toBe("wire-verb-unavailable");

    runtime.dispose();
  });

  it("re-mints after a terminal grant refusal instead of retrying the refused grant", async () => {
    vi.stubGlobal("window", globalThis);
    const worker = new FakeWorker();
    const sockets: FakeSocket[] = [];
    let generation = 0;
    const openTicket = vi.fn(async () => {
      const next = ticket("cell-a", "session-a", "set-a");
      generation += 1;
      next.transportGrant.claims.transportGrantGeneration = generation;
      next.transportGrant.claims.nonce = `nonce-${generation}`;
      return next;
    });
    const runtime = new GhostteaTerminalRuntime({
      transport: "routed",
      host: { openTicket },
      platform: {
        writeClipboard: () => undefined,
        forceCanvasFallback: () => false,
        setForceCanvasFallback: () => undefined,
        reload: () => undefined,
      },
      websocketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket as unknown as WebSocket;
      },
      workerFactory: () => worker as unknown as Worker,
    });
    const first = session("session-a", "11");
    runtime.registerSession(first);
    runtime.mount(first.id, first.handle, "view-a", canvas());
    await flush();
    sockets[0]!.open();
    sockets[0]!.receive(
      encodeRoutedMessage("ConnectionRefused", {
        code: "GRANT_NONCE_REPLAYED",
        retryable: false,
      }),
    );

    expect(runtime.routedActivation(first.id)?.phase).toBe("recovering");
    await new Promise((resolve) => setTimeout(resolve, 120));
    await flush();
    expect(openTicket).toHaveBeenCalledTimes(2);
    expect(sockets).toHaveLength(2);
    expect(generation).toBe(2);

    runtime.dispose();
  });

  it("re-dials one protocol failure, then makes a persistent failure unavailable", async () => {
    vi.stubGlobal("window", globalThis);
    const worker = new FakeWorker();
    const openTicket = vi.fn(async () => ticket("cell-a", "session-a", "set-a"));
    const runtime = new GhostteaTerminalRuntime({
      transport: "routed",
      host: { openTicket },
      platform: {
        writeClipboard: () => undefined,
        forceCanvasFallback: () => false,
        setForceCanvasFallback: () => undefined,
        reload: () => undefined,
      },
      websocketFactory: () => new FakeSocket() as unknown as WebSocket,
      workerFactory: () => worker as unknown as Worker,
    });
    const protocolError = vi.fn();
    runtime.addEventListener("routed-protocol-error", protocolError);
    const first = session("session-a", "11");
    runtime.registerSession(first);
    runtime.mount(first.id, first.handle, "view-a", canvas());
    await flush();
    const firstActivationId = runtime.routedActivation(first.id)!.activationId;

    worker.emit({
      type: "routed-frames-event",
      event: {
        type: "transport-closed",
        cellBootId: "cell-a",
        code: 4003,
        reason: "first malformed unit",
        activationIds: [firstActivationId],
        preAuth: false,
      },
    });
    expect(runtime.routedActivation(first.id)?.phase).toBe("recovering");
    await new Promise((resolve) => setTimeout(resolve, 120));
    await flush();
    const secondActivationId = runtime.routedActivation(first.id)!.activationId;
    expect(secondActivationId).not.toBe(firstActivationId);
    expect(openTicket).toHaveBeenCalledTimes(2);

    worker.emit({
      type: "routed-frames-event",
      event: {
        type: "transport-closed",
        cellBootId: "cell-a",
        code: 4003,
        reason: "second malformed unit",
        activationIds: [secondActivationId],
        preAuth: false,
      },
    });
    expect(runtime.routedActivation(first.id)).toMatchObject({
      phase: "unavailable",
      unavailableReason: "protocol",
    });
    expect(protocolError).toHaveBeenCalledOnce();
    expect((protocolError.mock.calls[0]![0] as CustomEvent).detail).toEqual({
      sessionId: first.id,
      channel: "frames",
      reason: "second malformed unit",
    });
    expect(worker.messages.at(-1)).toEqual({
      type: "routed-frames-detach",
      activationId: secondActivationId,
    });

    runtime.dispose();
  });

  it("owns two cell connection sets and sends allowed input directly on control", async () => {
    vi.stubGlobal("window", globalThis);
    const worker = new FakeWorker();
    const sockets: FakeSocket[] = [];
    const tickets = new Map([
      ["session-a", ticket("cell-a", "session-a", "set-a")],
      ["session-b", ticket("cell-b", "session-b", "set-b")],
    ]);
    const ticketGenerations = new Map<string, number>();
    const openTicket = vi.fn(async (sessionId: string) => {
      const base = tickets.get(sessionId)!;
      const generation = (ticketGenerations.get(sessionId) ?? 0) + 1;
      ticketGenerations.set(sessionId, generation);
      return {
        ...base,
        transportGrant: {
          ...base.transportGrant,
          claims: {
            ...base.transportGrant.claims,
            transportGrantGeneration: generation,
            nonce: `nonce-${sessionId}-${generation}`,
          },
        },
      };
    });
    const host: GhostteaRoutedHost = {
      openTicket,
      encodeInput: (context) => ({
        type: "TerminalInput",
        activationId: context.activationId,
        leaseEpoch: context.leaseEpoch,
        inputSequence: context.inputSequence,
        operation: context.operation,
      }),
    };
    const runtime = new GhostteaTerminalRuntime({
      transport: "routed",
      host,
      platform: {
        writeClipboard: () => undefined,
        forceCanvasFallback: () => false,
        setForceCanvasFallback: () => undefined,
        reload: () => undefined,
      },
      websocketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket as unknown as WebSocket;
      },
      workerFactory: () => worker as unknown as Worker,
    });
    const first = session("session-a", "11");
    const second = session("session-b", "21");
    runtime.registerSession(first);
    runtime.registerSession(second);
    runtime.mount(first.id, first.handle, "view-a", canvas());
    runtime.mount(second.id, second.handle, "view-b", canvas());
    runtime.claimResizeControl(first.handle, "view-a", 80, 24);
    await flush();

    expect(sockets).toHaveLength(2);
    expect(
      worker.messages
        .filter(
          (message): message is { type: "routed-frames-attach"; request: { cellBootId: string } } =>
            typeof message === "object" &&
            message !== null &&
            (message as { type?: string }).type === "routed-frames-attach",
        )
        .map((message) => message.request.cellBootId),
    ).toEqual(["cell-a", "cell-b"]);
    for (const socket of sockets) socket.open();
    const helloA = JSON.parse(sockets[0]!.sent[0]!) as Record<string, unknown>;
    const helloB = JSON.parse(sockets[1]!.sent[0]!) as Record<string, unknown>;
    expect([helloA.type, helloB.type]).toEqual(["ConnectionHello", "ConnectionHello"]);
    expect(new Set([helloA.channel, helloB.channel])).toEqual(new Set(["control"]));

    for (let index = 0; index < sockets.length; index += 1) {
      const setId = index === 0 ? "set-a" : "set-b";
      sockets[index]!.receive(
        encodeRoutedMessage("ConnectionAccepted", {
          selectedProtocolVersion: { major: 1, minor: 0 },
          connectionSetId: setId,
          channel: "control",
          legGeneration: 1,
          heartbeatTtlMs: 15_000,
          protocolLimits: DEFAULT_ROUTED_PROTOCOL_LIMITS,
          capabilities: ["resume"],
        }),
      );
    }
    const attachA = JSON.parse(sockets[0]!.sent.at(-1)!) as { activationId: string; type: string };
    expect(attachA.type).toBe("AttachControlLeg");
    sockets[0]!.receive(
      encodeRoutedMessage("ControlLegAttached", {
        sessionId: first.id,
        activationId: attachA.activationId,
        grantGenerationAccepted: 1,
        rights: ["geometry", "input", "read"],
      }),
    );
    expect(JSON.parse(sockets[0]!.sent.at(-1)!)).toMatchObject({
      type: "ClaimGeometry",
      activationId: attachA.activationId,
      claimant: { viewId: "view-a" },
      cols: 80,
      rows: 24,
    });
    worker.emit({
      type: "routed-frames-event",
      event: {
        type: "frames-attached",
        attached: {
          sessionId: first.id,
          activationId: attachA.activationId,
          resumeToken: "resume-a",
          trfIdentity: { sessionHandle: "11", viewHandle: "12" },
          outcome: { kind: "seed-required", reason: "no-cursor" },
        },
      },
    });
    const stamp = { sceneEpoch: { cellBootId: "cell-a", modelGeneration: 1 }, sceneRevision: 1 };
    worker.emit({
      type: "routed-frames-event",
      event: {
        type: "frames-state",
        activationId: attachA.activationId,
        state: "active",
        appliedContent: stamp,
      },
    });
    worker.emit({
      type: "routed-frames-event",
      event: {
        type: "presentation-status",
        status: {
          activationId: attachA.activationId,
          workerStatusSequence: 1,
          state: "active",
          sceneContent: stamp,
          leaseTtlMs: 10_000,
        },
      },
    });
    sockets[0]!.receive(
      encodeRoutedMessage("CellActivationStatus", {
        sessionId: first.id,
        activationId: attachA.activationId,
        cellStatusSequence: 1,
        leaseTtlMs: 10_000,
        acceptedContent: stamp,
        presentation: { state: "presenting" },
        input: { state: "allowed" },
      }),
    );
    expect(runtime.routedActivation(first.id)?.presentationReady).toBe(true);
    expect(runtime.routedViewInputAllowed("view-a")).toBe(true);

    const workerMessagesBeforeInput = worker.messages.length;
    const socketMessagesBeforeInput = sockets[0]!.sent.length;
    runtime.sendKey(first.id, "view-a", {
      type: "down",
      key: "a",
      code: "KeyA",
      location: 0,
      repeat: false,
      shift: false,
      control: false,
      alt: false,
      meta: false,
      timestamp: 1,
    });
    expect(worker.messages).toHaveLength(workerMessagesBeforeInput);
    expect(sockets[0]!.sent).toHaveLength(socketMessagesBeforeInput + 1);
    expect(JSON.parse(sockets[0]!.sent.at(-1)!)).toMatchObject({
      type: "TerminalInput",
      activationId: attachA.activationId,
      operation: { kind: "key" },
    });

    sockets[0]!.receive(
      encodeRoutedMessage("CellActivationStatus", {
        sessionId: first.id,
        activationId: attachA.activationId,
        cellStatusSequence: 2,
        leaseTtlMs: 10_000,
        acceptedContent: stamp,
        presentation: { state: "presenting" },
        input: { state: "suspended", reason: "lagging" },
      }),
    );
    expect(runtime.routedActivation(first.id)?.presentationReady).toBe(true);
    expect(runtime.routedViewInputAllowed("view-a")).toBe(false);
    const afterSuspension = sockets[0]!.sent.length;
    runtime.sendText(first.id, "view-a", "blocked");
    expect(sockets[0]!.sent).toHaveLength(afterSuspension);

    worker.emit({
      type: "routed-frames-event",
      event: {
        type: "transport-closed",
        cellBootId: "cell-a",
        code: 4004,
        reason: "heartbeat timeout",
        activationIds: [attachA.activationId],
        preAuth: false,
      },
    });
    await flush();
    expect(openTicket).toHaveBeenCalledTimes(3);
    expect(worker.messages.at(-1)).toMatchObject({
      type: "routed-frames-attach",
      request: {
        activationId: attachA.activationId,
        transportGrant: { claims: { transportGrantGeneration: 2 } },
        resume: { resumeToken: "resume-a", from: stamp },
      },
    });
    runtime.dispose();
  });
});
