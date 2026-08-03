import { describe, expect, it } from "vitest";
import {
  GHOSTTY_COLOR_THEMES,
  GHOSTTY_THEME_CATALOG_REVISION,
  colorThemeFromRenderer,
  findMatchingColorTheme,
} from "./catalog.js";
import { GHOSTTEA_SHADER_OPTIONS, UNAVAILABLE_UPSTREAM_SHADERS } from "./shaders.js";
import { terminalEffectsNeedAnimation } from "../renderers/types.js";

function bytes(color: string): [number, number, number] {
  return [1, 3, 5].map((offset) => Number.parseInt(color.slice(offset, offset + 2), 16)) as [number, number, number];
}

describe("appearance catalogs", () => {
  it("pins all generated Ghostty color themes with complete ANSI palettes", () => {
    expect(GHOSTTY_THEME_CATALOG_REVISION).toBe("875a82f0fdc773ae45099ce683a11c56bb0f8b3d");
    expect(GHOSTTY_COLOR_THEMES).toHaveLength(602);
    expect(new Set(GHOSTTY_COLOR_THEMES.map((theme) => theme.name)).size).toBe(602);
    expect(GHOSTTY_COLOR_THEMES.every((theme) => theme.palette.length === 16)).toBe(true);
  });

  it("uses the ANSI palette to distinguish themes with identical fixed colors", () => {
    const theme = GHOSTTY_COLOR_THEMES.find((candidate) => candidate.name === "Black Metal (Bathory)")!;
    expect(
      findMatchingColorTheme({
        background: bytes(theme.background),
        foreground: bytes(theme.foreground),
        cursor: bytes(theme.cursor),
        cursorText: bytes(theme.cursorText),
        selectionBackground: bytes(theme.selection),
        selectionForeground: bytes(theme.selectionForeground),
        palette: theme.palette.map((color, index) => ({ index, color: bytes(color) })),
      })?.name,
    ).toBe("Black Metal (Bathory)");
  });

  it("does not guess a catalog theme when the effective ANSI palette is sparse", () => {
    const theme = GHOSTTY_COLOR_THEMES[0]!;
    expect(
      findMatchingColorTheme({
        background: bytes(theme.background),
        foreground: bytes(theme.foreground),
        cursor: bytes(theme.cursor),
        cursorText: bytes(theme.cursorText),
        selectionBackground: bytes(theme.selection),
        selectionForeground: bytes(theme.selectionForeground),
        palette: [],
      }),
    ).toBeUndefined();
  });

  it("builds a custom preview from effective colors without selecting a catalog theme", () => {
    const preview = colorThemeFromRenderer({
      background: [1, 2, 3],
      foreground: [250, 251, 252],
      cursor: [4, 5, 6],
      cursorText: [7, 8, 9],
      selectionBackground: [10, 11, 12],
      selectionForeground: [13, 14, 15],
      palette: [{ index: 2, color: [16, 17, 18] }],
    });

    expect(preview).toMatchObject({
      name: "Current custom colors",
      background: "#010203",
      foreground: "#fafbfc",
      cursor: "#040506",
      cursorText: "#070809",
    });
    expect(preview.palette[2]).toBe("#101112");
  });

  it("accounts for every shader in the reviewed upstream snapshot", () => {
    expect(GHOSTTEA_SHADER_OPTIONS).toHaveLength(4);
    expect(UNAVAILABLE_UPSTREAM_SHADERS).toHaveLength(32);
    expect(
      new Set([...GHOSTTEA_SHADER_OPTIONS.map((shader) => shader.name), ...UNAVAILABLE_UPSTREAM_SHADERS]).size,
    ).toBe(36);
    expect(
      GHOSTTEA_SHADER_OPTIONS.map((shader) =>
        terminalEffectsNeedAnimation({ postProcess: "none", shaderEffects: [shader.id], animate: true }),
      ),
    ).toEqual(GHOSTTEA_SHADER_OPTIONS.map((shader) => shader.animated));
  });
});
