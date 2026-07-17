import { describe, expect, it } from "vitest";
import { ghosttyTerminalBinding } from "./terminal-bindings";

const key = (code: string, overrides: Partial<KeyboardEvent> = {}) =>
  ({
    key: code,
    code,
    metaKey: true,
    shiftKey: false,
    altKey: false,
    ctrlKey: false,
    ...overrides,
  }) as KeyboardEvent;

describe("ghosttyTerminalBinding", () => {
  it("matches Ghostty's macOS natural line editing bindings", () => {
    expect(ghosttyTerminalBinding(key("ArrowLeft"), "darwin")).toEqual({ type: "text", text: "\u0001" });
    expect(ghosttyTerminalBinding(key("ArrowRight"), "darwin")).toEqual({ type: "text", text: "\u0005" });
    expect(ghosttyTerminalBinding(key("Backspace"), "darwin")).toEqual({ type: "text", text: "\u0015" });
  });

  it("matches Ghostty's macOS option word movement bindings", () => {
    expect(ghosttyTerminalBinding(key("ArrowLeft", { metaKey: false, altKey: true }), "darwin")).toEqual({
      type: "text",
      text: "\u001bb",
    });
    expect(ghosttyTerminalBinding(key("ArrowRight", { metaKey: false, altKey: true }), "darwin")).toEqual({
      type: "text",
      text: "\u001bf",
    });
  });

  it("routes command-V through terminal-safe paste", () => {
    expect(ghosttyTerminalBinding(key("KeyV", { key: "v" }), "darwin")).toEqual({ type: "paste" });
  });

  it("does not apply macOS defaults on other platforms or with extra modifiers", () => {
    expect(ghosttyTerminalBinding(key("ArrowLeft"), "linux")).toBeNull();
    expect(ghosttyTerminalBinding(key("ArrowLeft", { shiftKey: true }), "darwin")).toBeNull();
    expect(ghosttyTerminalBinding(key("ArrowLeft", { ctrlKey: true }), "darwin")).toBeNull();
  });
});
