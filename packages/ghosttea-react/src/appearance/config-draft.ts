import type { ConfigSnapshot } from "@vibecook/ghosttea-protocol";

export const FRIENDLY_BLOCK_START = "# >>> Ghosttea common settings (managed; edit through Settings)";
export const FRIENDLY_BLOCK_END = "# <<< Ghosttea common settings";

export interface FriendlyConfigValues {
  foreground: string;
  background: string;
  cursor: string;
  cursorText: string;
  selectionBackground: string;
  selectionForeground: string;
  backgroundOpacity: number;
  backgroundOpacityCells: boolean;
  scrollbackLimit: number;
  fontFamilies: string[];
  fontSize: number;
  paddingX: [number, number];
  paddingY: [number, number];
  clearKeybindings: boolean;
  keybindings: string[];
}

export type FriendlyConfigSection = "colors" | "opacity" | "scrollback" | "typography" | "padding" | "keybindings";

const ALL_FRIENDLY_CONFIG_SECTIONS: ReadonlySet<FriendlyConfigSection> = new Set([
  "colors",
  "opacity",
  "scrollback",
  "typography",
  "padding",
  "keybindings",
]);

function colorHex(color: readonly [number, number, number]): string {
  return `#${color.map((component) => component.toString(16).padStart(2, "0")).join("")}`;
}

function finiteNumber(value: number, fallback: number, minimum = 0): number {
  return Number.isFinite(value) && value >= minimum ? value : fallback;
}

export function friendlyValuesFromConfig(config: ConfigSnapshot): FriendlyConfigValues {
  const renderer = config.renderer;
  return {
    foreground: colorHex(renderer.foreground),
    background: colorHex(renderer.background),
    cursor: colorHex(renderer.cursor),
    cursorText: colorHex(renderer.cursorText ?? renderer.background),
    selectionBackground: colorHex(renderer.selectionBackground),
    selectionForeground: colorHex(renderer.selectionForeground),
    backgroundOpacity: renderer.backgroundOpacity ?? 1,
    backgroundOpacityCells: renderer.backgroundOpacityCells ?? false,
    scrollbackLimit: config.terminal.scrollbackBytes,
    fontFamilies: [...renderer.fontFamilies],
    fontSize: renderer.fontSize,
    paddingX: [...renderer.paddingX],
    paddingY: [...renderer.paddingY],
    clearKeybindings: config.workspace.clearKeybindings,
    keybindings: config.workspace.keybindings.map(({ trigger, action }) => `${trigger}=${action}`),
  };
}

