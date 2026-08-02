import { describe, expect, it } from "vitest";
import {
  APPEARANCE_BLOCK_END,
  APPEARANCE_BLOCK_START,
  appearanceBlock,
  patchAppearanceBlock,
  validateAppearanceUpdate,
  type ManagedAppearanceUpdate,
} from "./appearance-config";

const update: ManagedAppearanceUpdate = {
  theme: {
    name: "Test Theme",
    background: "#101112",
    foreground: "#f0f1f2",
    cursor: "#abcdef",
    cursorText: "#010203",
    selection: "#202122",
    selectionForeground: "#e0e1e2",
    palette: Array.from({ length: 16 }, (_, index) => `#${index.toString(16).repeat(6)}`),
  },
  backgroundOpacity: 0.73,
  backgroundOpacityCells: true,
  shaderEffects: ["ghosttea:crt", "ghosttea:vhs"],
  shaderAnimation: true,
};

describe("managed appearance config", () => {
  it("validates colors and keeps a unique ordered shader stack", () => {
    const validated = validateAppearanceUpdate({
      ...update,
      theme: { ...update.theme, background: "#AABBCC" },
      shaderEffects: ["ghosttea:vhs", "ghosttea:crt", "ghosttea:vhs"],
    });
    expect(validated.theme.background).toBe("#aabbcc");
    expect(validated.shaderEffects).toEqual(["ghosttea:vhs", "ghosttea:crt"]);
    expect(() => validateAppearanceUpdate({ ...update, shaderEffects: ["/tmp/untrusted.glsl"] })).toThrow(
      "unknown effect",
    );
    expect(() =>
      validateAppearanceUpdate({ ...update, theme: { ...update.theme, name: "bad\nforeground = red" } }),
    ).toThrow("Theme name is invalid");
  });

  it("appends a complete CRLF block without rewriting user settings", () => {
    const original = "# user comment\r\nfont-size = 14\r\n";
    const result = patchAppearanceBlock(original, appearanceBlock(update));
    expect(result.startsWith(original)).toBe(true);
    expect(result).toContain(`${APPEARANCE_BLOCK_START}\r\n# Theme: Test Theme`);
    expect(result).toContain("palette = 15=#ffffff\r\n");
    expect(result).toContain("custom-shader = ghosttea:crt\r\ncustom-shader = ghosttea:vhs\r\n");
    expect(result).not.toMatch(/(^|[^\r])\n/u);
  });

  it("replaces only the existing managed block", () => {
    const first = patchAppearanceBlock("font-size = 14\n", appearanceBlock(update));
    const second = patchAppearanceBlock(
      `${first}# untouched tail\n`,
      appearanceBlock({ ...update, backgroundOpacity: 0.5, shaderEffects: [] }),
    );
    expect(second.match(new RegExp(APPEARANCE_BLOCK_START.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "gu"))).toHaveLength(
      1,
    );
    expect(second).toContain("font-size = 14\n");
    expect(second).toContain("background-opacity = 0.50\n");
    expect(second).toContain(`${APPEARANCE_BLOCK_END}\n# untouched tail\n`);
  });

  it("refuses ambiguous or incomplete managed markers", () => {
    expect(() => patchAppearanceBlock(`${APPEARANCE_BLOCK_START}\n`, appearanceBlock(update))).toThrow("malformed");
    expect(() =>
      patchAppearanceBlock(
        `${APPEARANCE_BLOCK_START}\n${APPEARANCE_BLOCK_END}\n${APPEARANCE_BLOCK_START}\n${APPEARANCE_BLOCK_END}\n`,
        appearanceBlock(update),
      ),
    ).toThrow("malformed");
  });
});
