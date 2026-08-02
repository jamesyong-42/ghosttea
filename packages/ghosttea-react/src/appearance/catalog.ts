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

export function findMatchingColorTheme(colors: {
  background: readonly number[];
  foreground: readonly number[];
  cursor: readonly number[];
  cursorText?: readonly number[];
  selectionBackground: readonly number[];
  selectionForeground: readonly number[];
  palette?: readonly { index: number; color: readonly number[] }[];
}): GhostteaColorTheme | undefined {
  const hex = (value: readonly number[]): string =>
    `#${value.map((component) => Math.round(component).toString(16).padStart(2, "0")).join("")}`;
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
    return (
      !colors.palette ||
      colors.palette.every(({ index, color }) => index > 15 || theme.palette[index]?.toLowerCase() === hex(color))
    );
  });
}
