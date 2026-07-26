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

  it("routes copy, select-all, and clear-screen as terminal effects", () => {
    expect(ghosttyTerminalBinding(key("KeyC", { key: "c" }), "darwin")).toEqual({ type: "copy" });
    expect(ghosttyTerminalBinding(key("KeyA", { key: "a" }), "darwin")).toEqual({ type: "select_all" });
    expect(ghosttyTerminalBinding(key("KeyK", { key: "k" }), "darwin")).toEqual({ type: "clear_screen" });
  });

  it("routes scroll binds as terminal effects", () => {
    expect(ghosttyTerminalBinding(key("Home"), "darwin")).toEqual({ type: "scroll_to_top" });
    expect(ghosttyTerminalBinding(key("End"), "darwin")).toEqual({ type: "scroll_to_bottom" });
    expect(ghosttyTerminalBinding(key("PageUp"), "darwin")).toEqual({ type: "scroll_page_up" });
  });

  it("does not claim workspace or platform binds", () => {
    expect(ghosttyTerminalBinding(key("KeyT", { key: "t" }), "darwin")).toBeNull();
    expect(ghosttyTerminalBinding(key("Enter"), "darwin")).toBeNull();
    expect(ghosttyTerminalBinding(key("KeyW", { key: "w", shiftKey: true }), "darwin")).toBeNull();
  });

  it("routes plain shift+arrow as adjust_selection (not super+shift)", () => {
    expect(
      ghosttyTerminalBinding(
        {
          key: "ArrowLeft",
          code: "ArrowLeft",
          metaKey: false,
          shiftKey: true,
          altKey: false,
          ctrlKey: false,
        },
        "darwin",
      ),
    ).toEqual({ type: "adjust_selection", direction: "left" });
  });

  it("does not apply macOS defaults on other platforms or with extra modifiers", () => {
    expect(ghosttyTerminalBinding(key("ArrowLeft"), "linux")).toBeNull();
    // super+shift+arrow is not adjust_selection (that is plain shift)
    expect(ghosttyTerminalBinding(key("ArrowLeft", { shiftKey: true }), "darwin")).toBeNull();
    expect(ghosttyTerminalBinding(key("ArrowLeft", { ctrlKey: true }), "darwin")).toBeNull();
  });
});
