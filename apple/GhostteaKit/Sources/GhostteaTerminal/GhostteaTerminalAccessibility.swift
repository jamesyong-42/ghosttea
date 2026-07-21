import Foundation

public struct GhostteaTerminalAccessibilityRow: Equatable, Sendable {
  public let viewportRow: UInt16
  public let absoluteRow: UInt64
  public let text: String
  public let cursorColumn: UInt16?
  public let isSelected: Bool

  public init(
    viewportRow: UInt16,
    absoluteRow: UInt64,
    text: String,
    cursorColumn: UInt16? = nil,
    isSelected: Bool = false
  ) {
    self.viewportRow = viewportRow
    self.absoluteRow = absoluteRow
    self.text = text
    self.cursorColumn = cursorColumn
    self.isSelected = isSelected
  }
}

public struct GhostteaTerminalAccessibilitySnapshot: Equatable, Sendable {
  public let rows: [GhostteaTerminalAccessibilityRow]
  public let viewportOffset: UInt64
  public let totalRows: UInt64

  public init(
    rows: [GhostteaTerminalAccessibilityRow],
    viewportOffset: UInt64,
    totalRows: UInt64
  ) {
    self.rows = rows
    self.viewportOffset = viewportOffset
    self.totalRows = totalRows
  }

  public var visibleRangeDescription: String {
    guard let first = rows.first, let last = rows.last else { return "Terminal is empty" }
    return "Rows \(first.absoluteRow + 1) through \(last.absoluteRow + 1) of \(totalRows)"
  }
}

extension GhostteaTerminalAccessibilitySnapshot {
  init(retainedState: RetainedTRF1State, selection: GhostteaTerminalSelection?) {
    let offset = retainedState.scrollbar?.offset ?? 0
    let totalRows = max(
      retainedState.scrollbar?.total ?? 0, offset + UInt64(retainedState.rows.count))
    let selectedRows: ClosedRange<UInt64>? = selection.map {
      let anchor = UInt64($0.anchor.row)
      let focus = UInt64($0.focus.row)
      return min(anchor, focus)...max(anchor, focus)
    }
    rows = retainedState.rows.enumerated().map { index, row in
      let absoluteRow = offset + UInt64(index)
      let cursorColumn =
        retainedState.cursor?.visible == true && Int(retainedState.cursor?.y ?? .max) == index
        ? retainedState.cursor?.x : nil
      return GhostteaTerminalAccessibilityRow(
        viewportRow: UInt16(clamping: index),
        absoluteRow: absoluteRow,
        text: row.accessibilityText,
        cursorColumn: cursorColumn,
        isSelected: selectedRows?.contains(absoluteRow) == true
      )
    }
    viewportOffset = offset
    self.totalRows = totalRows
  }
}
