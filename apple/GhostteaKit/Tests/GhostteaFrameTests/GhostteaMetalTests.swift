import Foundation
import GhostteaCore
import Metal
import Testing
@testable import GhostteaFrame
@testable import GhostteaTerminal

private func glyph(
  id: UInt32,
  width: UInt16 = 2,
  height: UInt16 = 2,
  format: TRF1GlyphFormat = .alpha8
) -> TRF1GlyphDefinition {
  let bytesPerPixel = format == .alpha8 ? 1 : 4
  return TRF1GlyphDefinition(
    id: id,
    width: width,
    height: height,
    bearingX: 0,
    bearingY: 0,
    format: format,
    pixels: Data(
      repeating: UInt8(truncatingIfNeeded: id),
      count: Int(width) * Int(height) * bytesPerPixel
    )
  )
}

private func productionFrame() async throws -> Data {
  let runtime = try GhostteaRuntime()
  let terminal = try GhostteaTerminal(
    runtime: runtime,
    configuration: .init(sessionHandle: 109, columns: 100, rows: 30)
  )
  let update = try await terminal.feed(Data("Metal proof ✓ 界\r\n".utf8), render: .full)
  return try #require(update.effects.first { $0.kind == .frameReady }?.payload)
}

@Test func metalProofUploadsAProductionFrameAndThenHitsTheCache() async throws {
  let frame = try await productionFrame()
  let result = try GhostteaMetalProof.run(frame: frame)

  #expect(!result.deviceName.isEmpty)
  #expect(result.uploadedBytes > 0)
  #expect(result.cachedUploadBytes == 0)
  #expect(result.alphaGlyphCount > 0)
  #expect(result.residentAtlasBytes == 20 * 1024 * 1024)
}

@Test func metalAtlasesUseTheRequiredFormatsAndDeterministicShelfPlacement() throws {
  let runtime = try GhostteaMetalRuntime()
  let atlases = try GhostteaMetalAtlasSet(runtime: runtime, alphaSize: 8, colorSize: 8)
  let alpha = glyph(id: 1)
  let color = glyph(id: 2, format: .rgba8Premultiplied)

  let first = try atlases.synchronize(visible: [color, alpha])
  let second = try atlases.synchronize(visible: [alpha, color])

  #expect(atlases.alpha.texture.pixelFormat == .r8Unorm)
  #expect(atlases.color.texture.pixelFormat == .rgba8Unorm)
  #expect(
    atlases.alpha.location(for: 1)
      == GhostteaAtlasLocation(x: 1, y: 1, width: 2, height: 2, atlasSize: 8)
  )
  #expect(
    atlases.color.location(for: 2)
      == GhostteaAtlasLocation(x: 1, y: 1, width: 2, height: 2, atlasSize: 8)
  )
  #expect(first.uploadedBytes == 20)
  #expect(second.uploadedBytes == 0)
  #expect(!first.alphaReset)
  #expect(!first.colorReset)
}

@Test func metalAtlasResetsOnlyWhenTheVisibleSetFitsAnEmptyAtlas() throws {
  let runtime = try GhostteaMetalRuntime()
  let atlases = try GhostteaMetalAtlasSet(runtime: runtime, alphaSize: 8, colorSize: 8)

  _ = try atlases.synchronize(visible: [glyph(id: 1), glyph(id: 2), glyph(id: 3)])
  let result = try atlases.synchronize(visible: [glyph(id: 4), glyph(id: 5)])

  #expect(result.alphaReset)
  #expect(atlases.alpha.resetCount == 1)
  #expect(atlases.alpha.glyphCount == 2)
  #expect(atlases.alpha.location(for: 1) == nil)
  #expect(atlases.alpha.location(for: 4)?.x == 1)
  #expect(atlases.alpha.location(for: 5)?.x == 4)
}

@Test func metalAtlasRejectsAnUnrepresentableVisibleWorkingSet() throws {
  let runtime = try GhostteaMetalRuntime()
  let atlases = try GhostteaMetalAtlasSet(runtime: runtime, alphaSize: 8, colorSize: 8)

  #expect(throws: GhostteaMetalError.self) {
    try atlases.synchronize(visible: [glyph(id: 1, width: 7, height: 2)])
  }
  #expect(atlases.alpha.glyphCount == 0)
  #expect(atlases.alpha.resetCount == 0)
}

@Test func metalAtlasRejectsInvalidPixelStorageBeforeUpload() throws {
  let runtime = try GhostteaMetalRuntime()
  let atlases = try GhostteaMetalAtlasSet(runtime: runtime, alphaSize: 8, colorSize: 8)
  let malformed = TRF1GlyphDefinition(
    id: 7,
    width: 2,
    height: 2,
    bearingX: 0,
    bearingY: 0,
    format: .alpha8,
    pixels: Data([1, 2, 3])
  )

  #expect(throws: GhostteaMetalError.invalidGlyphPixels(7, 4, 3)) {
    try atlases.synchronize(visible: [malformed])
  }
  #expect(atlases.alpha.glyphCount == 0)
}
