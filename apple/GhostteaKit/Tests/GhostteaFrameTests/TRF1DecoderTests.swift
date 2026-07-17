import Foundation
import GhostteaCore
import Testing
@testable import GhostteaFrame

private func writeUInt16(_ value: UInt16, to data: inout Data, at offset: Int) {
  data[offset] = UInt8(truncatingIfNeeded: value)
  data[offset + 1] = UInt8(truncatingIfNeeded: value >> 8)
}

private func writeUInt32(_ value: UInt32, to data: inout Data, at offset: Int) {
  for byte in 0..<4 {
    data[offset + byte] = UInt8(truncatingIfNeeded: value >> UInt32(byte * 8))
  }
}

private func writeUInt64(_ value: UInt64, to data: inout Data, at offset: Int) {
  for byte in 0..<8 {
    data[offset + byte] = UInt8(truncatingIfNeeded: value >> UInt64(byte * 8))
  }
}

private func accessibilityFixture(_ text: String = "hello") -> Data {
  let textBytes = Data(text.utf8)
  let payloadLength = 2 + 6 + textBytes.count
  var data = Data(repeating: 0, count: TRF1.frameHeaderBytes + TRF1.sectionHeaderBytes + payloadLength)
  writeUInt32(TRF1.magic, to: &data, at: 0)
  writeUInt16(TRF1.protocolVersion, to: &data, at: 4)
  writeUInt64(7, to: &data, at: 8)
  writeUInt64(3, to: &data, at: 40)
  writeUInt16(80, to: &data, at: 56)
  writeUInt16(24, to: &data, at: 58)
  writeUInt16(1, to: &data, at: 60)
  writeUInt16(TRF1SectionKind.accessibilityText.rawValue, to: &data, at: 64)
  writeUInt32(80, to: &data, at: 68)
  writeUInt32(UInt32(payloadLength), to: &data, at: 72)
  writeUInt32(1, to: &data, at: 76)
  writeUInt16(1, to: &data, at: 80)
  writeUInt16(0, to: &data, at: 82)
  writeUInt32(UInt32(textBytes.count), to: &data, at: 84)
  data.replaceSubrange(88..<(88 + textBytes.count), with: textBytes)
  return data
}

@Test func decodesTheDesktopAccessibilityFixtureShape() throws {
  let frame = try decodeTRF1Frame(accessibilityFixture())
  #expect(frame.sessionHandle == 7)
  #expect(frame.frameSequence == 3)
  #expect(frame.columns == 80)
  #expect(frame.rows == 24)
  #expect(try decodeTRF1AccessibilityRows(frame.sections[0]) == [TRF1TextRow(row: 0, text: "hello")])
}

@Test func decodesAProductionCoreFrameAndEveryEmittedSection() async throws {
  let runtime = try GhostteaRuntime()
  let terminal = try GhostteaTerminal(
    runtime: runtime,
    configuration: .init(sessionHandle: 73, sessionEpoch: 4, layoutEpoch: 9, columns: 100, rows: 30)
  )
  let update = try await terminal.feed(Data("phase4 ✓ 界\r\n".utf8), render: .full)
  let bytes = try #require(update.effects.first { $0.kind == .frameReady }?.payload)
  let frame = try decodeTRF1Frame(bytes)
  #expect(frame.flags.contains(.fullSnapshot))
  #expect(frame.sessionHandle == 73)
  #expect(frame.sessionEpoch == 4)
  #expect(frame.layoutEpoch == 9)
  #expect(frame.columns == 100)
  #expect(frame.rows == 30)

  let glyphSection = try #require(frame.sections.first { $0.kind == .glyphDefinitions })
  let styleSection = try #require(frame.sections.first { $0.kind == .styleDefinitions })
  let rowSection = try #require(frame.sections.first { $0.kind == .rowReplacements })
  let cursorSection = try #require(frame.sections.first { $0.kind == .cursorState })
  let accessibilitySection = try #require(frame.sections.first { $0.kind == .accessibilityText })
  let scrollbarSection = try #require(frame.sections.first { $0.kind == .scrollbarState })

  #expect(try !decodeTRF1GlyphDefinitions(glyphSection).isEmpty)
  #expect(try !decodeTRF1StyleDefinitions(styleSection).isEmpty)
  #expect(try decodeTRF1RowReplacements(rowSection).contains { $0.text.contains("phase4 ✓ 界") })
  #expect(try decodeTRF1CursorState(cursorSection).y == 1)
  #expect(try decodeTRF1AccessibilityRows(accessibilitySection).contains { $0.text.contains("phase4 ✓ 界") })
  let scrollbar = try decodeTRF1ScrollbarState(scrollbarSection)
  #expect(scrollbar.length == 30)
  #expect(scrollbar.length <= scrollbar.total)
}

