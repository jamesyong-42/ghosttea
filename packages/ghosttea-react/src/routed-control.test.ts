import { describe, expect, it } from "vitest";
import {
  DEFAULT_ROUTED_PROTOCOL_LIMITS,
  encodeRoutedMessage,
  type RoutedCellTransportGrant,
  type RoutedSessionAttachGrant,
} from "@vibecook/ghosttea-protocol";
import { RoutedControlTransport, type RoutedControlTransportEvent } from "./routed-control";

class FakeSocket extends EventTarget {
  readyState = 0;
  readonly sent: string[] = [];

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
    const event = new Event("close") as Event & { code: number; reason: string };
    Object.assign(event, { code, reason });
    this.dispatchEvent(event);
  }
}

const cellBootId = "cell-a";
const transportGrant: RoutedCellTransportGrant = {
  protected: {
    v: 1,
    typ: "CellTransportGrant",
    iss: "fieldd",
    alg: "HS256",
    kid: { cellBootId, keyGeneration: 1 },
  },
  claims: {
    audienceCellBootId: cellBootId,
    clientId: "client-a",
    connectionSetId: "set-a",
    allowedChannels: ["control", "frames"],
    transportGrantGeneration: 1,
    issuedAt: 1,
    expiresAt: 2,
    nonce: "nonce-a",
  },
  mac: "opaque",
};
const attachGrant: RoutedSessionAttachGrant = {
  protected: {
    v: 1,
    typ: "SessionAttachGrant",
    iss: "fieldd",
    alg: "HS256",
    kid: { cellBootId, keyGeneration: 1 },
  },
  claims: {
    audienceCellBootId: cellBootId,
    clientId: "client-a",
    sessionId: "session-a",
    leaseEpoch: 1,
    routeRevision: 1,
    grantGeneration: 1,
    rights: ["input", "read"],
    issuedAt: 1,
    expiresAt: 2,
  },
  mac: "opaque",
};

function attach(transport: RoutedControlTransport): void {
  transport.attach({
    cellBootId,
    controlUrl: "ws://127.0.0.1/control",
    transportGrant,
    attachGrant,
    activationId: "activation-a",
    initialDemand: { mode: "live" },
  });
}

