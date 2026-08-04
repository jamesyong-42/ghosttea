import { describe, expect, it } from "vitest";
import {
  GHOSTTEA_SHADER_OPTIONS,
  GHOSTTY_COLOR_THEMES,
  GHOSTTY_THEME_CATALOG_REVISION,
  GHOSTTY_THEME_CATALOG_SOURCE,
  TERMINAL_THEMES,
  UNAVAILABLE_UPSTREAM_SHADERS,
  type GhostteaAppearanceUpdate,
  type GhostteaColorTheme,
  type GhostteaShaderOption,
} from "./index.js";

describe("workspace host appearance contract", () => {
  it("exports the catalog provenance and UI-independent data surfaces", () => {
    const themes: readonly GhostteaColorTheme[] = GHOSTTY_COLOR_THEMES;
    const shaders: readonly GhostteaShaderOption[] = GHOSTTEA_SHADER_OPTIONS;
    const unavailable: readonly string[] = UNAVAILABLE_UPSTREAM_SHADERS;

    expect(GHOSTTY_THEME_CATALOG_SOURCE).not.toBe("");
    expect(GHOSTTY_THEME_CATALOG_REVISION).not.toBe("");
    expect(themes.length).toBeGreaterThan(0);
    expect(shaders.length).toBeGreaterThan(0);
    expect(unavailable.length).toBeGreaterThan(0);
    expect(TERMINAL_THEMES.midnight.background).toHaveLength(4);
    expect(shaders[0]).toEqual(
      expect.objectContaining({
        id: expect.any(String),
        name: expect.any(String),
        description: expect.any(String),
        license: expect.any(String),
        animated: expect.any(Boolean),
      }),
    );
  });

  it("keeps the host-authored appearance update shape available", () => {
    const update: GhostteaAppearanceUpdate = {
      backgroundOpacity: 0.75,
      backgroundOpacityCells: false,
      shaderEffects: ["ghosttea:vhs"],
      shaderAnimation: true,
    };

    expect(update.shaderEffects).toEqual(["ghosttea:vhs"]);
  });
});
