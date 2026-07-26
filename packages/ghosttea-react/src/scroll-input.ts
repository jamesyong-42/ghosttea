export function wheelDeltaPixels(deltaY: number, deltaMode: number, viewportRows: number, lineHeight: number): number {
  if (deltaMode === 1) return deltaY * lineHeight;
  if (deltaMode === 2) return deltaY * viewportRows * lineHeight;
  // Match Ghostty's macOS surface: precise device deltas get a 2x feel multiplier.
  return deltaY * 2;
}

export function accumulateWheelRows(
  remainder: number,
  deltaPixels: number,
  lineHeight: number,
): { rows: number; remainder: number } {
  const pixels = remainder + deltaPixels;
  const rows = Math.trunc(pixels / lineHeight);
  return { rows, remainder: pixels - rows * lineHeight };
}