describe("main-thread routed control transport", () => {
  it("closes a leg whose heartbeat acknowledgements stop", async () => {
    const socket = new FakeSocket();
    const events: RoutedControlTransportEvent[] = [];
    const transport = new RoutedControlTransport({
      socketFactory: () => socket as unknown as WebSocket,
      emit: (event) => events.push(event),
    });
    attach(transport);
    socket.open();
    socket.receive(
      encodeRoutedMessage("ConnectionAccepted", {
        selectedProtocolVersion: { major: 1, minor: 0 },
        connectionSetId: "set-a",
        channel: "control",
        legGeneration: 1,
        heartbeatTtlMs: 10,
        protocolLimits: DEFAULT_ROUTED_PROTOCOL_LIMITS,
        capabilities: ["resume"],
      }),
    );

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(events).toContainEqual({
      type: "transport-closed",
      cellBootId,
      code: 4004,
      reason: "heartbeat timeout",
      activationIds: ["activation-a"],
      preAuth: false,
    });
    transport.dispose();
  });

  it("preserves structured refusals and distinguishes a silent pre-auth close", () => {
    const refusalSocket = new FakeSocket();
    const refusalEvents: RoutedControlTransportEvent[] = [];
    const refused = new RoutedControlTransport({
      socketFactory: () => refusalSocket as unknown as WebSocket,
      emit: (event) => refusalEvents.push(event),
    });
    attach(refused);
    refusalSocket.open();
    refusalSocket.receive(encodeRoutedMessage("ConnectionRefused", { code: "SET_CHANNEL_BUSY", retryable: true }));
    expect(refusalEvents.at(-1)).toMatchObject({
      type: "transport-closed",
      preAuth: false,
      refusal: { code: "SET_CHANNEL_BUSY", retryable: true },
    });

    const preAuthSocket = new FakeSocket();
    const preAuthEvents: RoutedControlTransportEvent[] = [];
    const preAuth = new RoutedControlTransport({
      socketFactory: () => preAuthSocket as unknown as WebSocket,
      emit: (event) => preAuthEvents.push(event),
    });
    attach(preAuth);
    preAuthSocket.open();
    preAuthSocket.close(1008, "");
    expect(preAuthEvents.at(-1)).toMatchObject({ type: "transport-closed", code: 1008, preAuth: true });
    refused.dispose();
    preAuth.dispose();
  });

  it("rejects control attach acknowledgements that exceed the bound grant", () => {
    const socket = new FakeSocket();
    const events: RoutedControlTransportEvent[] = [];
    const transport = new RoutedControlTransport({
      socketFactory: () => socket as unknown as WebSocket,
      emit: (event) => events.push(event),
    });
    attach(transport);
    socket.open();
    socket.receive(
      encodeRoutedMessage("ConnectionAccepted", {
        selectedProtocolVersion: { major: 1, minor: 0 },
        connectionSetId: "set-a",
        channel: "control",
        legGeneration: 1,
        heartbeatTtlMs: 15_000,
        protocolLimits: DEFAULT_ROUTED_PROTOCOL_LIMITS,
        capabilities: ["resume"],
      }),
    );
    socket.receive(
      encodeRoutedMessage("ControlLegAttached", {
        sessionId: "session-a",
        activationId: "activation-a",
        grantGenerationAccepted: 1,
        rights: ["geometry", "input", "read"],
      }),
    );

    expect(events).toContainEqual(
      expect.objectContaining({ type: "transport-closed", code: 4003, activationIds: ["activation-a"] }),
    );
    expect(events.some((event) => event.type === "control-attached")).toBe(false);
    transport.dispose();
  });

  it("does not let a fire-and-forget release consume another activation's geometry reply", () => {
    const socket = new FakeSocket();
    const events: RoutedControlTransportEvent[] = [];
    const transport = new RoutedControlTransport({
      socketFactory: () => socket as unknown as WebSocket,
      emit: (event) => events.push(event),
    });
    attach(transport);
    const activationB = "activation-b";
    transport.attach({
      cellBootId,
      controlUrl: "ws://127.0.0.1/control",
      transportGrant,
      attachGrant: {
        ...attachGrant,
        claims: { ...attachGrant.claims, sessionId: "session-b" },
      },
      activationId: activationB,
      initialDemand: { mode: "live" },
    });
    socket.open();
    socket.receive(
      encodeRoutedMessage("ConnectionAccepted", {
        selectedProtocolVersion: { major: 1, minor: 0 },
        connectionSetId: "set-a",
        channel: "control",
        legGeneration: 1,
        heartbeatTtlMs: 15_000,
        protocolLimits: DEFAULT_ROUTED_PROTOCOL_LIMITS,
        capabilities: ["resume"],
      }),
    );
    expect(
      transport.releaseGeometry("activation-a", {
        sessionId: "session-a",
        activationId: "activation-a",
        leaseEpoch: 1,
        holder: { clientId: "client-a", viewId: "view-a", holderGeneration: 1 },
      }),
    ).toBe(true);
    expect(
      transport.claimGeometry(activationB, {
        sessionId: "session-b",
        activationId: activationB,
        leaseEpoch: 1,
        claimant: { clientId: "client-a", viewId: "view-b" },
        cols: 80,
        rows: 24,
        expectRevision: 0,
      }),
    ).toBe(true);
    socket.receive(
      encodeRoutedMessage("GeometryCommitted", {
        holder: { clientId: "client-a", viewId: "view-b", holderGeneration: 1 },
        geometryRevision: 1,
        cols: 80,
        rows: 24,
      }),
    );

    expect(events.at(-1)).toMatchObject({ type: "geometry-committed", activationId: activationB });
    transport.dispose();
  });
});
