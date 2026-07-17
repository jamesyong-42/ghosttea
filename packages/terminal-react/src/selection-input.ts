/** Return true when a drag belongs to Ghosttea's local text selection. */
export function usesLocalSelection(mouseTracking: boolean, shiftKey: boolean): boolean {
  return !mouseTracking || shiftKey;
}
