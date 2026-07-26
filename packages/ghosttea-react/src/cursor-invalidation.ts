import type { CursorState } from "@vibecook/ghosttea-frame";

export function cursorActivityChangesPixels(
  cursor: CursorState,
  focused: boolean,
  cursorBlinkVisible: boolean,
): boolean {
  return focused && cursor.visible && cursor.blinking && !cursorBlinkVisible;
}
