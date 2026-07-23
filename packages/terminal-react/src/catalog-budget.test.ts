import { describe, expect, it } from "vitest";
import { catalogAdmission, definitionCatalogFits, glyphCatalogFits } from "./catalog-budget";

const glyph = (id: number, bytes: number) => ({ id, pixels: new Uint8Array(bytes) });

describe("catalog admission", () => {
  it("falls back only for an oversized self-contained snapshot", () => {
    expect(catalogAdmission(false, false, false)).toBe("request-full");
    expect(catalogAdmission(true, false, false)).toBe("text-fallback");
    expect(catalogAdmission(false, true, false)).toBe("text-fallback");
    expect(catalogAdmission(true, true, true)).toBe("install");
  });

  it("preflights a whole glyph batch without relying on partial installation", () => {
    const installed = new Map([[1, glyph(1, 4)]]);
    const shared = new Map([[2, { definition: glyph(2, 6) }]]);
    const budget = {
      maxDefinitions: 3,
      maxSharedDefinitions: 3,
      maxSessionPixelBytes: 14,
      maxSharedPixelBytes: 20,
    };

    expect(glyphCatalogFits(installed, 4, shared, 6, [glyph(2, 99), glyph(3, 5)], budget)).toBe(false);
    expect(installed.size).toBe(1);
    expect(shared.size).toBe(1);
  });

  it("counts repeated and already-installed definitions only once", () => {
    const installed = new Map([[1, glyph(1, 4)]]);
    const shared = new Map<number, { definition: ReturnType<typeof glyph> }>();
    const budget = {
      maxDefinitions: 2,
      maxSharedDefinitions: 2,
      maxSessionPixelBytes: 8,
      maxSharedPixelBytes: 4,
    };
    const repeated = glyph(2, 4);

    expect(glyphCatalogFits(installed, 4, shared, 0, [installed.get(1)!, repeated, repeated], budget)).toBe(true);
    expect(definitionCatalogFits(new Map([[1, { id: 1 }]]), [{ id: 1 }, { id: 2 }, { id: 2 }], 2)).toBe(true);
  });

  it("bounds shared glyph metadata even when definitions have no pixel payload", () => {
    const shared = new Map([[1, { definition: glyph(1, 0) }]]);
    const budget = {
      maxDefinitions: 2,
      maxSharedDefinitions: 1,
      maxSessionPixelBytes: 10,
      maxSharedPixelBytes: 10,
    };

    expect(glyphCatalogFits(new Map(), 0, shared, 0, [glyph(2, 0)], budget)).toBe(false);
  });

  it("rejects an oversized style batch atomically", () => {
    const installed = new Map([[1, { id: 1 }]]);

    expect(definitionCatalogFits(installed, [{ id: 2 }, { id: 3 }], 2)).toBe(false);
    expect(definitionCatalogFits(installed, [{ id: 2 }], 2, 4, 4)).toBe(false);
    expect([...installed.keys()]).toEqual([1]);
  });
});
