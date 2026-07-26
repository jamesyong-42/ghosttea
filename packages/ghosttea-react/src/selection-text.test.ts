import { describe, expect, it } from "vitest";
import { selectionText, sliceCells } from "./selection-text";

describe("terminal selection text", () => {
  it("extracts forward and backward selections identically", () => {
    const rows = ["alpha", "bravo"];
    const forward = { anchor: { column: 2, row: 0 }, focus: { column: 2, row: 1 } };
    const backward = { anchor: forward.focus, focus: forward.anchor };
    expect(selectionText(rows, forward)).toBe("pha\nbra");
    expect(selectionText(rows, backward)).toBe("pha\nbra");
  });

  it("selects graphemes by terminal cell width", () => {
    expect(sliceCells("a界b", 1, 2)).toBe("界");
    expect(sliceCells("a界b", 2, 3)).toBe("界b");
  });
});
