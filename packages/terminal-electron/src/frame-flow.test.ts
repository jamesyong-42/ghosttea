import { describe, expect, it } from "vitest";
import {
  FRAME_BRIDGE_CAPABILITY_VERSION,
  FRAME_IN_FLIGHT_HIGH_WATER_BYTES,
  FRAME_IN_FLIGHT_LOW_WATER_BYTES,
  FrameFlowControl,
  requestedFrameBridgeCapabilities,
} from "./frame-flow";

describe("frame flow control", () => {
  it("uses hysteresis to bound queued frame bytes", () => {
    const flow = new FrameFlowControl();

    expect(flow.accept(FRAME_IN_FLIGHT_HIGH_WATER_BYTES - 1)).toBeUndefined();
    expect(flow.accept(1)).toBe("pause");
    expect(flow.paused).toBe(true);
    expect(flow.release(FRAME_IN_FLIGHT_HIGH_WATER_BYTES - FRAME_IN_FLIGHT_LOW_WATER_BYTES - 1)).toBeUndefined();
    expect(flow.release(1)).toBe("resume");
    expect(flow.paused).toBe(false);
    expect(flow.inFlightBytes).toBe(FRAME_IN_FLIGHT_LOW_WATER_BYTES);
  });

  it("rejects duplicate or inflated credits", () => {
    const flow = new FrameFlowControl();
    flow.accept(1024);
    expect(() => flow.release(2048)).toThrow("exceeds in-flight");
    expect(flow.inFlightBytes).toBe(1024);
  });
});

describe("frame bridge capability probes", () => {
  it("answers only safe subscription-shaped requests", () => {
    expect(
      requestedFrameBridgeCapabilities({
        type: "subscribe",
        requestId: 7,
        sessionHandles: [],
        bridgeCapabilities: FRAME_BRIDGE_CAPABILITY_VERSION,
      }),
    ).toEqual({
      type: "bridge-capabilities",
      requestId: 7,
      protocolVersion: FRAME_BRIDGE_CAPABILITY_VERSION,
      frameCredits: true,
    });
    expect(requestedFrameBridgeCapabilities({ type: "frame-credit", requestId: 7 })).toBeUndefined();
    expect(
      requestedFrameBridgeCapabilities({
        type: "subscribe",
        requestId: 7,
        bridgeCapabilities: FRAME_BRIDGE_CAPABILITY_VERSION + 1,
      }),
    ).toBeUndefined();
  });
});
