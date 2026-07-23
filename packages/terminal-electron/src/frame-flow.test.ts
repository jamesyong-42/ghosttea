import { describe, expect, it } from "vitest";
import { FRAME_IN_FLIGHT_HIGH_WATER_BYTES, FRAME_IN_FLIGHT_LOW_WATER_BYTES, FrameFlowControl } from "./frame-flow";

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
