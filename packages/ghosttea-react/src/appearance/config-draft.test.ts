import { describe, expect, it } from "vitest";
import type { ConfigSnapshot } from "@vibecook/ghosttea-protocol";
import {
  FRIENDLY_BLOCK_END,
  FRIENDLY_BLOCK_START,
  friendlyConfigMismatches,
  friendlyConfigSections,
  friendlyValuesFromConfig,
  hasFriendlyConfigBlock,
  patchFriendlyConfigBlock,
  removeFriendlyConfigBlock,
} from "./config-draft.js";

const config = {
  terminal: { scrollbackBytes: 12_345 },
  renderer: {
    foreground: [240, 241, 242],
    background: [16, 17, 18],
    cursor: [171, 205, 239],
    cursorText: [1, 2, 3],
    selectionBackground: [32, 33, 34],
    selectionForeground: [224, 225, 226],
    backgroundOpacity: 0.73,
    backgroundOpacityCells: true,
    fontSize: 14,
    fontFamilies: ["JetBrains Mono", "monospace"],
    paddingX: [3, 4],
    paddingY: [5, 6],
  },
  workspace: {
    clearKeybindings: true,
    keybindings: [{ trigger: "super+t", action: "new_tab" }],
  },
} as ConfigSnapshot;

describe("friendly config draft", () => {
  it("projects effective values into a final managed block without rewriting raw text", () => {
    const values = friendlyValuesFromConfig(config);
    const result = patchFriendlyConfigBlock("# mine\r\nfont-feature = calt\r\n", values);

    expect(result.startsWith("# mine\r\nfont-feature = calt\r\n")).toBe(true);
    expect(result).toContain(`${FRIENDLY_BLOCK_START}\r\n`);
    expect(result).toContain("foreground = #f0f1f2\r\n");
    expect(result).toContain("font-family = JetBrains Mono\r\nfont-family = monospace\r\n");
    expect(result).toContain("window-padding-x = 3,4\r\n");
    expect(result).toContain("keybind = clear\r\nkeybind = super+t=new_tab\r\n");
    expect(result).not.toMatch(/(^|[^\r])\n/u);
  });

  it("replaces and removes only one managed block", () => {
    const values = friendlyValuesFromConfig(config);
    const first = patchFriendlyConfigBlock("font-size = 9\n", values);
    const second = patchFriendlyConfigBlock(`${first}# tail\n`, { ...values, fontSize: 17 });

    expect(second.match(new RegExp(FRIENDLY_BLOCK_START.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "gu"))).toHaveLength(
      1,
    );
    expect(second).toContain("# tail\n\n# >>>");
    expect(second).toContain("font-size = 17\n");
    expect(removeFriendlyConfigBlock(second)).toContain("# tail");
    expect(hasFriendlyConfigBlock(removeFriendlyConfigBlock(second))).toBe(false);
  });

  it("refuses incomplete and duplicate marker pairs", () => {
    const values = friendlyValuesFromConfig(config);
    expect(() => patchFriendlyConfigBlock(`${FRIENDLY_BLOCK_START}\n`, values)).toThrow("malformed");
    expect(() =>
      patchFriendlyConfigBlock(
        `${FRIENDLY_BLOCK_START}\n${FRIENDLY_BLOCK_END}\n${FRIENDLY_BLOCK_START}\n${FRIENDLY_BLOCK_END}\n`,
        values,
      ),
    ).toThrow("malformed");
  });

  it("reports friendly values shadowed in the effective projection", () => {
    const values = friendlyValuesFromConfig(config);
    expect(friendlyConfigMismatches(config, values)).toEqual([]);
    expect(
      friendlyConfigMismatches(
        { ...config, renderer: { ...config.renderer, background: [9, 9, 9], fontSize: 12 } },
        values,
      ),
    ).toEqual(["background", "font size"]);
  });

  it("writes and discovers only the groups the user changed", () => {
    const values = friendlyValuesFromConfig(config);
    const result = patchFriendlyConfigBlock("# mine\n", values, new Set(["colors", "opacity"]));

    expect(result).toContain("foreground = #f0f1f2\n");
    expect(result).toContain("background-opacity = 0.73\n");
    expect(result).not.toContain("font-size =");
    expect(result).not.toContain("scrollback-limit =");
    expect(result).not.toContain("keybind =");
    expect([...friendlyConfigSections(result)]).toEqual(["colors", "opacity"]);
    expect(friendlyConfigMismatches(config, values, new Set(["colors"]))).toEqual([]);
    expect(
      friendlyConfigMismatches(
        config,
        { ...values, fontFamilies: ['"JetBrains Mono"', "monospace"], keybindings: ["super+t = new_tab"] },
        new Set(["typography", "keybindings"]),
      ),
    ).toEqual([]);
  });

  it("does not throw while a raw editor is typing an incomplete marker", () => {
    expect(hasFriendlyConfigBlock(`${FRIENDLY_BLOCK_START}\n`)).toBe(true);
    expect(friendlyConfigSections(`${FRIENDLY_BLOCK_START}\n`)).toEqual(new Set());
  });
});
