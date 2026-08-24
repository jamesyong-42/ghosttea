import { describe, expect, it } from "vitest";
import { clampConfig, DEFAULT_LAB_CONFIG, expandViews, fitGrid, fitRect, gridNativeSize, percentile } from "./model";

describe("expandViews", () => {
  it("marks the first view of each session as the authority", () => {
    const views = expandViews(2, 3);
    expect(views.map((view) => `${view.viewId}:${view.role}`)).toEqual([
      "s0:v0:authority",
      "s0:v1:mirror",
      "s0:v2:mirror",
      "s1:v0:authority",
      "s1:v1:mirror",
      "s1:v2:mirror",
    ]);
  });
});

describe("fitRect", () => {
  it("letterboxes a wide scene into a tall destination", () => {
    expect(fitRect(200, 100, 100, 100, "letterbox")).toEqual({
      x: 0,
      y: 25,
      width: 100,
      height: 50,
    });
  });

  it("stretches to fill", () => {
    expect(fitRect(200, 100, 50, 80, "stretch")).toEqual({
      x: 0,
      y: 0,
      width: 50,
      height: 80,
    });
  });
});

describe("fitGrid", () => {
  it("keeps 8×16 cells and integer-zooms when the box is larger than the grid", () => {
    const fitted = fitGrid(80, 24, 8, 16, 2000, 2000);
    expect(fitted.scale).toBe(3);
    expect(fitted.width).toBe(1920);
    expect(fitted.height).toBe(1152);
    expect(fitted.x).toBe(40);
    expect(fitted.y).toBe(424);
  });

  it("shrinks fractionally to fit a thumbnail", () => {
    const fitted = fitGrid(80, 24, 8, 16, 160, 90);
    expect(fitted.scale).toBeLessThan(1);
    expect(fitted.width).toBeLessThanOrEqual(160);
    expect(fitted.height).toBeLessThanOrEqual(90);
  });
});

describe("gridNativeSize", () => {
  it("scales the cell grid by device pixel ratio", () => {
    expect(gridNativeSize({ cols: 80, rows: 24, cellWidth: 8, cellHeight: 16 }, 2)).toEqual({
      width: 1280,
      height: 768,
    });
  });
});

describe("clampConfig", () => {
  it("keeps grid-native scene resolution on per-view so cell aspect stays honest", () => {
    const clamped = clampConfig({
      ...DEFAULT_LAB_CONFIG,
      architecture: "per-view-scene",
      sceneResolution: "grid-native",
      devicePerView: true,
    });
    expect(clamped.sceneResolution).toBe("grid-native");
    expect(clamped.devicePerView).toBe(true);
  });

  it("ignores device-per-view on shared architectures", () => {
    const clamped = clampConfig({
      ...DEFAULT_LAB_CONFIG,
      architecture: "shared-scene",
      devicePerView: true,
    });
    expect(clamped.devicePerView).toBe(false);
  });
});

describe("percentile", () => {
  it("returns null for an empty sample", () => {
    expect(percentile([], 99)).toBeNull();
  });

  it("uses the ceiling rank", () => {
    expect(percentile([1, 2, 3, 4], 50)).toBe(2);
    expect(percentile([1, 2, 3, 4], 100)).toBe(4);
  });
});
