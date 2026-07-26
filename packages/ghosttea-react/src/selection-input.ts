import type { AdjustSelection } from "./bindings/ghostty-actions.js";
import type { CellPoint } from "./renderers/types.js";

/** Return true when a drag belongs to Ghosttea's local text selection. */
export function usesLocalSelection(mouseTracking: boolean, shiftKey: boolean): boolean {
  return !mouseTracking || shiftKey;
}

export type SelectionGeometry = {
  cols: number;
  rows: number;
  /** Total scrollback + viewport rows (scrollbar.total). */
  totalRows: number;
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Adjust the selection focus cell in the given Ghostty direction.
 * Returns null when the selection cannot be adjusted (empty geometry).
 */
export function adjustSelectionFocus(
  focus: CellPoint,
  direction: AdjustSelection,
  geometry: SelectionGeometry,
): CellPoint | null {
  const maxCol = Math.max(0, geometry.cols - 1);
  const maxRow = Math.max(0, geometry.totalRows - 1);
  if (geometry.cols <= 0 || geometry.totalRows <= 0) return null;

  let column = clamp(focus.column, 0, maxCol);
  let row = clamp(focus.row, 0, maxRow);

  switch (direction) {
    case "left":
      if (column > 0) column -= 1;
      else if (row > 0) {
        row -= 1;
        column = maxCol;
      }
      break;
    case "right":
      if (column < maxCol) column += 1;
      else if (row < maxRow) {
        row += 1;
        column = 0;
      }
      break;
    case "up":
      row = clamp(row - 1, 0, maxRow);
      break;
    case "down":
      row = clamp(row + 1, 0, maxRow);
      break;
    case "page_up":
      row = clamp(row - Math.max(1, geometry.rows), 0, maxRow);
      break;
    case "page_down":
      row = clamp(row + Math.max(1, geometry.rows), 0, maxRow);
      break;
    case "home":
      column = 0;
      row = 0;
      break;
    case "end":
      column = maxCol;
      row = maxRow;
      break;
    case "beginning_of_line":
      column = 0;
      break;
    case "end_of_line":
      column = maxCol;
      break;
    default:
      return null;
  }

  return { column, row };
}
