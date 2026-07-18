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

@Test func hardwareKeysNormalizeToDesktopCodesAndLayoutIdentity() throws {
  let shiftedA = try #require(
    GhostteaHardwareKeyEvent(
      hidUsage: 0x04,
      characters: "A",
      charactersIgnoringModifiers: "a",
      modifiers: [.shift],
      action: .down
    )
  )
  #expect(shiftedA.code == "KeyA")
  #expect(shiftedA.text == "A")
  #expect(shiftedA.unshiftedCodepoint == 97)
  #expect(shiftedA.coreEvent.modifiers == GhostteaInputModifiers.shift.rawValue)
  #expect(GhostteaHIDKeyCode.domCode(for: 0x27) == "Digit0")
  #expect(GhostteaHIDKeyCode.domCode(for: 0x50) == "ArrowLeft")
  #expect(GhostteaHIDKeyCode.domCode(for: 0x45) == "F12")
  #expect(GhostteaHIDKeyCode.domCode(for: 0x73) == "F24")
  #expect(GhostteaHIDKeyCode.domCode(for: 0xffff) == nil)

  let arrow = try #require(
    GhostteaHardwareKeyEvent(
      hidUsage: 0x50,
      characters: "\u{f702}",
      charactersIgnoringModifiers: "\u{f702}",
      action: .down
    )
  )
  #expect(arrow.text.isEmpty)
  #expect(arrow.unshiftedCodepoint == 0)

  let released = try #require(
    GhostteaHardwareKeyEvent(
      hidUsage: 0x04,
      characters: "a",
      charactersIgnoringModifiers: "a",
      action: .up
    )
  )
  #expect(released.text.isEmpty)
  #expect(released.unshiftedCodepoint == 97)
}

@Test func hardwareInputUsesSharedGhosttyEncodingAndDesktopBindings() async throws {
  let runtime = try GhostteaRuntime()
  let terminal = try GhostteaTerminal(
    runtime: runtime,
    configuration: .init(sessionHandle: 112, columns: 80, rows: 24)
  )
  let encoder = GhostteaTerminalInputEncoder(terminal: terminal)

  let letter = try #require(
    GhostteaHardwareKeyEvent(
      hidUsage: 0x04,
      characters: "a",
      charactersIgnoringModifiers: "a",
      action: .down
    )
  )
  #expect(try await encoder.encode(letter) == .bytes(Data("a".utf8)))

  let interrupt = try #require(
    GhostteaHardwareKeyEvent(
      hidUsage: 0x06,
      characters: "\u{3}",
      charactersIgnoringModifiers: "c",
      modifiers: [.control],
      action: .down
    )
  )
  #expect(try await encoder.encode(interrupt) == .bytes(Data([0x03])))

  let arrowUp = try #require(
    GhostteaHardwareKeyEvent(
      hidUsage: 0x52,
      characters: "",
      charactersIgnoringModifiers: "",
      action: .down
    )
  )
  #expect(try await encoder.encode(arrowUp) == .bytes(Data([0x1b, 0x5b, 0x41])))

  let optionLeft = try #require(
    GhostteaHardwareKeyEvent(
      hidUsage: 0x50,
      characters: "",
      charactersIgnoringModifiers: "",
      modifiers: [.option],
      action: .down
    )
  )
  #expect(try await encoder.encode(optionLeft) == .bytes(Data([0x1b, 0x62])))
  let optionLeftUp = try #require(
    GhostteaHardwareKeyEvent(
      hidUsage: 0x50,
      characters: "",
      charactersIgnoringModifiers: "",
      action: .up
    )
  )
  #expect(try await encoder.encode(optionLeftUp) == .ignored)

  let commandV = try #require(
    GhostteaHardwareKeyEvent(
      hidUsage: 0x19,
      characters: "v",
      charactersIgnoringModifiers: "v",
      modifiers: [.command],
      action: .down
    )
  )
  #expect(try await encoder.encode(commandV) == .pasteFromClipboard)
  let commandVUp = try #require(
    GhostteaHardwareKeyEvent(
      hidUsage: 0x19,
      characters: "v",
      charactersIgnoringModifiers: "v",
      action: .up
    )
  )
  #expect(try await encoder.encode(commandVUp) == .ignored)

  await encoder.setConfiguration(.init(optionKeyBehavior: .terminal))
  let terminalOptionLeft = try await encoder.encode(optionLeft)
  guard case .bytes(let terminalOptionBytes) = terminalOptionLeft else {
    Issue.record("terminal Option behavior did not use the shared key encoder")
    return
  }
  #expect(!terminalOptionBytes.isEmpty)
  #expect(terminalOptionBytes != Data([0x1b, 0x62]))
  #expect(await encoder.encodeCommittedText("界") == .bytes(Data("界".utf8)))
  #expect(try await encoder.encodePaste("paste") == Data("paste".utf8))
}

