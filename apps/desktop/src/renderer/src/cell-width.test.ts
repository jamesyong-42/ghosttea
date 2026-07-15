import { describe, expect, it } from "vitest";
import { graphemeCellWidth, splitGraphemes } from "./cell-width";

describe("terminal cell width", () => {
  it("uses one width model for ASCII, full-width, emoji, and supplementary CJK", () => {
    expect(graphemeCellWidth("a")).toBe(1);
    expect(graphemeCellWidth("界")).toBe(2);
    expect(graphemeCellWidth("！")).toBe(2);
    expect(graphemeCellWidth("😀")).toBe(2);
    expect(graphemeCellWidth("𠀀")).toBe(2);
  });

  it("keeps composed graphemes together", () => {
    expect(splitGraphemes("e\u0301👨‍👩‍👧‍👦")).toEqual(["e\u0301", "👨‍👩‍👧‍👦"]);
  });
});
