import Foundation
import GhostteaCore

public enum GhostteaTerminalStateCodec {
  public static func decode(
    _ payload: Data,
    codec: GhostteaStateCodec,
    protocolMinor: UInt16 = GhostteaTruffleContract.protocolMinor
  ) throws -> GhostteaTerminalStateMessage {
    guard payload.count <= GhostteaTruffleContract.maximumStateMessageBytes else {
      throw GhostteaTruffleError.messageTooLarge(
        limit: GhostteaTruffleContract.maximumStateMessageBytes
      )
    }
    switch codec {
    case .json:
      let decoder = JSONDecoder()
      decoder.userInfo[.ghostteaProtocolMinor] = protocolMinor
      return try decoder.decode(GhostteaTerminalStateMessage.self, from: payload)
    case .compactJSONV1:
      let decoder = JSONDecoder()
      decoder.userInfo[.ghostteaProtocolMinor] = protocolMinor
      return try decoder.decode(CompactStateMessage.self, from: payload).message
    }
  }
}

private struct CompactStateMessage: Decodable {
  let message: GhostteaTerminalStateMessage

  private struct Key: CodingKey {
    let stringValue: String
    let intValue: Int? = nil
    init?(stringValue: String) { self.stringValue = stringValue }
    init?(intValue: Int) { return nil }
  }

  init(from decoder: Decoder) throws {
    let values = try decoder.container(keyedBy: Key.self)
    guard values.allKeys.count == 1, let key = values.allKeys.first else {
      throw GhostteaTruffleError.malformedMessage
    }
    switch key.stringValue {
    case "s":
      var tuple = try values.nestedUnkeyedContainer(forKey: key)
      let sessionEpoch = try tuple.decode(UInt64.self)
      let layoutEpoch = try tuple.decode(UInt64.self)
      let terminalRevision = try tuple.decode(UInt64.self)
      let columns = try tuple.decode(UInt16.self)
      let rows = try tuple.decode([CompactRow].self).map(\.value)
      let cursor = try tuple.decode(CompactCursor.self).value
      let mouseTracking = try tuple.decode(Bool.self)
      let scrollbar = try tuple.decode(CompactScrollbar.self).value
      let title = try tuple.decodeIfPresent(String.self)
      let cwd = try tuple.decodeIfPresent(String.self)
      try requireEnd(tuple)
      message = .snapshot(
        GhostteaLogicalSnapshot(
          sessionEpoch: sessionEpoch,
          layoutEpoch: layoutEpoch,
          terminalRevision: terminalRevision,
          cols: columns,
          rows: rows,
          cursor: cursor,
          mouseTracking: mouseTracking,
          scrollbar: scrollbar,
          title: title,
          cwd: cwd
        )
      )
    case "p":
      var tuple = try values.nestedUnkeyedContainer(forKey: key)
      let sessionEpoch = try tuple.decode(UInt64.self)
      let layoutEpoch = try tuple.decode(UInt64.self)
      let patchSequence = try tuple.decode(UInt64.self)
      let terminalRevision = try tuple.decode(UInt64.self)
      let replacements = try tuple.decode([CompactReplacement].self).map(\.value)
      let cursor = try tuple.decodeIfPresent(CompactCursor.self)?.value
      let mouseTracking = try tuple.decodeIfPresent(Bool.self)
      let scrollbar = try tuple.decodeIfPresent(CompactScrollbar.self)?.value
      guard try tuple.decode(UInt8.self) == 0 else {
        throw GhostteaTruffleError.malformedMessage
      }
      try requireEnd(tuple)
      message = .patch(
        GhostteaLogicalPatch(
          sessionEpoch: sessionEpoch,
          layoutEpoch: layoutEpoch,
          patchSequence: patchSequence,
          terminalRevision: terminalRevision,
          rowReplacements: replacements,
          cursor: cursor,
          mouseTracking: mouseTracking,
          scrollbar: scrollbar
        )
      )
    case "c":
      var tuple = try values.nestedUnkeyedContainer(forKey: key)
      message = try .controlChanged(
        controllerViewID: tuple.decode(String.self),
        controlEpoch: tuple.decode(UInt64.self),
        cols: tuple.decode(UInt16.self),
        rows: tuple.decode(UInt16.self),
        layoutEpoch: tuple.decode(UInt64.self)
      )
      try requireEnd(tuple)
    // Compact tuples are never widened — an appended element is a decode error
    // on the peer, not a default — so the revisioned controller shape gets its
    // own tag and "c" keeps decoding byte-identically from legacy hosts.
    case "cs":
      var tuple = try values.nestedUnkeyedContainer(forKey: key)
      let controller = try tuple.decodeIfPresent(CompactController.self)?.value
      message = try .controlState(
        controller: controller,
        controlRevision: tuple.decode(UInt64.self),
        cols: tuple.decode(UInt16.self),
        rows: tuple.decode(UInt16.self),
        layoutEpoch: tuple.decode(UInt64.self)
      )
      try requireEnd(tuple)
    case "se":
      var tuple = try values.nestedUnkeyedContainer(forKey: key)
      let reason = try tuple.decode(String.self)
      // Read the exit slot rather than treating its absence as null: a short
      // tuple is a decode error on the Rust side, and a codec that shrugs at
      // one here would let the two planes disagree about the shape.
      guard !tuple.isAtEnd else { throw GhostteaTruffleError.malformedMessage }
      let exitCode = try tuple.decodeNil() ? nil : tuple.decode(Int32.self)
      try requireEnd(tuple)
      switch reason {
      case "exited": message = .sessionEnded(.exited(code: exitCode))
      // An exit code on a session nobody says exited is a contradiction, not a
      // field to ignore.
      case "closed" where exitCode == nil: message = .sessionEnded(.closed)
      default: throw GhostteaTruffleError.malformedMessage
      }
    case "hs":
      let tuple = try values.nestedUnkeyedContainer(forKey: key)
      try requireEnd(tuple)
      message = .hostShutdown
    case "a":
      message = try .activityChanged(values.decode(GhostteaSessionActivity.self, forKey: key))
    case "g":
      let presentation = try values.decode(
        GhostteaTerminalPresentationConfig.self, forKey: key)
      guard presentation.isValid else { throw GhostteaTruffleError.malformedMessage }
      message = .configurationChanged(presentation)
    case "l":
      guard !(try values.decodeNil(forKey: key)) else {
        message = .selectionChanged(nil)
        return
      }
      var tuple = try values.nestedUnkeyedContainer(forKey: key)
      let selection = try GhostteaTrackedSelection(
        anchor: GhostteaTrackedSelectionPoint(
          column: tuple.decode(UInt16.self),
          row: tuple.decode(UInt32.self)
        ),
        focus: GhostteaTrackedSelectionPoint(
          column: tuple.decode(UInt16.self),
          row: tuple.decode(UInt32.self)
        )
      )
      try requireEnd(tuple)
      message = .selectionChanged(selection)
    default:
      throw GhostteaTruffleError.malformedMessage
    }
  }
}