@Test func compositionBufferKeepsMarkedTextLocalUntilCommit() {
  var composition = GhostteaCompositionBuffer()
  #expect(
    composition.setMarkedText("にほん", selectedRange: NSRange(location: 3, length: 0))
      .isEmpty
  )
  #expect(
    composition.markedState
      == GhostteaMarkedTextState(text: "にほん", selectionLocation: 3, selectionLength: 0)
  )

  #expect(composition.deleteBackward().isEmpty)
  #expect(composition.markedState?.text == "にほ")
  #expect(composition.markedState?.selectionLocation == 2)
  #expect(composition.replace(NSRange(location: 1, length: 1), with: "字").isEmpty)
  #expect(composition.markedState?.text == "に字")
  #expect(composition.unmarkText() == [.text("に字")])
  #expect(composition.markedState == nil)

  let family = "👨‍👩‍👧‍👦"
  _ = composition.setMarkedText(
    family,
    selectedRange: NSRange(location: (family as NSString).length, length: 0)
  )
  #expect(
    composition.composedCharacterRange(
      adjoining: (family as NSString).length,
      towardStart: true
    ) == NSRange(location: 0, length: (family as NSString).length)
  )
  #expect(
    composition.composedCharacterRange(adjoining: 0, towardStart: false)
      == NSRange(location: 0, length: (family as NSString).length)
  )
  #expect(composition.deleteBackward().isEmpty)
  #expect(composition.markedState == nil)

  #expect(
    composition.insertText("alpha\r\nbeta\ngamma")
      == [.text("alpha"), .enter, .text("beta"), .enter, .text("gamma")]
  )
  #expect(composition.deleteBackward() == [.deleteBackward])
}

@Test func softwareInputUsesGhosttyEnterDeleteAndBracketedPaste() async throws {
  let runtime = try GhostteaRuntime()
  let terminal = try GhostteaTerminal(
    runtime: runtime,
    configuration: .init(sessionHandle: 113, columns: 80, rows: 24)
  )
  let encoder = GhostteaTerminalInputEncoder(terminal: terminal)

  #expect(try await encoder.encode(.text("界")) == .bytes(Data("界".utf8)))
  #expect(try await encoder.encode(.enter) == .bytes(Data([0x0d])))
  #expect(try await encoder.encode(.deleteBackward) == .bytes(Data([0x7f])))
  #expect(try await encoder.encode(.paste("")) == .ignored)

  _ = try await terminal.feed(Data("\u{1b}[?2004h".utf8), render: .none)
  let encodedPaste = try await encoder.encode(.paste("line 1\nline 2"))
  guard case .bytes(let pasteBytes) = encodedPaste else {
    Issue.record("software paste did not use the shared terminal encoder")
    return
  }
  #expect(pasteBytes.starts(with: Data("\u{1b}[200~".utf8)))
  let pasteSuffix = Data("\u{1b}[201~".utf8)
  #expect(Data(pasteBytes.suffix(pasteSuffix.count)) == pasteSuffix)
  #expect(pasteBytes.range(of: Data("line 1\nline 2".utf8)) != nil)
}

