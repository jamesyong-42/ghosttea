import { describe, expect, it } from "vitest";
import { adjustSelectionFocus, usesLocalSelection } from "./selection-input";

describe("terminal pointer selection ownership", () => {
  it("selects locally when the terminal application is not tracking the mouse", () => {
    expect(usesLocalSelection(false, false)).toBe(true);
  });

  it("lets a mouse-aware TUI own an unmodified drag", () => {
    expect(usesLocalSelection(true, false)).toBe(false);
  });

  it("uses Shift as the local-selection override for mouse-aware TUIs", () => {
    expect(usesLocalSelection(true, true)).toBe(true);
  });
});

describe("adjustSelectionFocus", () => {
  const geometry = { cols: 10, rows: 5, totalRows: 20 };

  it("moves by cell, line, page, and line extremes", () => {
    expect(adjustSelectionFocus({ column: 3, row: 4 }, "left", geometry)).toEqual({ column: 2, row: 4 });
    expect(adjustSelectionFocus({ column: 3, row: 4 }, "up", geometry)).toEqual({ column: 3, row: 3 });
    expect(adjustSelectionFocus({ column: 3, row: 8 }, "page_up", geometry)).toEqual({ column: 3, row: 3 });
    expect(adjustSelectionFocus({ column: 3, row: 4 }, "beginning_of_line", geometry)).toEqual({
      column: 0,
      row: 4,
    });
    expect(adjustSelectionFocus({ column: 3, row: 4 }, "end_of_line", geometry)).toEqual({
      column: 9,
      row: 4,
    });
  });

  it("clamps home and end to the buffer", () => {
    expect(adjustSelectionFocus({ column: 3, row: 4 }, "home", geometry)).toEqual({ column: 0, row: 0 });
    expect(adjustSelectionFocus({ column: 3, row: 4 }, "end", geometry)).toEqual({ column: 9, row: 19 });
  });
});
