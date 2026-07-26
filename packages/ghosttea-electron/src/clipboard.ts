import type { Clipboard, IpcMain, IpcMainEvent, IpcRenderer, WebContents } from "electron";

const READ_CLIPBOARD_CHANNEL = "ghosttea:clipboard:read";
const WRITE_CLIPBOARD_CHANNEL = "ghosttea:clipboard:write";
const COPY_AVAILABILITY_CHANNEL = "ghosttea:clipboard:can-copy";

export interface GhostteaClipboardHost {
  canCopy(webContents: WebContents): boolean;
  dispose(): void;
}

/**
 * Own clipboard access in Electron's main process. Sandboxed preload scripts
 * cannot use Electron's clipboard module directly.
 */
export function installGhostteaClipboardHost(ipcMain: IpcMain, clipboard: Clipboard): GhostteaClipboardHost {
  const copyAvailability = new Map<number, boolean>();
  const trackedWebContents = new Map<number, { sender: WebContents; onDestroyed: () => void }>();

  const readClipboard = (): string => clipboard.readText();
  const writeClipboard = (event: IpcMainEvent, text: unknown): void => {
    if (typeof text !== "string") return;
    clipboard.writeText(text);
  };
  const setCopyAvailability = (event: IpcMainEvent, value: unknown): void => {
    const { sender } = event;
    copyAvailability.set(sender.id, value === true);
    if (!trackedWebContents.has(sender.id)) {
      const onDestroyed = (): void => {
        copyAvailability.delete(sender.id);
        trackedWebContents.delete(sender.id);
      };
      trackedWebContents.set(sender.id, { sender, onDestroyed });
      sender.once("destroyed", onDestroyed);
    }
  };

  ipcMain.handle(READ_CLIPBOARD_CHANNEL, readClipboard);
  ipcMain.on(WRITE_CLIPBOARD_CHANNEL, writeClipboard);
  ipcMain.on(COPY_AVAILABILITY_CHANNEL, setCopyAvailability);

  return {
    canCopy: (webContents) => copyAvailability.get(webContents.id) === true,
    dispose: () => {
      ipcMain.removeHandler(READ_CLIPBOARD_CHANNEL);
      ipcMain.removeListener(WRITE_CLIPBOARD_CHANNEL, writeClipboard);
      ipcMain.removeListener(COPY_AVAILABILITY_CHANNEL, setCopyAvailability);
      copyAvailability.clear();
      for (const { sender, onDestroyed } of trackedWebContents.values()) {
        sender.removeListener("destroyed", onDestroyed);
      }
      trackedWebContents.clear();
    },
  };
}

export interface GhostteaClipboardBridge {
  writeText(text: string): void;
  readText(): Promise<string>;
  setCanCopy(canCopy: boolean): void;
}

/** Build the narrow, context-isolated clipboard API exposed by a preload. */
export function createGhostteaClipboardBridge(ipcRenderer: IpcRenderer): GhostteaClipboardBridge {
  return {
    writeText: (text) => {
      if (typeof text !== "string") throw new TypeError("Clipboard text must be a string");
      ipcRenderer.send(WRITE_CLIPBOARD_CHANNEL, text);
    },
    readText: async () => {
      const text: unknown = await ipcRenderer.invoke(READ_CLIPBOARD_CHANNEL);
      if (typeof text !== "string") throw new TypeError("Main process returned invalid clipboard text");
      return text;
    },
    setCanCopy: (canCopy) => {
      ipcRenderer.send(COPY_AVAILABILITY_CHANNEL, canCopy === true);
    },
  };
}