@Test func accessoryInputLatchesModifiersAndUsesNormalizedKeyEvents() async throws {
  var state = GhostteaAccessoryInputState()
  #expect(state.activate(.control) == nil)
  #expect(state.modifiers == [.control])

  let controlC = state.consume(.text("c"))
  guard case .key(let controlCKey) = controlC else {
    Issue.record("Control plus software text did not produce a normalized key event")
    return
  }
  #expect(controlCKey.code == "KeyC")
  #expect(controlCKey.modifiers == [.control])
  #expect(state.modifiers.isEmpty)

  #expect(state.activate(.option) == nil)
  guard case .key(let optionLeft) = state.activate(.arrowLeft) else {
    Issue.record("Alt plus accessory arrow did not produce a normalized key event")
    return
  }
  #expect(optionLeft.code == "ArrowLeft")
  #expect(optionLeft.modifiers == [.option])
  #expect(state.modifiers.isEmpty)

  guard case .key(let pipe) = state.activate(.pipe) else {
    Issue.record("Accessory pipe did not produce a normalized key event")
    return
  }
  #expect(pipe.code == "Backslash")
  #expect(pipe.text == "|")
  #expect(pipe.modifiers == [.shift])

  _ = state.activate(.control)
  #expect(state.consume(.text("界")) == .text("界"))
  #expect(state.modifiers.isEmpty)

  let runtime = try GhostteaRuntime()
  let terminal = try GhostteaTerminal(
    runtime: runtime,
    configuration: .init(sessionHandle: 114, columns: 80, rows: 24)
  )
  let encoder = GhostteaTerminalInputEncoder(terminal: terminal)
  #expect(try await encoder.encode(controlC) == .bytes(Data([0x03])))
  #expect(try await encoder.encode(.key(optionLeft)) == .bytes(Data([0x1b, 0x62])))
}

@Test func pointerRoutingAndMouseEncodingMatchTheDesktopBoundary() async throws {
  #expect(
    GhostteaPointerOwner.resolve(mouseTracking: false, forceLocalSelection: false)
      == .localSelection
  )
  #expect(
    GhostteaPointerOwner.resolve(mouseTracking: true, forceLocalSelection: false)
      == .remoteApplication
  )
  #expect(
    GhostteaPointerOwner.resolve(mouseTracking: true, forceLocalSelection: true)
      == .localSelection
  )

  let runtime = try GhostteaRuntime()
  let terminal = try GhostteaTerminal(
    runtime: runtime,
    configuration: .init(sessionHandle: 115, columns: 80, rows: 24)
  )
  let encoder = GhostteaTerminalInputEncoder(terminal: terminal)
  let press = GhostteaTerminalMouseEvent(
    action: .press,
    button: .left,
    x: 16,
    y: 22,
    screenWidth: 668,
    screenHeight: 404,
    cellWidth: 8,
    cellHeight: 19,
    paddingLeft: 14,
    paddingTop: 12
  )
  #expect(try await encoder.encode(press) == .bytes(Data()))

  let update = try await terminal.feed(Data("\u{1b}[?1000h\u{1b}[?1006h".utf8), render: .full)
  let frame = try #require(update.effects.first { $0.kind == .frameReady }?.payload)
  var state = RetainedTRF1State()
  _ = try state.apply(frame)
  #expect(state.mouseTracking)
  #expect(try await encoder.encode(press) == .bytes(Data("\u{1b}[<0;1;1M".utf8)))

  let disabled = try await terminal.feed(Data("\u{1b}[?1000l".utf8), render: .full)
  let disabledFrame = try #require(disabled.effects.first { $0.kind == .frameReady }?.payload)
  _ = try state.apply(disabledFrame)
  #expect(!state.mouseTracking)
}

@Test func sceneAttachmentTransfersAuthorityAndRejectsStaleDetach() async {
  let registry = GhostteaSceneAttachmentRegistry()
  let sessionID = UUID()
  let firstSceneID = UUID()
  let secondSceneID = UUID()
  await registry.registerScene(firstSceneID, phase: .active)
  await registry.registerScene(secondSceneID, phase: .inactive)

  let first = await registry.attach(sessionID: sessionID, to: firstSceneID)
  #expect(first.detached == nil)
  #expect(first.visible)

  let transferred = await registry.attach(sessionID: sessionID, to: secondSceneID)
  #expect(transferred.detached == first.attached)
  #expect(!transferred.visible)
  #expect(await !registry.detach(first.attached))
  #expect(await registry.attachment(for: sessionID) == transferred.attached)
  #expect(await registry.detach(transferred.attached))
  #expect(await registry.attachment(for: sessionID) == nil)
}

