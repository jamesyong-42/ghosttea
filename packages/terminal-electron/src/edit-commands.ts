import type { Event, Input, WebContents } from "electron";

export type GhostteaEditCommand = "copy" | "paste" | "select-all";

export interface GhostteaKeyInput {
  type: string;
  key: string;
  alt: boolean;
  control: boolean;
  meta: boolean;
  shift: boolean;
  isAutoRepeat: boolean;
}

/**
 * Resolve edit shortcuts that must bypass Chromium's DOM editing path.
 * Paste is deliberately not claimed: the focused terminal textarea needs the
 * renderer keydown/paste event so it can send clipboard text to the PTY.
 */
export function ghostteaEditCommand(input: GhostteaKeyInput, platform: NodeJS.Platform): GhostteaEditCommand | null {
  if (input.type !== "keyDown" || input.isAutoRepeat || input.alt) return null;

  const hasEditModifier =
    platform === "darwin" ? input.meta && !input.control && !input.shift : input.control && input.shift && !input.meta;
  if (!hasEditModifier) return null;

  switch (input.key.toLowerCase()) {
    case "c":
      return "copy";
    case "a":
      return "select-all";
    default:
      return null;
  }
}

/**
 * Claim terminal copy/select-all accelerators before Electron's DOM edit roles
 * and route them to the host's renderer command channel. Paste remains on the
 * normal renderer input path. Returns an uninstall function.
 */
export function installGhostteaEditShortcuts(
  webContents: WebContents,
  onCommand: (command: GhostteaEditCommand) => void,
  platform: NodeJS.Platform = process.platform,
): () => void {
  const listener = (event: Event, input: Input): void => {
    const command = ghostteaEditCommand(input, platform);
    if (!command) return;
    event.preventDefault();
    onCommand(command);
  };
  webContents.on("before-input-event", listener);
  return () => webContents.removeListener("before-input-event", listener);
}
