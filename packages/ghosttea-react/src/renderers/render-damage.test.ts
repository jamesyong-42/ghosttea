import { describe, expect, it } from "vitest";
import { rowsForDamage } from "./render-damage.js";

describe("rowsForDamage", () => {
  it("forces every row when the persistent scene is invalid", () => {
    expect(rowsForDamage(4, { full: false, rows: new Set([2]), geometryChanged: true }, false)).toEqual({
      full: true,
      rows: [0, 1, 2, 3],
    });
  });

  it("expands partial damage by one row and clamps, sorts, and deduplicates it", () => {
    expect(rowsForDamage(5, { full: false, rows: new Set([4, 1, 0]), geometryChanged: true }, true)).toEqual({
      full: false,
      rows: [0, 1, 2, 3, 4],
    });
  });

  it("honors explicit full invalidation", () => {
    expect(rowsForDamage(3, { full: true, rows: new Set(), geometryChanged: true }, true)).toEqual({
      full: true,
      rows: [0, 1, 2],
    });
  });
});