@Test func scenePhasesAffectOnlyCurrentAttachmentsAndDisconnectPreservesSessions() async {
  let registry = GhostteaSceneAttachmentRegistry()
  let firstSessionID = UUID()
  let secondSessionID = UUID()
  let sceneID = UUID()
  await registry.registerScene(sceneID, phase: .inactive)
  let first = await registry.attach(sessionID: firstSessionID, to: sceneID)
  let second = await registry.attach(sessionID: secondSessionID, to: sceneID)

  let active = await registry.updateScene(sceneID, phase: .active)
  #expect(active.map(\.attachment) == [first.attached, second.attached])
  #expect(active.allSatisfy { $0.visible })
  #expect(await registry.updateScene(sceneID, phase: .active).isEmpty)
  let background = await registry.updateScene(sceneID, phase: .background)
  #expect(background.map(\.visible) == [false, false])

  let detached = await registry.disconnectScene(sceneID)
  #expect(detached == [first.attached, second.attached])
  #expect(await registry.attachment(for: firstSessionID) == nil)
  #expect(await registry.attachment(for: secondSessionID) == nil)
}

@Test func aggregateSceneLifecycleKeepsAnotherActiveSceneForeground() {
  var lifecycle = GhostteaSceneLifecycleState()
  let firstSceneID = UUID()
  let secondSceneID = UUID()

  let firstActive = lifecycle.update(sceneID: firstSceneID, phase: .active)
  #expect(firstActive?.previous == .background)
  #expect(firstActive?.current == .active)
  #expect(lifecycle.update(sceneID: secondSceneID, phase: .active) == nil)

  #expect(lifecycle.update(sceneID: firstSceneID, phase: .background) == nil)
  #expect(lifecycle.aggregatePhase == .active)
  let lastInactive = lifecycle.update(sceneID: secondSceneID, phase: .inactive)
  #expect(lastInactive?.previous == .active)
  #expect(lastInactive?.current == .inactive)

  let allBackground = lifecycle.disconnect(sceneID: secondSceneID)
  #expect(allBackground?.previous == .inactive)
  #expect(allBackground?.current == .background)
  #expect(lifecycle.disconnect(sceneID: secondSceneID) == nil)
}

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

@Test func productionMetalScreenshotMatchesTheBundledVisualGolden() async throws {
  let proof = try GhostteaMetalProof.run(frame: await productionFrame())
  let golden = try GhostteaVisualGolden.bundled()
  let difference = GhostteaVisualGolden.evaluate(proof.visualFingerprint, against: golden)

  #expect(golden.fixture == "phase4-styled-unicode-v1")
  #expect(golden.referencePixelHash == String(format: "%016llx", proof.pixelHash))
  #expect(difference.dimensionsMatch)
  #expect(difference.edgeHammingDistance == 0)
  #expect(difference.maxMeanChannelDelta == 0)
  #expect(difference.nonBackgroundPixelDelta == 0)
  #expect(difference.passed)

  var erasedPixels = [UInt8](
    repeating: 0, count: proof.renderedWidth * proof.renderedHeight * 4)
  for offset in stride(from: 0, to: erasedPixels.count, by: 4) {
    erasedPixels[offset] = 40
    erasedPixels[offset + 1] = 44
    erasedPixels[offset + 2] = 52
    erasedPixels[offset + 3] = 255
  }
  let erased = GhostteaVisualFingerprint(
    pixels: erasedPixels,
    width: proof.renderedWidth,
    height: proof.renderedHeight,
    nonBackgroundPixelCount: 0
  )
  let erasedDifference = GhostteaVisualGolden.evaluate(erased, against: golden)
  #expect(!erasedDifference.passed)
  #expect(
    erasedDifference.nonBackgroundPixelDelta > golden.tolerance.maxNonBackgroundPixelDelta)
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