@Test func rejectsMalformedFrameEnvelopeBeforeSectionAllocation() {
  var wrongVersion = accessibilityFixture()
  writeUInt16(TRF1.protocolVersion + 1, to: &wrongVersion, at: 4)
  #expect(throws: TRF1DecodingError.self) {
    try decodeTRF1Frame(wrongVersion)
  }

  var invalidSection = accessibilityFixture()
  writeUInt32(UInt32.max - 15, to: &invalidSection, at: 68)
  #expect(throws: TRF1DecodingError.self) {
    try decodeTRF1Frame(invalidSection)
  }

  #expect(throws: TRF1DecodingError.self) {
    try decodeTRF1Frame(Data(repeating: 0, count: TRF1.maximumFrameBytes + 1))
  }
}

@Test func rejectsInvalidUTF8CountsPixelsAndReservedFields() throws {
  var invalidUTF8 = accessibilityFixture()
  invalidUTF8[88] = 0xff
  let textFrame = try decodeTRF1Frame(invalidUTF8)
  #expect(throws: TRF1DecodingError.self) {
    try decodeTRF1AccessibilityRows(textFrame.sections[0])
  }

  var glyphBytes = Data(repeating: 0, count: 4 + 20 + 4)
  writeUInt32(1, to: &glyphBytes, at: 0)
  writeUInt32(12, to: &glyphBytes, at: 4)
  writeUInt16(2, to: &glyphBytes, at: 8)
  writeUInt16(2, to: &glyphBytes, at: 10)
  writeUInt32(3, to: &glyphBytes, at: 20)
  let glyphSection = TRF1Section(kind: .glyphDefinitions, flags: 0, itemCount: 1, bytes: glyphBytes)
  #expect(throws: TRF1DecodingError.self) {
    try decodeTRF1GlyphDefinitions(glyphSection)
  }

  var hostileCount = Data(repeating: 0, count: 4)
  writeUInt32(UInt32.max, to: &hostileCount, at: 0)
  #expect(throws: TRF1DecodingError.self) {
    try decodeTRF1GlyphDefinitions(
      TRF1Section(kind: .glyphDefinitions, flags: 0, itemCount: UInt32.max, bytes: hostileCount)
    )
  }

  var styleBytes = Data(repeating: 0, count: 20)
  writeUInt32(1, to: &styleBytes, at: 0)
  styleBytes[18] = 1
  let styleSection = TRF1Section(kind: .styleDefinitions, flags: 0, itemCount: 1, bytes: styleBytes)
  #expect(throws: TRF1DecodingError.self) {
    try decodeTRF1StyleDefinitions(styleSection)
  }

  let cursorSection = TRF1Section(
    kind: .cursorState,
    flags: 0,
    itemCount: 1,
    bytes: Data([0, 0, 0, 0, 1, 4, 0, 0])
  )
  #expect(throws: TRF1DecodingError.self) {
    try decodeTRF1CursorState(cursorSection)
  }
}

@Test func decodesClipboardAndRejectsUnboundedScrollbarState() throws {
  let text = Data("copied ✓".utf8)
  var clipboard = Data(repeating: 0, count: 4 + text.count)
  writeUInt32(UInt32(text.count), to: &clipboard, at: 0)
  clipboard.replaceSubrange(4..<(4 + text.count), with: text)
  #expect(
    try decodeTRF1ClipboardWrite(
      TRF1Section(kind: .clipboardWrite, flags: 0, itemCount: 1, bytes: clipboard)
    ) == "copied ✓"
  )

  var scrollbar = Data(repeating: 0, count: 24)
  writeUInt64(10, to: &scrollbar, at: 0)
  writeUInt64(9, to: &scrollbar, at: 8)
  writeUInt64(2, to: &scrollbar, at: 16)
  #expect(throws: TRF1DecodingError.self) {
    try decodeTRF1ScrollbarState(
      TRF1Section(kind: .scrollbarState, flags: 0, itemCount: 1, bytes: scrollbar)
    )
  }
}
