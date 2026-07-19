import { describe, expect, it } from "vitest";
import { renderedSizeChanged } from "./types.js";

describe("renderedSizeChanged", () => {
  it("ignores CSS jitter that rounds to the same physical canvas", () => {
    expect(renderedSizeChanged({ width: 1200, height: 800, dpr: 2 }, { width: 1199.8, height: 799.8, dpr: 2 })).toBe(
      false,
    );
  });

  it("detects physical-pixel and device-pixel-ratio changes", () => {
    expect(renderedSizeChanged({ width: 1200, height: 800, dpr: 2 }, { width: 1199.7, height: 800, dpr: 2 })).toBe(
      true,
    );
    expect(renderedSizeChanged({ width: 1200, height: 800, dpr: 2 }, { width: 2400, height: 1600, dpr: 1 })).toBe(true);
  });
});
