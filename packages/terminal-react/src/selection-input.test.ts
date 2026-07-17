import { describe, expect, it } from "vitest";
import { usesLocalSelection } from "./selection-input";

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
