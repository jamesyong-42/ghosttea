import { describe, expect, it } from "vitest";
import { resolveKeyEvent } from "./action-route";
import {
  GHOSTTY_LINUX_DEFAULT_BINDINGS,
  GHOSTTY_MACOS_DEFAULT_BINDINGS,
  defaultBindingsForPlatform,
  keyboardDefaultBindings,
  matchGhostteaBindingEntry,
} from "./ghostty-bindings";
import { parseGhosttyTrigger, synthesizeKeyEvent } from "./ghostty-triggers";

describe("platform default binding tables", () => {
  it("selects macOS vs Linux tables by platform", () => {
    expect(defaultBindingsForPlatform("darwin")).toBe(GHOSTTY_MACOS_DEFAULT_BINDINGS);
    expect(defaultBindingsForPlatform("macos")).toBe(GHOSTTY_MACOS_DEFAULT_BINDINGS);
    expect(defaultBindingsForPlatform("linux")).toBe(GHOSTTY_LINUX_DEFAULT_BINDINGS);
    expect(defaultBindingsForPlatform("win32")).toBe(GHOSTTY_LINUX_DEFAULT_BINDINGS);
  });

  it("loads non-empty Linux defaults with performable flags", () => {
    expect(GHOSTTY_LINUX_DEFAULT_BINDINGS.length).toBeGreaterThan(50);
    expect(keyboardDefaultBindings(GHOSTTY_LINUX_DEFAULT_BINDINGS).length).toBeGreaterThan(40);
    const escape = GHOSTTY_LINUX_DEFAULT_BINDINGS.find((b) => b.triggerRaw === "escape");
    expect(escape?.flags.performable).toBe(true);
  });

  it("matches Linux ctrl+shift workspace binds, not macOS super", () => {
    const event = synthesizeKeyEvent(parseGhosttyTrigger("ctrl+shift+t"))!;
    expect(matchGhostteaBindingEntry(event, { platform: "linux" })?.actionRaw).toBe("new_tab");
    expect(matchGhostteaBindingEntry(event, { platform: "darwin" })).toBeNull();

    const mac = synthesizeKeyEvent(parseGhosttyTrigger("super+t"))!;
    expect(matchGhostteaBindingEntry(mac, { platform: "darwin" })?.actionRaw).toBe("new_tab");
    expect(matchGhostteaBindingEntry(mac, { platform: "linux" })).toBeNull();
  });

  it("routes Linux copy/paste and alt tab goto", () => {
    const copy = resolveKeyEvent(synthesizeKeyEvent(parseGhosttyTrigger("ctrl+shift+c"))!, {
      platform: "linux",
    });
    expect(copy?.kind).toBe("terminal");
    if (copy?.kind === "terminal") expect(copy.effect.type).toBe("copy");

    const tab = resolveKeyEvent(synthesizeKeyEvent(parseGhosttyTrigger("alt+3"))!, {
      platform: "linux",
    });
    expect(tab?.kind).toBe("workspace");
    if (tab?.kind === "workspace") expect(tab.command).toEqual({ type: "select-tab", target: 3 });
  });

  it("classifies every Linux keyboard default", () => {
    const failures: string[] = [];
    for (const entry of keyboardDefaultBindings(GHOSTTY_LINUX_DEFAULT_BINDINGS)) {
      const event = synthesizeKeyEvent(entry.trigger);
      if (!event) {
        failures.push(`${entry.triggerRaw}: no synth`);
        continue;
      }
      const match = matchGhostteaBindingEntry(event, { platform: "linux", extensions: false });
      if (!match) failures.push(`${entry.triggerRaw}: no match`);
    }
    expect(failures, failures.join("\n")).toEqual([]);
  });

  it("routes open/reload config and close_all as platform on macOS", () => {
    expect(resolveKeyEvent(synthesizeKeyEvent(parseGhosttyTrigger("super+,"))!, { platform: "darwin" })?.kind).toBe(
      "platform",
    );
    expect(
      resolveKeyEvent(synthesizeKeyEvent(parseGhosttyTrigger("super+shift+,"))!, { platform: "darwin" })?.kind,
    ).toBe("platform");
    expect(
      resolveKeyEvent(synthesizeKeyEvent(parseGhosttyTrigger("super+alt+shift+w"))!, { platform: "darwin" })?.kind,
    ).toBe("platform");
  });
});
