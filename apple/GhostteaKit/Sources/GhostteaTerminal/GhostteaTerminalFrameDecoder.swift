import Foundation
import GhostteaFrame

public struct GhostteaDecodedFrameSummary: Equatable, Sendable {
  public let sessionHandle: UInt64
  public let frameSequence: UInt64
  public let terminalRevision: UInt64
  public let columns: UInt16
  public let rows: UInt16
  public let sectionCount: Int
  public let glyphDefinitionCount: Int
  public let styleDefinitionCount: Int
  public let rowReplacementCount: Int
  public let accessibilityRows: [String]
  public let cursorRow: UInt16?
  public let scrollbarLength: UInt64?
  public let clipboardWrites: [String]
}

public enum GhostteaTerminalFrameDecoder {
  public static func inspect(_ data: Data) throws -> GhostteaDecodedFrameSummary {
    let frame = try decodeTRF1Frame(data)
    var glyphDefinitionCount = 0
    var styleDefinitionCount = 0
    var rowReplacementCount = 0
    var accessibilityRows: [String] = []
    var cursorRow: UInt16?
    var scrollbarLength: UInt64?
    var clipboardWrites: [String] = []

    for section in frame.sections {
      switch section.kind {
      case .glyphDefinitions:
        glyphDefinitionCount += try decodeTRF1GlyphDefinitions(section).count
      case .styleDefinitions:
        styleDefinitionCount += try decodeTRF1StyleDefinitions(section).count
      case .rowReplacements:
        rowReplacementCount += try decodeTRF1RowReplacements(section).count
      case .cursorState:
        cursorRow = try decodeTRF1CursorState(section).y
      case .accessibilityText:
        accessibilityRows += try decodeTRF1AccessibilityRows(section).map(\.text)
      case .scrollbarState:
        scrollbarLength = try decodeTRF1ScrollbarState(section).length
      case .clipboardWrite:
        clipboardWrites.append(try decodeTRF1ClipboardWrite(section))
      default:
        continue
      }
    }

    return GhostteaDecodedFrameSummary(
      sessionHandle: frame.sessionHandle,
      frameSequence: frame.frameSequence,
      terminalRevision: frame.terminalRevision,
      columns: frame.columns,
      rows: frame.rows,
      sectionCount: frame.sections.count,
      glyphDefinitionCount: glyphDefinitionCount,
      styleDefinitionCount: styleDefinitionCount,
      rowReplacementCount: rowReplacementCount,
      accessibilityRows: accessibilityRows,
      cursorRow: cursorRow,
      scrollbarLength: scrollbarLength,
      clipboardWrites: clipboardWrites
    )
  }
}