private struct CompactController: Decodable {
  let value: GhostteaControllerInfo

  init(from decoder: Decoder) throws {
    var tuple = try decoder.unkeyedContainer()
    value = try GhostteaControllerInfo(
      controllerViewID: tuple.decode(String.self),
      controlEpoch: tuple.decode(UInt64.self)
    )
    try requireEnd(tuple)
  }
}

private struct CompactReplacement: Decodable {
  let value: GhostteaRowReplacement

  init(from decoder: Decoder) throws {
    var tuple = try decoder.unkeyedContainer()
    value = try GhostteaRowReplacement(
      rowIndex: tuple.decode(UInt16.self),
      rowRevision: tuple.decode(UInt64.self),
      row: tuple.decode(CompactRow.self).value
    )
    try requireEnd(tuple)
  }
}

private struct CompactRow: Decodable {
  let value: GhostteaLogicalRow

  init(from decoder: Decoder) throws {
    var tuple = try decoder.unkeyedContainer()
    value = try GhostteaLogicalRow(
      text: tuple.decode(String.self),
      cells: tuple.decode([CompactCell].self).map(\.value)
    )
    try requireEnd(tuple)
  }
}

private struct CompactCell: Decodable {
  let value: GhostteaLogicalCell

  init(from decoder: Decoder) throws {
    var tuple = try decoder.unkeyedContainer()
    value = try GhostteaLogicalCell(
      column: tuple.decode(UInt16.self),
      span: tuple.decode(UInt16.self),
      text: tuple.decode(String.self),
      style: tuple.decode(CompactCellStyle.self).value
    )
    try requireEnd(tuple)
  }
}

