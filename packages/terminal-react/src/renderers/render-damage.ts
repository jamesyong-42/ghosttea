import type { RenderDamage } from "./types.js";

export interface RenderRows {
  full: boolean;
  rows: number[];
}

export function rowsForDamage(rowCount: number, damage: RenderDamage | undefined, sceneValid: boolean): RenderRows {
  const full = !sceneValid || !damage || damage.full;
  if (full) return { full: true, rows: Array.from({ length: rowCount }, (_, row) => row) };

  const rows = new Set<number>();
  for (const damagedRow of damage.rows) {
    // Native glyph bearings can cross a row boundary. Repaint one neighbor
    // on each side so clearing stale overhang never clips combining marks.
    for (let row = damagedRow - 1; row <= damagedRow + 1; row += 1) {
      if (row >= 0 && row < rowCount) rows.add(row);
    }
  }
  return { full: false, rows: [...rows].sort((left, right) => left - right) };
}
