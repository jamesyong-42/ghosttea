import { describe, expect, it } from "vitest";

import { effectIntermediateTextureCount, specialDrawingCells } from "./webgpu-renderer.js";

describe("WebGPU special-cell classification", () => {
  it("uses terminal columns for mixed ASCII, block, and box cells", () => {
    const cells = specialDrawingCells("a▀b╭c");

    expect([...cells.block]).toEqual([[1, "▀"]]);
    expect([...cells.box]).toEqual([[3, "╭"]]);
  });

  it("falls back to grapheme widths for wide and combining text", () => {
    const cells = specialDrawingCells("日▀e\u0301╭");

    expect([...cells.block]).toEqual([[2, "▀"]]);
    expect([...cells.box]).toEqual([[4, "╭"]]);
  });
});

describe("WebGPU effect targets", () => {
  it("allocates only the intermediates required before the canvas pass", () => {
    expect([0, 1, 2, 3, 4].map(effectIntermediateTextureCount)).toEqual([0, 0, 1, 2, 2]);
  });
});
