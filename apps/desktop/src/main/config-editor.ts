import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ConfigSnapshot } from "@vibecook/ghosttea-protocol";

export const MAX_CONFIG_EDITOR_BYTES = 64 * 1024;

export interface ConfigSaveRequest {
  expectedRevision: string;
  contents: string;
}

export function validateConfigContents(payload: unknown): string {
  if (typeof payload !== "string") throw new Error("Configuration contents must be UTF-8 text");
  const bytes = Buffer.byteLength(payload, "utf8");
  if (bytes > MAX_CONFIG_EDITOR_BYTES) {
    throw new Error(`Configuration is ${bytes} bytes; maximum is ${MAX_CONFIG_EDITOR_BYTES} bytes`);
  }
  return payload;
}

export function validateConfigSaveRequest(payload: unknown): ConfigSaveRequest {
  if (!payload || typeof payload !== "object") throw new Error("Invalid configuration save request");
  const candidate = payload as Record<string, unknown>;
  if (
    typeof candidate.expectedRevision !== "string" ||
    candidate.expectedRevision.length < 1 ||
    candidate.expectedRevision.length > 256
  ) {
    throw new Error("Invalid configuration document revision");
  }
  return {
    expectedRevision: candidate.expectedRevision,
    contents: validateConfigContents(candidate.contents),
  };
}

export function trustedConfigEditorRendererUrl(
  value: string,
  developmentUrl: string | undefined,
  packagedFile: string,
): boolean {
  try {
    const actual = new URL(value);
    if (developmentUrl) return actual.origin === new URL(developmentUrl).origin;
    return actual.protocol === "file:" && resolve(fileURLToPath(actual)) === resolve(packagedFile);
  } catch {
    return false;
  }
}

function colorHex(color: readonly [number, number, number]): string {
  return `#${color.map((component) => component.toString(16).padStart(2, "0")).join("")}`;
}

function pair(values: readonly [number, number]): string {
  return values[0] === values[1] ? String(values[0]) : `${values[0]},${values[1]}`;
}

/**
 * Snapshot Ghosttea's supported projection of inherited Ghostty files.
 * Unsupported source text and relative includes are deliberately not copied.
 */
export function serializeSupportedGhosttyConfig(config: ConfigSnapshot): string {
  const renderer = config.renderer;
  const shaderEffects =
    renderer.shaderEffects && renderer.shaderEffects.length > 0
      ? renderer.shaderEffects
      : renderer.postProcess === "better-crt"
        ? ["ghosttea:better-crt"]
        : [];
  return [
    "# Supported settings imported from the detected Ghostty configuration.",
    "# Ghosttea generated this projection; source files and relative includes were not copied.",
    `foreground = ${colorHex(renderer.foreground)}`,
    `background = ${colorHex(renderer.background)}`,
    `cursor-color = ${colorHex(renderer.cursor)}`,
    `cursor-text = ${colorHex(renderer.cursorText ?? renderer.background)}`,
    `selection-background = ${colorHex(renderer.selectionBackground)}`,
    `selection-foreground = ${colorHex(renderer.selectionForeground)}`,
    "palette =",
    ...(renderer.palette ?? [])
      .slice()
      .sort((left, right) => left.index - right.index)
      .map(({ index, color }) => `palette = ${index}=${colorHex(color)}`),
    `background-opacity = ${(renderer.backgroundOpacity ?? 1).toFixed(2)}`,
    `background-opacity-cells = ${renderer.backgroundOpacityCells ?? false}`,
    `scrollback-limit = ${config.terminal.scrollbackBytes}`,
    "font-family =",
    ...renderer.fontFamilies.map((family) => `font-family = ${family.replaceAll(/[\r\n]/gu, "")}`),
    `font-size = ${renderer.fontSize}`,
    `window-padding-x = ${pair(renderer.paddingX)}`,
    `window-padding-y = ${pair(renderer.paddingY)}`,
    "custom-shader =",
    ...shaderEffects.map((effect) => `custom-shader = ${effect}`),
    `custom-shader-animation = ${renderer.customShaderAnimation ?? false}`,
    config.workspace.clearKeybindings ? "keybind = clear" : "keybind =",
    ...config.workspace.keybindings.map(
      ({ trigger, action }) => `keybind = ${trigger.replaceAll(/[\r\n]/gu, "")}=${action.replaceAll(/[\r\n]/gu, "")}`,
    ),
    "",
  ].join("\n");
}
