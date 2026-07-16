import { describe, expect, it } from "vitest";
import { accumulateWheelRows, wheelDeltaPixels } from "./scroll-input";

describe("terminal wheel normalization", () => {
  it("retains precise sub-row movement across momentum events", () => {
    const first = accumulateWheelRows(0, wheelDeltaPixels(4, 0, 24, 19), 19);
    expect(first).toEqual({ rows: 0, remainder: 8 });
    const second = accumulateWheelRows(first.remainder, wheelDeltaPixels(6, 0, 24, 19), 19);
    expect(second).toEqual({ rows: 1, remainder: 1 });
  });

  it("normalizes line and page wheel devices", () => {
    expect(wheelDeltaPixels(3, 1, 24, 19)).toBe(57);
    expect(wheelDeltaPixels(-1, 2, 24, 19)).toBe(-456);
  });
});
