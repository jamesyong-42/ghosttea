import { EventEmitter } from "node:events";
import type { WebContents } from "electron";
import { describe, expect, it, vi } from "vitest";
import { ghostteaEditCommand, installGhostteaEditShortcuts, type GhostteaKeyInput } from "./edit-commands";

function key(overrides: Partial<GhostteaKeyInput> = {}): GhostteaKeyInput {
  return {
    type: "keyDown",
    key: "c",
    alt: false,
    control: false,
    meta: true,
    shift: false,
    isAutoRepeat: false,
    ...overrides,
  };
}

describe("Ghosttea Electron edit commands", () => {
  it("routes the macOS Command edit shortcuts", () => {
    expect(ghostteaEditCommand(key(), "darwin")).toBe("copy");
    expect(ghostteaEditCommand(key({ key: "a" }), "darwin")).toBe("select-all");
  });

  it("leaves paste on the renderer input path", () => {
    expect(ghostteaEditCommand(key({ key: "V" }), "darwin")).toBeNull();
    expect(ghostteaEditCommand(key({ key: "v", meta: false, control: true, shift: true }), "win32")).toBeNull();
  });

  it("does not steal Ctrl+C from a terminal", () => {
    expect(ghostteaEditCommand(key({ meta: false, control: true }), "darwin")).toBeNull();
    expect(ghostteaEditCommand(key({ meta: false, control: true }), "linux")).toBeNull();
  });

  it("uses Ctrl+Shift edit shortcuts outside macOS", () => {
    expect(ghostteaEditCommand(key({ meta: false, control: true, shift: true }), "linux")).toBe("copy");
  });

  it("ignores modified, repeated, and key-up events", () => {
    expect(ghostteaEditCommand(key({ alt: true }), "darwin")).toBeNull();
    expect(ghostteaEditCommand(key({ isAutoRepeat: true }), "darwin")).toBeNull();
    expect(ghostteaEditCommand(key({ type: "keyUp" }), "darwin")).toBeNull();
  });

  it("claims a matching Electron event and can uninstall the listener", () => {
    const webContents = new EventEmitter();
    const preventDefault = vi.fn();
    const onCommand = vi.fn();
    const uninstall = installGhostteaEditShortcuts(webContents as unknown as WebContents, onCommand, "darwin");

    webContents.emit("before-input-event", { preventDefault }, key());
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(onCommand).toHaveBeenCalledWith("copy");

    webContents.emit("before-input-event", { preventDefault }, key({ key: "v" }));
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(onCommand).toHaveBeenCalledOnce();

    uninstall();
    webContents.emit("before-input-event", { preventDefault }, key({ key: "a" }));
    expect(onCommand).toHaveBeenCalledOnce();
  });
});
