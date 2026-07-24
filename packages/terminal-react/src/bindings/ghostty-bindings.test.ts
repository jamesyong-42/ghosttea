import { describe, expect, it } from "vitest";
import { formatGhosttyAction, parseGhosttyAction } from "./ghostty-actions";
import {
  GHOSTTEA_BINDING_EXTENSIONS,
  GHOSTTY_MACOS_DEFAULT_BINDINGS,
  keyboardDefaultBindings,
  matchGhostteaBinding,
  matchGhosttyBinding,
  synthesizeEventForBinding,
} from "./ghostty-bindings";
import { formatGhosttyTrigger, parseGhosttyTrigger, synthesizeKeyEvent } from "./ghostty-triggers";
import defaultKeybindsJson from "./fixtures/keybinds-macos-default.json";

describe("ghostty action parse/format", () => {
  it("round-trips every default macOS binding action string", () => {
    for (const row of defaultKeybindsJson.bindings) {
      const action = parseGhosttyAction(row.action);
      // Format may normalize defaults (e.g. close_tab:this); parse(format) must hold.
      expect(parseGhosttyAction(formatGhosttyAction(action)), row.action).toEqual(action);
    }
  });

  it("decodes natural text editing payloads", () => {
    expect(parseGhosttyAction("text:\\x05")).toEqual({ type: "text", value: "\u0005" });
    expect(parseGhosttyAction("esc:b")).toEqual({ type: "esc", value: "b" });
  });
});

describe("ghostty trigger parse/format", () => {
  it("round-trips every default macOS trigger string", () => {
    for (const row of defaultKeybindsJson.bindings) {
      const trigger = parseGhosttyTrigger(row.trigger);
      expect(formatGhosttyTrigger(trigger), row.trigger).toBe(row.trigger);
    }
  });
});

describe("ghostty default binding golden suite (macOS)", () => {
  it("loads the expected binding count from ground truth", () => {
    expect(GHOSTTY_MACOS_DEFAULT_BINDINGS).toHaveLength(defaultKeybindsJson.count);
    expect(defaultKeybindsJson.count).toBe(93);
  });

  it("matches every keyboard default binding via a synthetic key event", () => {
    const keyboard = keyboardDefaultBindings();
    expect(keyboard.length).toBeGreaterThan(80);

    const failures: string[] = [];
    for (const entry of keyboard) {
      const event = synthesizeEventForBinding(entry);
      if (!event) {
        failures.push(`${entry.triggerRaw}: could not synthesize event`);
        continue;
      }
      const matched = matchGhosttyBinding(event);
      if (!matched) {
        failures.push(`${entry.triggerRaw}: no match for ${entry.actionRaw}`);
        continue;
      }
      if (matched.type !== entry.action.type || JSON.stringify(matched) !== JSON.stringify(entry.action)) {
        failures.push(`${entry.triggerRaw}: expected ${entry.actionRaw}, got ${JSON.stringify(matched)}`);
      }
    }
    expect(failures, failures.join("\n")).toEqual([]);
  });

  it("keeps special copy/paste menu triggers out of keyboard matching", () => {
    const specials = GHOSTTY_MACOS_DEFAULT_BINDINGS.filter((b) => b.trigger.key.kind === "special");
    expect(specials.map((s) => s.triggerRaw).sort()).toEqual(["copy", "paste"]);
    expect(
      matchGhosttyBinding({
        key: "c",
        code: "KeyC",
        metaKey: false,
        ctrlKey: false,
        altKey: false,
        shiftKey: false,
      }),
    ).toBeNull();
  });

  it("maps super+9 to last_tab (Ghostty), not goto_tab:9", () => {
    const event = synthesizeKeyEvent(parseGhosttyTrigger("super+9"));
    expect(event).not.toBeNull();
    expect(matchGhosttyBinding(event!)).toEqual({ type: "last_tab" });
  });

  it("maps natural text editing bindings to the correct terminal payloads", () => {
    expect(matchGhosttyBinding(synthesizeKeyEvent(parseGhosttyTrigger("super+arrow_left"))!)).toEqual({
      type: "text",
      value: "\u0001",
    });
    expect(matchGhosttyBinding(synthesizeKeyEvent(parseGhosttyTrigger("super+arrow_right"))!)).toEqual({
      type: "text",
      value: "\u0005",
    });
    expect(matchGhosttyBinding(synthesizeKeyEvent(parseGhosttyTrigger("super+backspace"))!)).toEqual({
      type: "text",
      value: "\u0015",
    });
    expect(matchGhosttyBinding(synthesizeKeyEvent(parseGhosttyTrigger("alt+arrow_left"))!)).toEqual({
      type: "esc",
      value: "b",
    });
    expect(matchGhosttyBinding(synthesizeKeyEvent(parseGhosttyTrigger("alt+arrow_right"))!)).toEqual({
      type: "esc",
      value: "f",
    });
  });
});

describe("ghosttea binding extensions", () => {
  it("documents ⌘⇧O remote sessions as an intentional Ghosttea extension", () => {
    expect(GHOSTTEA_BINDING_EXTENSIONS).toHaveLength(1);
    const remote = GHOSTTEA_BINDING_EXTENSIONS[0]!;
    expect(remote.triggerRaw).toBe("super+shift+o");
    expect(remote.action).toEqual({ type: "ghosttea.remote_sessions" });
    expect(remote.note?.toLowerCase()).toContain("intentional");
  });

  it("matches ⌘⇧O to remote sessions even though Ghostty has no such default", () => {
    const event = synthesizeKeyEvent(parseGhosttyTrigger("super+shift+o"))!;
    expect(matchGhosttyBinding(event)).toBeNull();
    expect(matchGhostteaBinding(event)).toEqual({ type: "ghosttea.remote_sessions" });
    expect(matchGhostteaBinding(event, { extensions: false })).toBeNull();
  });
});
