import { describe, expect, it } from "vitest";
import { ghosttyHotkey } from "@vibecook/ghosttea-react/workspace";

const key = (value: string, overrides: Partial<KeyboardEvent> = {}) =>
  ({
    key: value,
    metaKey: true,
    shiftKey: false,
    altKey: false,
    ctrlKey: false,
    ...overrides,
  }) as KeyboardEvent;

describe("Ghostty pane hotkeys", () => {
  it("opens the remote session palette", () => {
    expect(ghosttyHotkey(key("o", { shiftKey: true }))).toEqual({ type: "remote-sessions" });
  });

  it("maps command-D and command-shift-D to the expected split axes", () => {
    expect(ghosttyHotkey(key("d"))).toEqual({ type: "split", axis: "horizontal" });
    expect(ghosttyHotkey(key("D", { shiftKey: true }))).toEqual({ type: "split", axis: "vertical" });
  });

  it("maps focus, resize, zoom, equalize, and close bindings", () => {
    expect(ghosttyHotkey(key("ArrowLeft", { altKey: true }))).toEqual({ type: "focus-direction", direction: "left" });
    expect(ghosttyHotkey(key("ArrowUp", { ctrlKey: true }))).toEqual({
      type: "resize",
      axis: "vertical",
      delta: -0.05,
    });
    expect(ghosttyHotkey(key("Enter", { shiftKey: true }))).toEqual({ type: "toggle-zoom" });
    expect(ghosttyHotkey(key("=", { ctrlKey: true }))).toEqual({ type: "equalize" });
    expect(ghosttyHotkey(key("w"))).toEqual({ type: "close-pane" });
  });

  it("does not consume unrelated or non-command keys", () => {
    expect(ghosttyHotkey(key("x"))).toBeNull();
    expect(ghosttyHotkey(key("d", { metaKey: false }))).toBeNull();
  });
});
