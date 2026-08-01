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
    from rows: [GhostteaLogicalRow]
  ) -> String? {
    guard !rows.isEmpty else { return nil }
    if request.selectAll {
      return rows.map { trimmedTrailing($0.text) }.joined(separator: "\n")
    }

    let lastIndex = rows.count - 1
    let start = min(Int(request.startRow), lastIndex)
    let end = min(Int(request.endRow), lastIndex)
    guard start <= end else { return nil }

    // A single row is clipped at both ends; a span keeps everything between
    // its first and last row whole, which is how a terminal selection reads.
    if start == end {
      return clip(rows[start].text, from: Int(request.startColumn), to: Int(request.endColumn))
    }
    var lines: [String] = [
      clip(rows[start].text, from: Int(request.startColumn), to: nil)
    ]
    if start + 1 <= end - 1 {
      lines.append(contentsOf: rows[(start + 1)...(end - 1)].map { trimmedTrailing($0.text) })
    }
    lines.append(clip(rows[end].text, from: 0, to: Int(request.endColumn)))
    return lines.joined(separator: "\n")
  }

  /// Columns index characters, matching how the rows were rendered. An end
  /// column past the row's width clips to the row rather than failing: the
  /// selection is describing the screen, and the screen is shorter there.
  private static func clip(_ text: String, from startColumn: Int, to endColumn: Int?) -> String {
    let characters = Array(text)
    guard startColumn < characters.count else { return "" }
    let upper = min(endColumn ?? characters.count, characters.count)
    guard startColumn < upper else { return "" }
    return trimmedTrailing(String(characters[startColumn..<upper]))
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
