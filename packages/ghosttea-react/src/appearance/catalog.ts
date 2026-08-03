import catalog from "./theme-catalog.generated.json";

export interface GhostteaColorTheme {
  name: string;
  background: string;
  foreground: string;
  cursor: string;
  cursorText: string;
  selection: string;
  selectionForeground: string;
  palette: string[];
}

export const GHOSTTY_THEME_CATALOG_SOURCE = catalog.source;
export const GHOSTTY_THEME_CATALOG_REVISION = catalog.revision;
export const GHOSTTY_COLOR_THEMES = catalog.themes as GhostteaColorTheme[];

function hex(value: readonly number[]): string {
  return `#${value.map((component) => Math.round(component).toString(16).padStart(2, "0")).join("")}`;
}

/** Build a preview-only theme without inventing missing sparse palette entries. */
export function colorThemeFromRenderer(
  colors: {
    background: readonly number[];
    foreground: readonly number[];
    cursor: readonly number[];
    cursorText?: readonly number[];
    selectionBackground: readonly number[];
    selectionForeground: readonly number[];
    palette?: readonly { index: number; color: readonly number[] }[];
  },
  name = "Current custom colors",
): GhostteaColorTheme {
  const background = hex(colors.background);
  const foreground = hex(colors.foreground);
  const palette = Array<string>(16).fill(foreground);
  palette[0] = background;
  for (const entry of colors.palette ?? []) {
    if (entry.index >= 0 && entry.index < palette.length) palette[entry.index] = hex(entry.color);
  }
  return {
    name,
    background,
    foreground,
    cursor: hex(colors.cursor),
    cursorText: hex(colors.cursorText ?? colors.background),
    selection: hex(colors.selectionBackground),
    selectionForeground: hex(colors.selectionForeground),
    palette,
  };
}

export function findMatchingColorTheme(colors: {
  background: readonly number[];
  foreground: readonly number[];
  cursor: readonly number[];
  cursorText?: readonly number[];
  selectionBackground: readonly number[];
  selectionForeground: readonly number[];
  palette?: readonly { index: number; color: readonly number[] }[];
}): GhostteaColorTheme | undefined {
  const expected = [
    hex(colors.background),
    hex(colors.foreground),
    hex(colors.cursor),
    hex(colors.cursorText ?? colors.background),
    hex(colors.selectionBackground),
    hex(colors.selectionForeground),
  ].join(":");
  return GHOSTTY_COLOR_THEMES.find((theme) => {
    const fixedColors = [
      theme.background,
      theme.foreground,
      theme.cursor,
      theme.cursorText,
      theme.selection,
      theme.selectionForeground,
    ].join(":");
    if (fixedColors !== expected) return false;
    const palette = new Map(
      (colors.palette ?? []).filter(({ index }) => index >= 0 && index <= 15).map(({ index, color }) => [index, color]),
    );
    // Fixed colors alone are not enough evidence: several catalog themes
    // share them, and writing a guessed theme would add a different ANSI
    // palette. Keep the current colors custom unless all 16 entries match.
    return (
      palette.size === 16 && theme.palette.every((color, index) => color.toLowerCase() === hex(palette.get(index)!))
    );
  });
}