private struct CompactCellStyle: Decodable {
  let value: GhostteaLogicalCellStyle

  init(from decoder: Decoder) throws {
    var tuple = try decoder.unkeyedContainer()
    let flags = try tuple.decode(UInt8.self)
    let semantic = flags & 0x80 != 0
    let protocolMinor =
      decoder.userInfo[.ghostteaProtocolMinor] as? UInt16
      ?? GhostteaTruffleContract.protocolMinor
    guard
      !semantic || protocolMinor >= GhostteaTruffleContract.semanticCellColorProtocolMinor
    else {
      throw GhostteaTruffleError.malformedMessage
    }
    let foreground: CompactDecodedColor
    let background: CompactDecodedColor
    if semantic {
      foreground = try decodeSemanticColor(&tuple)
      background = try decodeSemanticColor(&tuple)
    } else {
      foreground = try decodeLegacyColor(&tuple)
      background = try decodeLegacyColor(&tuple)
    }
    try requireEnd(tuple)
    value = GhostteaLogicalCellStyle(
      bold: flags & 1 != 0,
      italic: flags & 2 != 0,
      faint: flags & 4 != 0,
      inverse: flags & 8 != 0,
      invisible: flags & 16 != 0,
      strikethrough: flags & 32 != 0,
      underline: flags & 64 != 0,
      foreground: foreground.rgb,
      background: background.rgb,
      foregroundDefault: foreground.isDefault,
      foregroundPalette: foreground.palette,
      backgroundDefault: background.isDefault,
      backgroundPalette: background.palette
    )
  }
}

private struct CompactCursor: Decodable {
  let value: GhostteaLogicalCursor

  init(from decoder: Decoder) throws {
    var tuple = try decoder.unkeyedContainer()
    value = try GhostteaLogicalCursor(
      x: tuple.decode(UInt16.self),
      y: tuple.decode(UInt16.self),
      visible: tuple.decode(Bool.self),
      style: tuple.decode(UInt8.self),
      blinking: tuple.decode(Bool.self)
    )
    try requireEnd(tuple)
  }
}

private struct CompactScrollbar: Decodable {
  let value: GhostteaLogicalScrollbar

  init(from decoder: Decoder) throws {
    var tuple = try decoder.unkeyedContainer()
    value = try GhostteaLogicalScrollbar(
      total: tuple.decode(UInt64.self),
      offset: tuple.decode(UInt64.self),
      len: tuple.decode(UInt64.self)
    )
    try requireEnd(tuple)
  }
}

private struct CompactDecodedColor {
  let rgb: [UInt8]?
  let isDefault: Bool
  let palette: UInt8?
}

private func decodeLegacyColor(
  _ container: inout UnkeyedDecodingContainer
) throws -> CompactDecodedColor {
  let color = try container.decodeIfPresent([UInt8].self)
  guard color == nil || color?.count == 3 else {
    throw GhostteaTruffleError.malformedMessage
  }
  return CompactDecodedColor(rgb: color, isDefault: false, palette: nil)
}

private func decodeSemanticColor(
  _ container: inout UnkeyedDecodingContainer
) throws -> CompactDecodedColor {
  let decoder = try container.superDecoder()
  let value = try decoder.singleValueContainer()
  if value.decodeNil() {
    return CompactDecodedColor(rgb: nil, isDefault: false, palette: nil)
  }
  if let palette = try? value.decode(UInt8.self) {
    return CompactDecodedColor(rgb: nil, isDefault: false, palette: palette)
  }
  let rgb = try value.decode([UInt8].self)
  guard rgb.count == 3 else { throw GhostteaTruffleError.malformedMessage }
  return CompactDecodedColor(rgb: rgb, isDefault: false, palette: nil)
}

private func requireEnd(_ container: UnkeyedDecodingContainer) throws {
  guard container.isAtEnd else { throw GhostteaTruffleError.malformedMessage }
}
