import { EventEmitter } from "node:events";
import type { Clipboard, IpcMain, IpcRenderer, WebContents } from "electron";
import { describe, expect, it, vi } from "vitest";
import { createGhostteaClipboardBridge, installGhostteaClipboardHost } from "./clipboard";

class FakeIpcMain extends EventEmitter {
  readonly handlers = new Map<string, () => unknown>();

  handle(channel: string, handler: () => unknown): void {
    this.handlers.set(channel, handler);
  }

  removeHandler(channel: string): void {
    this.handlers.delete(channel);
  }
}

describe("Ghosttea Electron clipboard bridge", () => {
  it("keeps native clipboard access in the main process", async () => {
    const ipcMain = new FakeIpcMain();
    const clipboard = {
      readText: vi.fn(() => "from-main"),
      writeText: vi.fn(),
    };
    const host = installGhostteaClipboardHost(ipcMain as unknown as IpcMain, clipboard as unknown as Clipboard);
    const sender = Object.assign(new EventEmitter(), { id: 17 }) as unknown as WebContents;
    const ipcRenderer = {
      invoke: vi.fn(async (channel: string) => ipcMain.handlers.get(channel)?.()),
      send: vi.fn((channel: string, value: unknown) => {
        ipcMain.emit(channel, { sender }, value);
      }),
    };
    const bridge = createGhostteaClipboardBridge(ipcRenderer as unknown as IpcRenderer);

    await expect(bridge.readText()).resolves.toBe("from-main");
    bridge.writeText("to-main");
    expect(clipboard.writeText).toHaveBeenCalledWith("to-main");

    expect(host.canCopy(sender)).toBe(false);
    bridge.setCanCopy(true);
    expect(host.canCopy({ id: sender.id } as WebContents)).toBe(true);
    bridge.setCanCopy(false);
    expect(host.canCopy(sender)).toBe(false);

    host.dispose();
    expect(ipcMain.handlers).toHaveLength(0);
    expect(ipcMain.eventNames()).toHaveLength(0);
    expect(sender.listenerCount("destroyed")).toBe(0);
  });

  it("rejects invalid clipboard values at the process boundary", async () => {
    const invoke = vi.fn(async () => 42);
    const send = vi.fn();
    const bridge = createGhostteaClipboardBridge({ invoke, send } as unknown as IpcRenderer);

    await expect(bridge.readText()).rejects.toThrow("invalid clipboard text");
    expect(() => bridge.writeText(42 as unknown as string)).toThrow("must be a string");
    expect(send).not.toHaveBeenCalled();
  });
});
