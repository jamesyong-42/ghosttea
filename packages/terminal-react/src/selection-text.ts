import { graphemeCellWidth, splitGraphemes } from "./cell-width.js";
import type { CellSelection } from "./renderers/types.js";

export function sliceCells(text: string, start: number, endInclusive: number): string {
  let column = 0;
  let selected = "";
  for (const segment of splitGraphemes(text)) {
    const width = graphemeCellWidth(segment);
    if (column <= endInclusive && column + width > start) selected += segment;
    column += width;
    if (column > endInclusive) break;
  }
  return selected;
}

export function selectionText(rows: readonly string[], selection: CellSelection): string {
  const forward =
    selection.anchor.row < selection.focus.row ||
    (selection.anchor.row === selection.focus.row && selection.anchor.column <= selection.focus.column);
  const start = forward ? selection.anchor : selection.focus;
  const end = forward ? selection.focus : selection.anchor;
  const output: string[] = [];
  for (let row = start.row; row <= end.row && row < rows.length; row += 1) {
    const first = row === start.row ? start.column : 0;
    const last = row === end.row ? end.column : Number.MAX_SAFE_INTEGER;
    output.push(sliceCells(rows[row] ?? "", first, last));
  }
  return output.join("\n");
}
