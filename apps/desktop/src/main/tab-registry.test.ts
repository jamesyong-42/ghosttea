import { describe, expect, it } from "vitest";
import { DesktopTabRegistry } from "./tab-registry";

describe("DesktopTabRegistry", () => {
  it("isolates session ownership and tab order by native group", () => {
    const registry = new DesktopTabRegistry<object>();
    const first = {};
    const second = {};
    const otherWindow = {};
    registry.add(first, "first", "group-a");
    registry.add(second, "second", "group-a");
    registry.add(otherWindow, "other", "group-b");
    registry.updateSessions(second, ["session-2"]);

    expect(registry.group("group-a").map((record) => record.id)).toEqual(["first", "second"]);
    expect(registry.get(second)?.sessionIds).toEqual(new Set(["session-2"]));
    expect(registry.get(otherWindow)?.sessionIds).toEqual(new Set());
  });

  it("removes only the closed tab", () => {
    const registry = new DesktopTabRegistry<object>();
    const first = {};
    const second = {};
    registry.add(first, "first", "group");
    registry.add(second, "second", "group");

    expect(registry.delete(first)?.id).toBe("first");
    expect(registry.group("group").map((record) => record.id)).toEqual(["second"]);
  });

  it("ends a closed pane session only after its final mirrored attachment is gone", () => {
    const registry = new DesktopTabRegistry<object>();
    const first = {};
    const second = {};
    registry.add(first, "first", "group");
    registry.add(second, "second", "group");
    registry.updateSessions(first, ["shared", "first-only"]);
    registry.updateSessions(second, ["shared"]);

    expect(registry.closePaneSession(first, "shared", ["first-only"])).toBe(false);
    expect(registry.closePaneSession(second, "shared", [])).toBe(true);
    expect(registry.closePaneSession(first, "unknown", [])).toBe(false);
  });
});
