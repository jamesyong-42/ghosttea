import { describe, expect, it } from "vitest";
import {
  DEFAULT_ROUTED_PROTOCOL_LIMITS,
  DEFAULT_ROUTED_RECEIVER_CAPACITIES,
  encodeRoutedMessage,
  encodeRoutedPresentationEnvelope,
  routedCrc32c,
  type RoutedCellTransportGrant,
  type RoutedPresentationEnvelopeHeader,
  type RoutedSessionAttachGrant,
} from "@vibecook/ghosttea-protocol";
import { RoutedFramesTransport, type RoutedFramesTransportEvent } from "./routed-frames";

class FakeSocket extends EventTarget {
  readyState = 0;
  binaryType = "blob";
  readonly sent: Array<string | ArrayBufferLike | Blob | ArrayBufferView> = [];

  send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
    this.sent.push(data);
  }

  open(): void {
    this.readyState = 1;
    this.dispatchEvent(new Event("open"));
  }

  receive(data: string | ArrayBuffer): void {
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
const sessionId = "session-a";
const activationId = "activation-a";

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
    clientId: "window",
    connectionSetId: "set-a",
    allowedChannels: ["control", "frames"],
    transportGrantGeneration: 1,
    issuedAt: 1,
    expiresAt: 2,
    nonce: "nonce",
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
    clientId: "window",
    sessionId,
    leaseEpoch: 4,
    routeRevision: 1,
    grantGeneration: 1,
    rights: ["input", "read"],
    issuedAt: 1,
    expiresAt: 2,
  },
  mac: "opaque",
};

function stamp(revision: number) {
  return { sceneEpoch: { cellBootId, modelGeneration: 1 }, sceneRevision: revision };
}

