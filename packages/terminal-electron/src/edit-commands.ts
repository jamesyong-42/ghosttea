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
 * Resolve application edit shortcuts without stealing Ctrl+C from a PTY.
 * macOS uses the conventional Command shortcuts. Other platforms use the
 * terminal convention of Ctrl+Shift so plain Ctrl+C remains an interrupt.
 */
export function ghostteaEditCommand(input: GhostteaKeyInput, platform: NodeJS.Platform): GhostteaEditCommand | null {
  if (input.type !== "keyDown" || input.isAutoRepeat || input.alt) return null;

  const hasEditModifier =
    platform === "darwin" ? input.meta && !input.control && !input.shift : input.control && input.shift && !input.meta;
  if (!hasEditModifier) return null;

  switch (input.key.toLowerCase()) {
    case "c":
      return "copy";
    case "v":
      return "paste";
    case "a":
      return "select-all";
    default:
      return null;
  }
}

/**
 * Claim terminal edit accelerators before Electron's DOM edit roles and route
 * them to the host's renderer command channel. Returns an uninstall function.
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
