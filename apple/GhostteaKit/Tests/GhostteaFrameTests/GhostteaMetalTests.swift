import Foundation
import GhostteaCore
import GhostteaTransport
import Metal
import Testing

@testable import GhostteaFrame
@testable import GhostteaTerminal

private actor ResizeTestRecorder {
  var events: [String] = []
  var commits: [GhostteaResizeCommit] = []
  var failures: [GhostteaResizeFailure] = []

  func record(_ event: String) { events.append(event) }
  func commit(_ value: GhostteaResizeCommit) { commits.append(value) }
  func fail(_ value: GhostteaResizeFailure) { failures.append(value) }

  func waitForEvent(_ expected: String) async {
    while !events.contains(expected) {
      await Task.yield()
    }
  }
}

private enum ResizeTestError: Error {
  case failed
}

private let blinkingCursor = TRF1CursorState(
  x: 4,
  y: 2,
  visible: true,
  style: .block,
  blinking: true
)

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
  let bytes = Data("Metal proof ✓ 界 \u{1b}[31;44;4;9mstyled\u{1b}[0m 🙂\r\n".utf8)
  let update = try await terminal.feed(bytes, render: .full)
  return try #require(update.effects.first { $0.kind == .frameReady }?.payload)
}

@Test func terminalLayoutMatchesDesktopGeometryAndSafeAreaInsets() {
  #expect(
    GhostteaTerminalLayout.gridSize(width: 787, height: 574)
      == GhostteaTerminalGridSize(columns: 100, rows: 30)
  )
  #expect(
    GhostteaTerminalLayout.gridSize(
      width: 390,
      height: 844,
      contentInsets: .init(top: 59, bottom: 34)
    ) == GhostteaTerminalGridSize(columns: 49, rows: 39)
  )
  #expect(
    GhostteaTerminalLayout.gridSize(
      width: 844,
      height: 390,
      contentInsets: .init(left: 59, bottom: 21, right: 59)
    ) == GhostteaTerminalGridSize(columns: 92, rows: 19)
  )
}

@Test func terminalLayoutClampsDegenerateAndUnboundedViewports() {
  #expect(
    GhostteaTerminalLayout.gridSize(width: 0, height: .nan)
      == GhostteaTerminalGridSize(columns: 1, rows: 1)
  )
  #expect(
    GhostteaTerminalLayout.gridSize(
      width: .greatestFiniteMagnitude, height: .greatestFiniteMagnitude)
      == GhostteaTerminalGridSize(columns: .max, rows: .max)
  )
}

@MainActor
@Test func cursorBlinkMatchesDesktopResetAndEligibilityRules() {
  #expect(GhostteaCursorBlinkController.interval == .milliseconds(600))
  var transitions: [Bool] = []
  let controller = GhostteaCursorBlinkController { transitions.append($0) }

  controller.updateCursor(blinkingCursor)
  #expect(controller.timerScheduled)
  #expect(controller.blinkVisible)

  controller.handleTimerFired()
  #expect(controller.timerScheduled)
  #expect(!controller.blinkVisible)
  #expect(transitions == [false])

  controller.noteCursorActivity()
  #expect(controller.timerScheduled)
  #expect(controller.blinkVisible)
  #expect(transitions == [false, true])

  controller.setFocused(false)
  #expect(!controller.timerScheduled)
  controller.setFocused(true)
  #expect(controller.timerScheduled)

  controller.setSurfaceVisible(false)
  #expect(!controller.timerScheduled)
  controller.setSurfaceVisible(true)
  #expect(controller.timerScheduled)
}

@MainActor
@Test func cursorBlinkStopsForStaticOrHiddenCursorsAndResetsOnCursorChange() {
  var transitions: [Bool] = []
  let controller = GhostteaCursorBlinkController { transitions.append($0) }

  controller.updateCursor(blinkingCursor)
  controller.handleTimerFired()
  #expect(!controller.blinkVisible)

  controller.updateCursor(
    TRF1CursorState(x: 5, y: 2, visible: true, style: .block, blinking: true)
  )
  #expect(controller.blinkVisible)
  #expect(controller.timerScheduled)

  controller.updateCursor(
    TRF1CursorState(x: 5, y: 2, visible: true, style: .block, blinking: false)
  )
  #expect(!controller.timerScheduled)
  controller.updateCursor(
    TRF1CursorState(x: 5, y: 2, visible: false, style: .block, blinking: true)
  )
  #expect(!controller.timerScheduled)
  #expect(transitions == [false, true])
}

@Test func resizeCoordinatorOrdersPTYBeforeCoreAndPublishesAFullFrame() async throws {
  let runtime = try GhostteaRuntime()
  let terminal = try GhostteaTerminal(
    runtime: runtime,
    configuration: .init(sessionHandle: 130, layoutEpoch: 1, columns: 80, rows: 24)
  )
  let connection = ReplayTransport(bytes: Data()).makeConnection()
  let recorder = ResizeTestRecorder()
  let coordinator = GhostteaResizeCoordinator(
    terminal: terminal,
    connection: connection,
    initialSize: .init(columns: 80, rows: 24),
    onCommit: { await recorder.commit($0) },
    onFailure: { await recorder.fail($0) }
  )

  await coordinator.request(.init(columns: 100, rows: 30))
  await coordinator.waitUntilIdle()

  let transport = await connection.snapshot()
  let commits = await recorder.commits
  #expect(transport.resizes == [try TerminalSize(columns: 100, rows: 30)])
  #expect(commits.count == 1)
  let commit = try #require(commits.first)
  #expect(commit.layoutEpoch == 2)
  let frameData = try #require(commit.update.effects.first { $0.kind == .frameReady }?.payload)
  let frame = try decodeTRF1Frame(frameData)
  #expect(frame.columns == 100)
  #expect(frame.rows == 30)
  #expect(frame.layoutEpoch == 2)
}