describe("worker-owned routed frames transport", () => {
  it("uses calibration pings as frames-leg liveness and accepts the bounded echo", async () => {
    const socket = new FakeSocket();
    const events: RoutedFramesTransportEvent[] = [];
    const transport = new RoutedFramesTransport({
      socketFactory: () => socket as unknown as WebSocket,
      applyFrame: () => ({ sessionHandle: "11", viewHandle: "12", cols: 80, rows: 24 }),
      emit: (event) => events.push(event),
    });
    transport.attach({
      cellBootId,
      sessionHandle: "11",
      framesUrl: "ws://127.0.0.1/frames",
      transportGrant,
      attachGrant,
      activationId,
    });
    socket.open();
    socket.receive(
      encodeRoutedMessage("ConnectionAccepted", {
        selectedProtocolVersion: { major: 1, minor: 0 },
        connectionSetId: "set-a",
        channel: "frames",
        legGeneration: 1,
        heartbeatTtlMs: 300,
        creditEpoch: 1,
        initialWindows: DEFAULT_ROUTED_RECEIVER_CAPACITIES,
        protocolLimits: DEFAULT_ROUTED_PROTOCOL_LIMITS,
        capabilities: ["resume"],
      }),
    );

    await new Promise((resolve) => setTimeout(resolve, 120));
    const ping = socket.sent
      .filter((item): item is string => typeof item === "string")
      .map((item) => JSON.parse(item) as { type: string; sequence?: number; t0?: number })
      .find((item) => item.type === "CalibrationPing");
    expect(ping).toMatchObject({ type: "CalibrationPing", sequence: 1, t0: expect.any(Number) });
    socket.receive(
      encodeRoutedPresentationEnvelope(
        {
          creditEpoch: 1,
          activationSequence: 0,
          sessionId: "-",
          activationId: "-",
          leaseEpoch: 0,
          kind: "calibration",
          calibration: { sequence: ping!.sequence!, t0: ping!.t0!, t1: Date.now(), t2: Date.now() },
        },
        new Uint8Array(),
      ).buffer as ArrayBuffer,
    );
    expect(events.some((event) => event.type === "transport-closed")).toBe(false);
    transport.dispose();
  });

  it("rejects windows larger than the worker advertised", () => {
    const socket = new FakeSocket();
    const events: RoutedFramesTransportEvent[] = [];
    const transport = new RoutedFramesTransport({
      socketFactory: () => socket as unknown as WebSocket,
      applyFrame: () => ({ sessionHandle: "11", viewHandle: "12", cols: 80, rows: 24 }),
      emit: (event) => events.push(event),
    });
    transport.attach({
      cellBootId,
      sessionHandle: "11",
      framesUrl: "ws://127.0.0.1/frames",
      transportGrant,
      attachGrant,
      activationId,
    });
    socket.open();
    socket.receive(
      encodeRoutedMessage("ConnectionAccepted", {
        selectedProtocolVersion: { major: 1, minor: 0 },
        connectionSetId: "set-a",
        channel: "frames",
        legGeneration: 1,
        heartbeatTtlMs: 15_000,
        creditEpoch: 1,
        initialWindows: {
          ...DEFAULT_ROUTED_RECEIVER_CAPACITIES,
          connectionCreditBytes: DEFAULT_ROUTED_RECEIVER_CAPACITIES.connectionCreditBytes + 1,
        },
        protocolLimits: DEFAULT_ROUTED_PROTOCOL_LIMITS,
        capabilities: ["resume"],
      }),
    );

    expect(events).toContainEqual(
      expect.objectContaining({ type: "transport-closed", code: 4003, activationIds: [activationId] }),
    );
    expect(
      socket.sent
        .filter((item): item is string => typeof item === "string")
        .map((item) => JSON.parse(item) as { type: string })
        .some((item) => item.type === "AttachFramesLeg"),
    ).toBe(false);
    transport.dispose();
  });

  it("omits resume when the frames connection did not negotiate it", () => {
    const socket = new FakeSocket();
    const events: RoutedFramesTransportEvent[] = [];
    const transport = new RoutedFramesTransport({
      socketFactory: () => socket as unknown as WebSocket,
      applyFrame: () => ({ sessionHandle: "11", viewHandle: "12", cols: 80, rows: 24 }),
      emit: (event) => events.push(event),
    });
    transport.attach({
      cellBootId,
      sessionHandle: "11",
      framesUrl: "ws://127.0.0.1/frames",
      transportGrant,
      attachGrant,
      activationId,
      resume: { resumeToken: "resume-a", from: stamp(1) },
      capabilities: ["resume"],
    });
    socket.open();
    socket.receive(
      encodeRoutedMessage("ConnectionAccepted", {
        selectedProtocolVersion: { major: 1, minor: 0 },
        connectionSetId: "set-a",
        channel: "frames",
        legGeneration: 1,
        heartbeatTtlMs: 15_000,
        creditEpoch: 1,
        initialWindows: DEFAULT_ROUTED_RECEIVER_CAPACITIES,
        protocolLimits: DEFAULT_ROUTED_PROTOCOL_LIMITS,
        capabilities: [],
      }),
    );

    const sent = JSON.parse(socket.sent.at(-1) as string) as Record<string, unknown>;
    expect(sent.type).toBe("AttachFramesLeg");
    expect(sent).not.toHaveProperty("resume");
    socket.receive(
      encodeRoutedMessage("FramesLegAttached", {
        sessionId,
        activationId,
        resumeToken: "resume-b",
        trfIdentity: { sessionHandle: "11", viewHandle: "12" },
        outcome: { kind: "seed-required", reason: "no-resume-capability" },
      }),
    );
    expect(events.some((event) => event.type === "transport-closed")).toBe(false);
    transport.dispose();
  });

  it("applies envelopes without a main-thread relay and stages catch-up atomically", async () => {
    const socket = new FakeSocket();
    const events: RoutedFramesTransportEvent[] = [];
    const applies: Uint8Array[] = [];
    const transport = new RoutedFramesTransport({
      socketFactory: () => socket as unknown as WebSocket,
      applyFrame: (packet, identity, expectedLayout) => {
        expect(identity).toEqual({ sessionHandle: "11", viewHandle: "12" });
        if (expectedLayout) expect(expectedLayout).toEqual({ cols: 80, rows: 24, scrollbackRows: 0 });
        applies.push(new Uint8Array(packet).slice());
        return { sessionHandle: "11", viewHandle: "12", cols: 80, rows: 24 };
      },
      emit: (event) => events.push(event),
    });
    transport.attach({
      cellBootId,
      sessionHandle: "11",
      framesUrl: "ws://127.0.0.1/frames",
      transportGrant,
      attachGrant,
      activationId,
      capabilities: ["resume"],
    });
    socket.open();
    expect(JSON.parse(socket.sent[0] as string)).toMatchObject({ type: "ConnectionHello", channel: "frames" });
    socket.receive(
      encodeRoutedMessage("ConnectionAccepted", {
        selectedProtocolVersion: { major: 1, minor: 0 },
        connectionSetId: "set-a",
        channel: "frames",
        legGeneration: 1,
        heartbeatTtlMs: 15_000,
        creditEpoch: 1,
        initialWindows: DEFAULT_ROUTED_RECEIVER_CAPACITIES,
        protocolLimits: DEFAULT_ROUTED_PROTOCOL_LIMITS,
        capabilities: ["resume"],
      }),
    );
    expect(JSON.parse(socket.sent.at(-1) as string)).toMatchObject({ type: "AttachFramesLeg", activationId });
    socket.receive(
      encodeRoutedMessage("FramesLegAttached", {
        sessionId,
        activationId,
        resumeToken: "resume-a",
        trfIdentity: { sessionHandle: "11", viewHandle: "12" },
        outcome: { kind: "seed-required", reason: "no-cursor" },
      }),
    );

    const fullHeader: RoutedPresentationEnvelopeHeader = {
      creditEpoch: 1,
      activationSequence: 1,
      sessionId,
      activationId,
      leaseEpoch: 4,
      kind: "trf1-frame",
      baseContent: null,
      resultContent: stamp(1),
    };
    socket.receive(encodeRoutedPresentationEnvelope(fullHeader, Uint8Array.of(9, 8, 7)).buffer as ArrayBuffer);
    expect(applies).toEqual([Uint8Array.of(9, 8, 7)]);
    expect(events).toContainEqual(
      expect.objectContaining({ type: "frames-state", activationId, state: "active", appliedContent: stamp(1) }),
    );
    expect(socket.sent.map((item) => (typeof item === "string" ? JSON.parse(item).type : "binary"))).toContain(
      "SceneApplied",
    );

    const staged = Uint8Array.of(1, 2, 3, 4);
    const begin: RoutedPresentationEnvelopeHeader = {
      creditEpoch: 1,
      activationSequence: 2,
      sessionId,
      activationId,
      leaseEpoch: 4,
      kind: "transfer-begin",
      baseContent: stamp(1),
      resultContent: stamp(2),
      transfer: {
        transferId: "catchup-1",
        kind: "catchup",
        totalBytes: staged.byteLength,
        chunkCount: 2,
        targetLayout: { cols: 80, rows: 24, scrollbackRows: 0 },
        checksum: { alg: "crc32c", value: routedCrc32c(staged) },
      },
    };
    socket.receive(encodeRoutedPresentationEnvelope(begin, new Uint8Array()).buffer as ArrayBuffer);
    for (const [index, payload] of [staged.subarray(0, 2), staged.subarray(2)].entries()) {
      socket.receive(
        encodeRoutedPresentationEnvelope(
          {
            creditEpoch: 1,
            activationSequence: 3 + index,
            sessionId,
            activationId,
            leaseEpoch: 4,
            kind: "transfer-chunk",
            transfer: { transferId: "catchup-1", chunkIndex: index, byteOffset: index * 2 },
          },
          payload,
        ).buffer as ArrayBuffer,
      );
    }
    expect(applies).toHaveLength(1);
    socket.receive(
      encodeRoutedPresentationEnvelope(
        {
          creditEpoch: 1,
          activationSequence: 5,
          sessionId,
          activationId,
          leaseEpoch: 4,
          kind: "transfer-end",
          transfer: { transferId: "catchup-1" },
        },
        new Uint8Array(),
      ).buffer as ArrayBuffer,
    );
    expect(applies).toEqual([Uint8Array.of(9, 8, 7), staged]);

    await new Promise((resolve) => setTimeout(resolve, 25));
    const credits = socket.sent
      .filter((item): item is string => typeof item === "string")
      .map((item) => JSON.parse(item) as Record<string, unknown>)
      .filter((item) => item.type === "TransportCredit");
    expect(credits.at(-1)).toMatchObject({
      creditEpoch: 1,
      connectionBytesReturned: expect.any(Number),
      accounts: [expect.objectContaining({ activationId, bytesReturned: expect.any(Number) })],
    });
    transport.dispose();
  });

  it("preserves scene and status continuity when the same activation resumes", () => {
    const socket = new FakeSocket();
    const events: RoutedFramesTransportEvent[] = [];
    const applies: Uint8Array[] = [];
    const transport = new RoutedFramesTransport({
      socketFactory: () => socket as unknown as WebSocket,
      applyFrame: (packet) => {
        applies.push(new Uint8Array(packet).slice());
        return { sessionHandle: "11", viewHandle: "12", cols: 80, rows: 24 };
      },
      emit: (event) => events.push(event),
    });
    const request = {
      cellBootId,
      sessionHandle: "11",
      framesUrl: "ws://127.0.0.1/frames",
      transportGrant,
      attachGrant,
      activationId,
      capabilities: ["resume"],
    };
    transport.attach(request);
    socket.open();
    socket.receive(
      encodeRoutedMessage("ConnectionAccepted", {
        selectedProtocolVersion: { major: 1, minor: 0 },
        connectionSetId: "set-a",
        channel: "frames",
        legGeneration: 1,
        heartbeatTtlMs: 15_000,
        creditEpoch: 1,
        initialWindows: DEFAULT_ROUTED_RECEIVER_CAPACITIES,
        protocolLimits: DEFAULT_ROUTED_PROTOCOL_LIMITS,
        capabilities: ["resume"],
      }),
    );
    socket.receive(
      encodeRoutedMessage("FramesLegAttached", {
        sessionId,
        activationId,
        resumeToken: "resume-a",
        trfIdentity: { sessionHandle: "11", viewHandle: "12" },
        outcome: { kind: "seed-required", reason: "no-cursor" },
      }),
    );
    socket.receive(
      encodeRoutedPresentationEnvelope(
        {
          creditEpoch: 1,
          activationSequence: 1,
          sessionId,
          activationId,
          leaseEpoch: 4,
          kind: "trf1-frame",
          baseContent: null,
          resultContent: stamp(1),
        },
        Uint8Array.of(1),
      ).buffer as ArrayBuffer,
    );

    transport.attach({ ...request, resume: { resumeToken: "resume-a", from: stamp(1) } });
    expect(JSON.parse(socket.sent.at(-1) as string)).toMatchObject({
      type: "AttachFramesLeg",
      activationId,
      resume: { resumeToken: "resume-a", from: stamp(1) },
    });
    socket.receive(
      encodeRoutedMessage("FramesLegAttached", {
        sessionId,
        activationId,
        resumeToken: "resume-a",
        trfIdentity: { sessionHandle: "11", viewHandle: "12" },
        outcome: { kind: "resume-accepted", from: stamp(1), newestAvailable: stamp(2) },
      }),
    );
    socket.receive(
      encodeRoutedPresentationEnvelope(
        {
          creditEpoch: 1,
          activationSequence: 2,
          sessionId,
          activationId,
          leaseEpoch: 4,
          kind: "trf1-frame",
          baseContent: stamp(1),
          resultContent: stamp(2),
        },
        Uint8Array.of(2),
      ).buffer as ArrayBuffer,
    );

    expect(applies).toEqual([Uint8Array.of(1), Uint8Array.of(2)]);
    expect(
      events
        .filter(
          (event): event is Extract<RoutedFramesTransportEvent, { type: "presentation-status" }> =>
            event.type === "presentation-status",
        )
        .map((event) => event.status.workerStatusSequence),
    ).toEqual([1, 2, 3, 4]);
    expect(events.some((event) => event.type === "transport-closed")).toBe(false);
    transport.dispose();
  });

  it("protocol-closes a frames connection that names another cell's activation", () => {
    const sockets = [new FakeSocket(), new FakeSocket()];
    const events: RoutedFramesTransportEvent[] = [];
    const cellB = "cell-b";
    const activationB = "activation-b";
    const transportGrantB: RoutedCellTransportGrant = {
      ...transportGrant,
      protected: {
        ...transportGrant.protected,
        kid: { ...transportGrant.protected.kid, cellBootId: cellB },
      },
      claims: {
        ...transportGrant.claims,
        audienceCellBootId: cellB,
        connectionSetId: "set-b",
        nonce: "nonce-b",
      },
    };
    const attachGrantB: RoutedSessionAttachGrant = {
      ...attachGrant,
      protected: {
        ...attachGrant.protected,
        kid: { ...attachGrant.protected.kid, cellBootId: cellB },
      },
      claims: {
        ...attachGrant.claims,
        audienceCellBootId: cellB,
        sessionId: "session-b",
      },
    };
    const transport = new RoutedFramesTransport({
      socketFactory: () => sockets.shift()! as unknown as WebSocket,
      applyFrame: () => ({ sessionHandle: "11", viewHandle: "12", cols: 80, rows: 24 }),
      emit: (event) => events.push(event),
    });
    const socketA = sockets[0]!;
    const socketB = sockets[1]!;
    transport.attach({
      cellBootId,
      sessionHandle: "11",
      framesUrl: "ws://127.0.0.1/cell-a/frames",
      transportGrant,
      attachGrant,
      activationId,
    });
    transport.attach({
      cellBootId: cellB,
      sessionHandle: "21",
      framesUrl: "ws://127.0.0.1/cell-b/frames",
      transportGrant: transportGrantB,
      attachGrant: attachGrantB,
      activationId: activationB,
    });
    for (const [socket, setId] of [
      [socketA, "set-a"],
      [socketB, "set-b"],
    ] as const) {
      socket.open();
      socket.receive(
        encodeRoutedMessage("ConnectionAccepted", {
          selectedProtocolVersion: { major: 1, minor: 0 },
          connectionSetId: setId,
          channel: "frames",
          legGeneration: 1,
          heartbeatTtlMs: 15_000,
          creditEpoch: 1,
          initialWindows: DEFAULT_ROUTED_RECEIVER_CAPACITIES,
          protocolLimits: DEFAULT_ROUTED_PROTOCOL_LIMITS,
          capabilities: ["resume"],
        }),
      );
    }

    socketA.receive(
      encodeRoutedMessage("AttachRefused", {
        activationId: activationB,
        code: "GRANT_INVALID",
        retryable: false,
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "transport-closed",
        cellBootId,
        code: 4003,
        activationIds: [activationId],
      }),
    );
    expect(events).not.toContainEqual(
      expect.objectContaining({ type: "frames-state", activationId: activationB, state: "failed" }),
    );
    transport.dispose();
  });
});
