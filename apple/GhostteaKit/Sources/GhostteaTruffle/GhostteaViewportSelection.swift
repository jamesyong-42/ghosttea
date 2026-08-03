import Foundation

/// Extracts selected text from the rows a frozen replica is still showing
/// (§4.4).
///
/// Offline copy is deliberately *viewport* copy: these rows are what the
/// retained frame holds, so a selection can only ever cover what is on screen.
/// Scrollback lives on the host and needs the host, which is why the online
/// path is an RPC and this one is not a substitute for it — it is what remains
/// possible when the host is unreachable.
///
/// A free function over rows rather than a method on anything: the extraction
/// has no state of its own, and keeping it pure is what lets it be tested
/// against hand-built rows instead of a live attachment.
public enum GhostteaViewportSelection {
  /// `nil` when nothing has been retained yet — no frame has arrived, so there
  /// is nothing on screen to have selected. Distinct from `""`, which means a
  /// real selection that happens to cover blank cells.
  public static func extract(
    _ request: GhostteaSelectionRequest,
    from rows: [GhostteaLogicalRow],
    viewportOffset: UInt64 = 0
  ) -> String? {
    guard !rows.isEmpty else { return nil }
    if request.selectAll {
      return rows.map { trimmedTrailing($0.text) }.joined(separator: "\n")
    }

    let startPoint = (request.startRow, request.startColumn)
    let endPoint = (request.endRow, request.endColumn)
    let (start, end) = startPoint <= endPoint ? (startPoint, endPoint) : (endPoint, startPoint)
    guard UInt64(start.0) >= viewportOffset, UInt64(end.0) >= viewportOffset else {
      return nil
    }
    let first = UInt64(start.0) - viewportOffset
    let last = UInt64(end.0) - viewportOffset
    guard first < UInt64(rows.count) else { return nil }
    let firstIndex = Int(first)
    let lastIndex = Int(min(last, UInt64(rows.count - 1)))

    // A single row is clipped at both ends; a span keeps everything between
    // its first and last row whole, which is how a terminal selection reads.
    if firstIndex == lastIndex {
      return trimmedTrailing(rowColumns(rows[firstIndex], from: start.1, through: end.1))
    }
    var lines: [String] = [
      trimmedTrailing(rowColumns(rows[firstIndex], from: start.1, through: UInt16.max))
    ]
    if firstIndex + 1 < lastIndex {
      lines.append(
        contentsOf: rows[(firstIndex + 1)..<lastIndex].map { trimmedTrailing($0.text) }
      )
    }
    lines.append(trimmedTrailing(rowColumns(rows[lastIndex], from: 0, through: end.1)))
    return lines.joined(separator: "\n")
  }

  /// Column-accurate slice of one logical row. Cell spans are authoritative
  /// for wide graphemes; legacy rows without cells fall back to character
  /// offsets. The end column is inclusive, matching the host selection RPC.
  private static func rowColumns(
    _ row: GhostteaLogicalRow,
    from startColumn: UInt16,
    through endColumn: UInt16
  ) -> String {
    guard startColumn <= endColumn else { return "" }
    if row.cells.isEmpty {
      let characters = Array(row.text)
      guard Int(startColumn) < characters.count else { return "" }
      let count = Int(endColumn - startColumn) + 1
      return String(characters.dropFirst(Int(startColumn)).prefix(count))
    }
    return row.cells
      .filter { cell in
        let last = cell.column.addingReportingOverflow(max(1, cell.span) - 1)
        let lastColumn = last.overflow ? UInt16.max : last.partialValue
        return cell.column <= endColumn && lastColumn >= startColumn
      }
      .map(\.text)
      .joined()
  }

  /// Terminal rows are padded to their width; copying that padding would paste
  /// invisible trailing spaces nobody selected.
  private static func trimmedTrailing(_ text: String) -> String {
    var characters = Array(text)
    while let last = characters.last, last == " " || last == "\u{0}" {
      characters.removeLast()
    }
    return String(characters)
  }
}