function sameValues(left: readonly unknown[], right: readonly unknown[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function colorBytes(value: string): [number, number, number] | undefined {
  if (!/^#[0-9a-f]{6}$/iu.test(value)) return undefined;
  return [1, 3, 5].map((offset) => Number.parseInt(value.slice(offset, offset + 2), 16)) as [number, number, number];
}

/** Fields whose generated override was shadowed by a later included layer. */
export function friendlyConfigMismatches(
  config: ConfigSnapshot,
  values: FriendlyConfigValues,
  sections: ReadonlySet<FriendlyConfigSection> = ALL_FRIENDLY_CONFIG_SECTIONS,
): string[] {
  const mismatches: string[] = [];
  const renderer = config.renderer;
  const checkColor = (label: string, actual: readonly number[], requested: string): void => {
    if (!sameValues(actual, colorBytes(requested) ?? [])) mismatches.push(label);
  };
  if (sections.has("colors")) {
    checkColor("foreground", renderer.foreground, values.foreground);
    checkColor("background", renderer.background, values.background);
    checkColor("cursor", renderer.cursor, values.cursor);
    checkColor("cursor text", renderer.cursorText ?? renderer.background, values.cursorText);
    checkColor("selection", renderer.selectionBackground, values.selectionBackground);
    checkColor("selection text", renderer.selectionForeground, values.selectionForeground);
  }
  if (sections.has("opacity")) {
    if (Math.abs((renderer.backgroundOpacity ?? 1) - Number(values.backgroundOpacity.toFixed(2))) > 0.0001) {
      mismatches.push("background opacity");
    }
    if ((renderer.backgroundOpacityCells ?? false) !== values.backgroundOpacityCells) {
      mismatches.push("cell background opacity");
    }
  }
  if (sections.has("scrollback") && config.terminal.scrollbackBytes !== Math.round(values.scrollbackLimit)) {
    mismatches.push("scrollback limit");
  }
  if (sections.has("typography")) {
    if (!sameValues(renderer.fontFamilies, cleanFontFamilies(values.fontFamilies))) mismatches.push("font families");
    if (renderer.fontSize !== values.fontSize) mismatches.push("font size");
  }
  if (sections.has("padding")) {
    if (!sameValues(renderer.paddingX, values.paddingX)) mismatches.push("horizontal padding");
    if (!sameValues(renderer.paddingY, values.paddingY)) mismatches.push("vertical padding");
  }
  if (sections.has("keybindings")) {
    if (config.workspace.clearKeybindings !== values.clearKeybindings) mismatches.push("default keybindings");
    if (
      !sameValues(
        config.workspace.keybindings.map(({ trigger, action }) => `${trigger}=${action}`),
        cleanKeybindings(values.keybindings),
      )
    ) {
      mismatches.push("keybindings");
    }
  }
  return mismatches;
}

function safeColor(value: string, fallback: string): string {
  return /^#[0-9a-f]{6}$/iu.test(value) ? value.toLowerCase() : fallback;
}

function cleanLines(values: readonly string[]): string[] {
  return values.map((value) => value.replaceAll(/[\r\n]/gu, "").trim()).filter(Boolean);
}

function cleanFontFamilies(values: readonly string[]): string[] {
  return cleanLines(values).map((family) =>
    family.length >= 2 && family.startsWith('"') && family.endsWith('"') ? family.slice(1, -1) : family,
  );
}

function cleanKeybindings(values: readonly string[]): string[] {
  return cleanLines(values).map((binding) => {
    const separator = binding.indexOf("=");
    return separator < 0 ? binding : `${binding.slice(0, separator).trim()}=${binding.slice(separator + 1).trim()}`;
  });
}

function pair(value: readonly [number, number], fallback: readonly [number, number]): [number, number] {
  return [finiteNumber(value[0], fallback[0]), finiteNumber(value[1], fallback[1])];
}

export function friendlyConfigBlock(
  values: FriendlyConfigValues,
  sections: ReadonlySet<FriendlyConfigSection> = ALL_FRIENDLY_CONFIG_SECTIONS,
): string {
  const paddingX = pair(values.paddingX, [2, 2]);
  const paddingY = pair(values.paddingY, [2, 2]);
  const fontFamilies = cleanFontFamilies(values.fontFamilies);
  const keybindings = cleanLines(values.keybindings);
  return [
    FRIENDLY_BLOCK_START,
    "# Only groups changed in the friendly editor are overridden; raw edits elsewhere are preserved.",
    ...(sections.has("colors")
      ? [
          `foreground = ${safeColor(values.foreground, "#ffffff")}`,
          `background = ${safeColor(values.background, "#000000")}`,
          `cursor-color = ${safeColor(values.cursor, values.foreground)}`,
          `cursor-text = ${safeColor(values.cursorText, values.background)}`,
          `selection-background = ${safeColor(values.selectionBackground, values.foreground)}`,
          `selection-foreground = ${safeColor(values.selectionForeground, values.background)}`,
        ]
      : []),
    ...(sections.has("opacity")
      ? [
          `background-opacity = ${Math.min(1, finiteNumber(values.backgroundOpacity, 1)).toFixed(2)}`,
          `background-opacity-cells = ${values.backgroundOpacityCells}`,
        ]
      : []),
    ...(sections.has("scrollback")
      ? [`scrollback-limit = ${Math.round(finiteNumber(values.scrollbackLimit, 10_000_000))}`]
      : []),
    ...(sections.has("typography")
      ? [
          "font-family =",
          ...fontFamilies.map((family) => `font-family = ${family}`),
          `font-size = ${finiteNumber(values.fontSize, 13, Number.EPSILON)}`,
        ]
      : []),
    ...(sections.has("padding")
      ? [`window-padding-x = ${paddingX.join(",")}`, `window-padding-y = ${paddingY.join(",")}`]
      : []),
    ...(sections.has("keybindings")
      ? [
          values.clearKeybindings ? "keybind = clear" : "keybind =",
          ...keybindings.map((binding) => `keybind = ${binding}`),
        ]
      : []),
    FRIENDLY_BLOCK_END,
  ].join("\n");
}

interface ManagedBlockRange {
  start: number;
  end: number;
}

function managedBlockRange(contents: string): ManagedBlockRange | undefined {
  const start = contents.indexOf(FRIENDLY_BLOCK_START);
  const end = contents.indexOf(FRIENDLY_BLOCK_END);
  const duplicateStart = start >= 0 && contents.indexOf(FRIENDLY_BLOCK_START, start + FRIENDLY_BLOCK_START.length) >= 0;
  const duplicateEnd = end >= 0 && contents.indexOf(FRIENDLY_BLOCK_END, end + FRIENDLY_BLOCK_END.length) >= 0;
  if (start < 0 !== end < 0 || (start >= 0 && end < start) || duplicateStart || duplicateEnd) {
    throw new Error("The managed common-settings block in config.ghostty is malformed");
  }
  return start < 0 ? undefined : { start, end: end + FRIENDLY_BLOCK_END.length };
}

export function friendlyConfigSections(contents: string): Set<FriendlyConfigSection> {
  let range: ManagedBlockRange | undefined;
  try {
    range = managedBlockRange(contents);
  } catch {
    return new Set();
  }
  if (!range) return new Set();
  const sections = new Set<FriendlyConfigSection>();
  for (const line of contents.slice(range.start, range.end).split(/\r?\n/u)) {
    const key = line.split("=", 1)[0]?.trim();
    if (
      [
        "foreground",
        "background",
        "cursor-color",
        "cursor-text",
        "selection-background",
        "selection-foreground",
      ].includes(key ?? "")
    ) {
      sections.add("colors");
    } else if (key === "background-opacity" || key === "background-opacity-cells") {
      sections.add("opacity");
    } else if (key === "scrollback-limit") {
      sections.add("scrollback");
    } else if (key === "font-family" || key === "font-size") {
      sections.add("typography");
    } else if (key === "window-padding-x" || key === "window-padding-y") {
      sections.add("padding");
    } else if (key === "keybind") {
      sections.add("keybindings");
    }
  }
  return sections;
}

export function patchFriendlyConfigBlock(
  contents: string,
  values: FriendlyConfigValues,
  sections: ReadonlySet<FriendlyConfigSection> = ALL_FRIENDLY_CONFIG_SECTIONS,
): string {
  if (sections.size === 0) return removeFriendlyConfigBlock(contents);
  const newline = contents.includes("\r\n") ? "\r\n" : "\n";
  const range = managedBlockRange(contents);
  const withoutBlock = range ? `${contents.slice(0, range.start)}${contents.slice(range.end)}` : contents;
  const prefix = withoutBlock.trimEnd();
  const block = friendlyConfigBlock(values, sections).replaceAll("\n", newline);
  return `${prefix}${prefix ? newline.repeat(2) : ""}${block}${newline}`;
}

export function removeFriendlyConfigBlock(contents: string): string {
  const range = managedBlockRange(contents);
  if (!range) return contents;
  const before = contents.slice(0, range.start).trimEnd();
  const after = contents.slice(range.end).trimStart();
  const newline = contents.includes("\r\n") ? "\r\n" : "\n";
  return `${before}${before && after ? newline.repeat(2) : ""}${after}`;
}

export function hasFriendlyConfigBlock(contents: string): boolean {
  try {
    return managedBlockRange(contents) !== undefined;
  } catch {
    return contents.includes(FRIENDLY_BLOCK_START) || contents.includes(FRIENDLY_BLOCK_END);
  }
}
