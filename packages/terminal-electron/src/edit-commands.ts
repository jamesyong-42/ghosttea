import type { Event, Input, WebContents } from "electron";

export type GhostteaEditCommand = "copy" | "paste" | "select-all";

/**
 * Ghostty actions that Chromium would otherwise steal as DOM edit roles.
 * Full binding table lives in `@vibecook/ghosttea-react` (`bindings/`); this
 * package only claims the subset that must run in the main process.
 *
 * Paste is deliberately omitted: the focused terminal textarea needs the
 * renderer keydown/paste path to inject clipboard text into the PTY.
 */
export type GhostteaMainClaimGhosttyAction = "copy_to_clipboard" | "select_all";

export interface GhostteaMainClaim {
  /** Canonical Ghostty action name (ground truth). */
  ghosttyAction: GhostteaMainClaimGhosttyAction;
  /** Renderer menu / surface command string. */
  command: Exclude<GhostteaEditCommand, "paste">;
  /** Key identity (letter), matched case-insensitively. */
  key: string;
}

/** Allowlist aligned with Ghostty default copy / select-all binds. */
export const GHOSTTEA_MAIN_EDIT_CLAIMS: readonly GhostteaMainClaim[] = [
  { ghosttyAction: "copy_to_clipboard", command: "copy", key: "c" },
  { ghosttyAction: "select_all", command: "select-all", key: "a" },
] as const;

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
 *
 * Modifiers match Ghostty defaults:
 * - macOS: super (+ no ctrl/shift/alt)
 * - Linux/Windows: ctrl+shift (+ no meta/alt)
 */
export function ghostteaEditCommand(input: GhostteaKeyInput, platform: NodeJS.Platform): GhostteaEditCommand | null {
  if (input.type !== "keyDown" || input.isAutoRepeat || input.alt) return null;

  const hasEditModifier =
    platform === "darwin" ? input.meta && !input.control && !input.shift : input.control && input.shift && !input.meta;
  if (!hasEditModifier) return null;

  const key = input.key.toLowerCase();
  for (const claim of GHOSTTEA_MAIN_EDIT_CLAIMS) {
    if (claim.key === key) return claim.command;
  }
  return null;
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
  canPerform: (command: GhostteaEditCommand) => boolean = () => true,
): () => void {
  const listener = (event: Event, input: Input): void => {
    const command = ghostteaEditCommand(input, platform);
    if (!command || !canPerform(command)) return;
    event.preventDefault();
    onCommand(command);
  };
  webContents.on("before-input-event", listener);
  return () => webContents.removeListener("before-input-event", listener);
}
