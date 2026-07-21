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
    let metadata = Self.metadata(retainedState)
    rows = retainedState.rows.enumerated().map { index, row in
      Self.row(
        index: index,
        retainedRow: row,
        retainedState: retainedState,
        selection: selection,
        offset: metadata.offset
      )
    }
    viewportOffset = metadata.offset
    totalRows = metadata.total
  }

  func updating(
    retainedState: RetainedTRF1State,
    selection: GhostteaTerminalSelection?,
    changedRows: some Sequence<UInt16>,
    forceFull: Bool = false
  ) -> Self {
    let metadata = Self.metadata(retainedState)
    guard !forceFull,
      viewportOffset == metadata.offset,
      totalRows == metadata.total,
      rows.count == retainedState.rows.count
    else {
      return Self(retainedState: retainedState, selection: selection)
    }

    var impacted = Set(changedRows)
    if let previousCursorRow = rows.first(where: { $0.cursorColumn != nil })?.viewportRow {
      impacted.insert(previousCursorRow)
    }
    if retainedState.cursor?.visible == true, let cursorRow = retainedState.cursor?.y {
      impacted.insert(cursorRow)
    }
    guard !impacted.isEmpty else { return self }
    guard impacted.count * 2 < retainedState.rows.count else {
      return Self(retainedState: retainedState, selection: selection)
    }

    var nextRows = rows
    for rowIndex in impacted {
      guard Int(rowIndex) < retainedState.rows.count else { continue }
      nextRows[Int(rowIndex)] = Self.row(
        index: Int(rowIndex),
        retainedRow: retainedState.rows[Int(rowIndex)],
        retainedState: retainedState,
        selection: selection,
        offset: metadata.offset
      )
    }
    return Self(rows: nextRows, viewportOffset: metadata.offset, totalRows: metadata.total)
  }

  private static func metadata(_ state: RetainedTRF1State) -> (offset: UInt64, total: UInt64) {
    let offset = state.scrollbar?.offset ?? 0
    return (
      offset,
      max(state.scrollbar?.total ?? 0, offset + UInt64(state.rows.count))
    )
  }

  private static func row(
    index: Int,
    retainedRow: RetainedTRF1Row,
    retainedState: RetainedTRF1State,
    selection: GhostteaTerminalSelection?,
    offset: UInt64
  ) -> GhostteaTerminalAccessibilityRow {
    let absoluteRow = offset + UInt64(index)
    let selectedRows: ClosedRange<UInt64>? = selection.map {
      let anchor = UInt64($0.anchor.row)
      let focus = UInt64($0.focus.row)
      return min(anchor, focus)...max(anchor, focus)
    }
    let cursorColumn =
      retainedState.cursor?.visible == true && Int(retainedState.cursor?.y ?? .max) == index
      ? retainedState.cursor?.x : nil
    return GhostteaTerminalAccessibilityRow(
      viewportRow: UInt16(clamping: index),
      absoluteRow: absoluteRow,
      text: retainedRow.accessibilityText,
      cursorColumn: cursorColumn,
      isSelected: selectedRows?.contains(absoluteRow) == true
    )
  }
}