@Test func resizeCoordinatorCoalescesBurstsAndSuppressesSupersededFrames() async throws {
  let runtime = try GhostteaRuntime()
  let terminal = try GhostteaTerminal(
    runtime: runtime,
    configuration: .init(sessionHandle: 131, columns: 80, rows: 24)
  )
  let recorder = ResizeTestRecorder()
  let coordinator = GhostteaResizeCoordinator(
    initialSize: .init(columns: 80, rows: 24),
    resizeCore: { size, epoch in
      await recorder.record("core:\(size.columns)x\(size.rows)")
      return try await terminal.resize(
        columns: size.columns, rows: size.rows, layoutEpoch: epoch, render: .full)
    },
    resizeTransport: { size in
      await recorder.record("pty:\(size.columns)x\(size.rows)")
      if size.columns == 90 {
        try await Task.sleep(for: .milliseconds(40))
      }
    },
    onCommit: { await recorder.commit($0) }
  )

  await coordinator.request(.init(columns: 90, rows: 25))
  await recorder.waitForEvent("pty:90x25")
  await coordinator.request(.init(columns: 91, rows: 26))
  await coordinator.request(.init(columns: 92, rows: 27))
  await coordinator.waitUntilIdle()

  #expect(await recorder.events == ["pty:90x25", "core:90x25", "pty:92x27", "core:92x27"])
  let commits = await recorder.commits
  #expect(commits.map(\.size) == [.init(columns: 92, rows: 27)])
  #expect(commits.map(\.layoutEpoch) == [3])
}

@Test func resizeCoordinatorRollsBackPTYWhenCoreResizeFails() async {
  let recorder = ResizeTestRecorder()
  let coordinator = GhostteaResizeCoordinator(
    initialSize: .init(columns: 80, rows: 24),
    resizeCore: { _, _ in throw ResizeTestError.failed },
    resizeTransport: { size in await recorder.record("pty:\(size.columns)x\(size.rows)") },
    onCommit: { await recorder.commit($0) },
    onFailure: { await recorder.fail($0) }
  )

  await coordinator.request(.init(columns: 100, rows: 30))
  await coordinator.waitUntilIdle()

  #expect(await recorder.events == ["pty:100x30", "pty:80x24"])
  #expect(await recorder.commits.isEmpty)
  #expect(await recorder.failures.count == 1)
}

@Test func metalProofUploadsAProductionFrameAndThenHitsTheCache() async throws {
  let frame = try await productionFrame()
  let result = try GhostteaMetalProof.run(frame: frame)

  #expect(!result.deviceName.isEmpty)
  #expect(result.uploadedBytes > 0)
  #expect(result.cachedUploadBytes == 0)
  #expect(result.alphaGlyphCount > 0)
  #expect(result.colorGlyphCount > 0)
  #expect(result.residentAtlasBytes == 20 * 1024 * 1024)
  #expect(result.renderedWidth == 787)
  #expect(result.renderedHeight == 574)
  #expect(result.rectangleVertexCount > 0)
  #expect(result.alphaGlyphVertexCount > 0)
  #expect(result.colorGlyphVertexCount > 0)
  #expect(result.nonBackgroundPixelCount > 0)
  #expect(result.pixelHash != 0)
}

@Test func packagedMetalLibraryContainsEveryRendererFunction() throws {
  let renderer = try GhostteaMetalRenderer(
    runtime: GhostteaMetalRuntime(), alphaAtlasSize: 8, colorAtlasSize: 8)

  #expect(
    renderer.shaderFunctionNames
      == [
        "ghosttea_rectangle_vertex",
        "ghosttea_rectangle_fragment",
        "ghosttea_glyph_vertex",
        "ghosttea_alpha_glyph_fragment",
        "ghosttea_color_glyph_fragment",
      ]
  )
}

@Test func metalRendererPreservesPixelsAcrossCachedFramesAndAddsViewSelection() async throws {
  let frame = try await productionFrame()
  var state = RetainedTRF1State()
  _ = try state.apply(frame)
  let runtime = try GhostteaMetalRuntime()
  let renderer = try GhostteaMetalRenderer(
    runtime: runtime, alphaAtlasSize: 512, colorAtlasSize: 512)
  let plain = try renderer.render(state: state, width: 420, height: 100)
  let selected = try renderer.render(
    state: state,
    width: 420,
    height: 100,
    selection: GhostteaMetalSelection(
      anchor: GhostteaMetalCellPoint(column: 0, row: 0),
      focus: GhostteaMetalCellPoint(column: 4, row: 0)
    )
  )
  let selectedAgain = try renderer.render(
    state: state,
    width: 420,
    height: 100,
    selection: GhostteaMetalSelection(
      anchor: GhostteaMetalCellPoint(column: 4, row: 0),
      focus: GhostteaMetalCellPoint(column: 0, row: 0)
    )
  )

  #expect(plain.atlasUpload.uploadedBytes > 0)
  #expect(selected.atlasUpload.uploadedBytes == 0)
  #expect(selectedAgain.atlasUpload.uploadedBytes == 0)
  #expect(plain.alphaGlyphVertexCount > 0)
  #expect(plain.rectangleVertexCount > 0)
  #expect(selected.rectangleVertexCount == plain.rectangleVertexCount + 6)
  #expect(selected.pixelHash != plain.pixelHash)
  #expect(selectedAgain.pixelHash == selected.pixelHash)
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
