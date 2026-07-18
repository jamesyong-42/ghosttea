import Foundation
import GhostteaFrame

struct RetainedTRF1Row: Equatable, Sendable {
  var text = ""
  var accessibilityText = ""
  var revision: UInt64 = 0
  var glyphs: [TRF1GlyphInstance] = []
  var styles: [TRF1StyleRun] = []
}

enum RetainedTRF1ApplyResult: Equatable, Sendable {
  case applied(
    fullSnapshot: Bool, changedRows: [UInt16], completedResync: Bool, clipboardWrites: [String])
  case stale
  case needsFullRefresh
}

private enum RetainedTRF1Classification {
  case accept
  case stale
  case resync
}

struct RetainedTRF1State: Sendable {
  private(set) var sessionHandle: UInt64 = 0
  private(set) var sessionEpoch: UInt64 = 0
  private(set) var layoutEpoch: UInt64 = 0
  private(set) var sequence: UInt64 = 0
  private(set) var terminalRevision: UInt64 = 0
  private(set) var columns: UInt16 = 0
  private(set) var rows: [RetainedTRF1Row] = []
  private(set) var glyphDefinitions: [UInt32: TRF1GlyphDefinition] = [:]
  private(set) var styleDefinitions: [UInt32: TRF1StyleDefinition] = [:]
  private(set) var cursor: TRF1CursorState?
  private(set) var scrollbar: TRF1ScrollbarState?
  private(set) var mouseTracking = false
  private(set) var awaitingResync = false

  mutating func apply(_ data: Data) throws -> RetainedTRF1ApplyResult {
    do {
      return try applyDecoded(try decodeTRF1Frame(data))
    } catch {
      awaitingResync = true
      throw error
    }
  }

  private mutating func applyDecoded(_ frame: TRF1Frame) throws -> RetainedTRF1ApplyResult {
    if sessionHandle != 0 && frame.sessionHandle != sessionHandle {
      throw TRF1DecodingError("frame belongs to a different terminal session")
    }
    let fullFrame = frame.flags.contains(.fullSnapshot)
    switch classify(frame: frame, full: fullFrame) {
    case .stale:
      return .stale
    case .resync:
      awaitingResync = true
      return .needsFullRefresh
    case .accept:
      break
    }

    guard let rowSection = frame.sections.first(where: { $0.kind == .rowReplacements }) else {
      throw TRF1DecodingError("missing row replacement section")
    }
    guard let cursorSection = frame.sections.first(where: { $0.kind == .cursorState }) else {
      throw TRF1DecodingError("missing cursor section")
    }
    let fullRows = rowSection.flags & TRF1FrameFlags.fullSnapshot.rawValue != 0
    guard fullRows == fullFrame else {
      throw TRF1DecodingError("frame and row snapshot flags disagree")
    }

    let replacements = try decodeTRF1RowReplacements(rowSection)
    let accessibilityRows =
      try frame.sections.first(where: { $0.kind == .accessibilityText }).map(
        decodeTRF1AccessibilityRows) ?? []
    let nextCursor = try decodeTRF1CursorState(cursorSection)
    let glyphs =
      try frame.sections.first(where: { $0.kind == .glyphDefinitions }).map(
        decodeTRF1GlyphDefinitions) ?? []
    let styles =
      try frame.sections.first(where: { $0.kind == .styleDefinitions }).map(
        decodeTRF1StyleDefinitions) ?? []
    let nextScrollbar = try frame.sections.first(where: { $0.kind == .scrollbarState }).map(
      decodeTRF1ScrollbarState)
    let clipboardWrites = try frame.sections.filter { $0.kind == .clipboardWrite }.map(
      decodeTRF1ClipboardWrite)

    var next = self
    let changedSession = sessionEpoch != 0 && frame.sessionEpoch != sessionEpoch
    let completingResync = awaitingResync
    if changedSession || completingResync {
      next.rows = []
      next.glyphDefinitions = [:]
      next.styleDefinitions = [:]
    }
    for definition in glyphs {
      next.glyphDefinitions[definition.id] = definition
    }
    for definition in styles {
      next.styleDefinitions[definition.id] = definition
    }

    if fullRows {
      next.rows = Array(repeating: RetainedTRF1Row(), count: Int(frame.rows))
    } else if next.rows.count != Int(frame.rows) {
      throw TRF1DecodingError("incremental frame changed viewport row count")
    }

    var changedRows: [UInt16] = []
    changedRows.reserveCapacity(replacements.count)
    var accessibilityByRow: [UInt16: String] = [:]
    accessibilityByRow.reserveCapacity(accessibilityRows.count)
    for row in accessibilityRows {
      guard Int(row.row) < next.rows.count else {
        throw TRF1DecodingError("accessibility row exceeds viewport")
      }
      guard accessibilityByRow.updateValue(row.text, forKey: row.row) == nil else {
        throw TRF1DecodingError("duplicate accessibility row")
      }
    }
    for replacement in replacements {
      guard Int(replacement.row) < next.rows.count else {
        throw TRF1DecodingError("row replacement exceeds viewport")
      }
      if replacement.revision < next.rows[Int(replacement.row)].revision {
        continue
      }
      next.rows[Int(replacement.row)] = RetainedTRF1Row(
        text: replacement.text,
        accessibilityText: accessibilityByRow[replacement.row] ?? replacement.text,
        revision: replacement.revision,
        glyphs: replacement.glyphs,
        styles: replacement.styles
      )
      changedRows.append(replacement.row)
    }
    for (row, text) in accessibilityByRow where !changedRows.contains(row) {
      next.rows[Int(row)].accessibilityText = text
    }

    next.sessionHandle = frame.sessionHandle
    next.sessionEpoch = frame.sessionEpoch
    next.layoutEpoch = frame.layoutEpoch
    next.sequence = frame.frameSequence
    next.terminalRevision = frame.terminalRevision
    next.columns = frame.columns
    next.cursor = nextCursor
    next.mouseTracking = frame.flags.contains(.mouseTracking)
    if let nextScrollbar {
      next.scrollbar = nextScrollbar
    }
    next.awaitingResync = false
    self = next
    return .applied(
      fullSnapshot: fullFrame,
      changedRows: changedRows,
      completedResync: completingResync,
      clipboardWrites: clipboardWrites
    )
  }

  private func classify(frame: TRF1Frame, full: Bool) -> RetainedTRF1Classification {
    let sameSession = sessionEpoch == 0 || frame.sessionEpoch == sessionEpoch
    if sameSession
      && (frame.layoutEpoch < layoutEpoch
        || (frame.layoutEpoch == layoutEpoch && frame.frameSequence <= sequence))
    {
      return .stale
    }
    if awaitingResync && !full {
      return .resync
    }
    let changedSession = !sameSession
    let missingInitialSnapshot = sessionEpoch == 0 && !full
    let sequenceGap: Bool
    if sessionEpoch == frame.sessionEpoch && sequence != 0 {
      sequenceGap = sequence == UInt64.max || frame.frameSequence != sequence + 1
    } else {
      sequenceGap = false
    }
    return !full && (changedSession || missingInitialSnapshot || sequenceGap) ? .resync : .accept
  }
}
