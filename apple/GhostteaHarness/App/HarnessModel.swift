import Darwin
import Foundation
import GhostteaCore
import GhostteaCredentials
import GhostteaFontProof
import GhostteaSSH
import GhostteaSession
import GhostteaTerminal
import GhostteaTransport
import UIKit

@MainActor
final class HarnessModel: ObservableObject {
  private enum SSHCancellationReason {
    case user
    case networkChange
    case background
  }

  private enum LifecycleProbe {
    case none
    case routeAwaitingConnection
    case routeAwaitingTransition
    case freshReconnect
    case backgroundAwaitingConnection
    case backgroundAwaitingReturn
  }

  enum SSHCommandPreset {
    case defaultOutput
    case exitStreams
    case signalTermination
  }

  enum SSHProbeAuthentication: String, CaseIterable, Identifiable {
    case password = "Password"
    case privateKey = "Private key"
    case keyboardInteractive = "Keyboard"

    var id: Self { self }
  }

  enum SSHProbeSession: String, CaseIterable, Identifiable {
    case command = "Command"
    case ptyResize = "PTY resize"
    case halfClose = "Half-close"

    var id: Self { self }
  }

  enum ProductionSSHProfile: String, CaseIterable, Identifiable {
    case shell = "Automatic shell gate"
    case tmux = "tmux"
    case vim = "Vim"
    case zellij = "Zellij"
    case monitorTuis = "htop + btop"
    case claude = "Claude Code"

    var id: Self { self }

    func attachProfile(sessionName: String) -> GhostteaSSHAttachProfile {
      switch self {
      case .shell, .monitorTuis, .claude: .shell
      case .tmux: .tmux(sessionName: sessionName)
      case .vim: .shell
      case .zellij: .zellij(sessionName: sessionName)
      }
    }
  }

  struct PendingHostKey: Identifiable {
    let id = UUID()
    let challenge: SSHCandidateHostKeyChallenge
  }

  struct PendingKeyboardChallenge: Identifiable {
    let id = UUID()
    let challenge: SSHKeyboardInteractiveChallenge
  }

  @Published var vtResult = "Not run"
  @Published var fontParityResult = "Not run"
  @Published var coreResult = "Not run"
  @Published var frameDecoderResult = "Not run"
  @Published var framePreview: Data?
  @Published var productionSessionFrame: Data?
  @Published var productionSessionStatus = "Not run"
  @Published var productionSessionInputStatus = "Connect to enable input"
  @Published var productionSSHProfile = ProductionSSHProfile.shell
  @Published var productionProfileName = "ghosttea"
  @Published var terminalInputResult = "Run the TRF1 fixture to enable the input probe"
  @Published var keychainResult = "Not run"
  @Published var networkPathSummary = "Starting monitor…"
  @Published var reconnectStateSummary = "Idle"
  @Published var lifecycleProbeResult = "Not run"
  @Published var memoryResults: [HarnessMemoryResult] = []
  @Published var memoryStatus = "Not run"
  @Published var wholeAppMemoryResult: HarnessWholeAppMemoryResult?
  @Published var wholeAppMemoryStatus = "Not run"
  @Published var activeSSHMemoryResult: HarnessActiveSSHMemoryResult?
  @Published var activeSSHMemoryStatus = "Not run"
  @Published var host = "10.0.0.103"
  @Published var port = "22022"
  @Published var username = "ghosttea"
  @Published var sshAuthentication = SSHProbeAuthentication.password
  @Published var sshSession = SSHProbeSession.command
  @Published var password = "ghosttea-password"
  @Published var privateKey = ""
  @Published var privateKeyPassphrase = ""
  @Published var command = "printf 'ghosttea-device-ok\\n'; uname -a"
  @Published var sshStatus = "Not connected"
  @Published var sshOutput = ""
  @Published var sshStandardError = ""
  @Published var pendingHostKey: PendingHostKey?
  @Published var pendingKeyboardChallenge: PendingKeyboardChallenge?
  @Published private var isBridgingSSHInteraction = false
  @Published var isRunningMemory = false
  @Published var isRunningFontParity = false
  @Published var isRunningCore = false
  @Published var isRunningFrameDecoder = false
  @Published var isRunningWholeAppMemory = false
  @Published var isRunningActiveSSHMemory = false
  @Published var isRunningKeychain = false
  @Published var isRunningSSH = false
  @Published var isRunningProductionSession = false

  private var hostKeyContinuation: CheckedContinuation<SSHCandidateHostKeyDecision, Never>?
  private var keyboardChallengeContinuation: CheckedContinuation<[String], Error>?
  private var sshTask: Task<Void, Never>?
  private var productionSession: GhostteaSession?
  private var productionTerminal: GhostteaTerminal?
  private var productionCredentialStore: KeychainSSHCredentialStore?
  private var productionCredential: SSHCredentialID?
  private var productionShellCommandSent = false
  private var productionTmuxResizeSent = false
  private var productionTmuxInitialSizeObserved = false
  private var productionTmuxResizedSizeObserved = false
  private var productionTmuxExitSent = false
  private var productionVimNoEchoObserved = false
  private var productionVimLaunchSent = false
  private var productionVimBufferObserved = false
  private var productionVimInitialProbeSent = false
  private var productionVimInitialSizeObserved = false
  private var productionVimResizeSent = false
  private var productionVimResizedProbeSent = false
  private var productionVimResizedSizeObserved = false
  private var productionVimEditSent = false
  private var productionVimEditObserved = false
  private var productionVimExitSent = false
  private var productionZellijNoEchoObserved = false
  private var productionZellijProbeSent = false
  private var productionZellijInitialSizeObserved = false
  private var productionZellijResizeSent = false
  private var productionZellijResizedSizeObserved = false
  private var productionZellijInputSent = false
  private var productionZellijInputObserved = false
  private var productionZellijExitSent = false
  private var productionMonitorNoEchoObserved = false
  private var productionHtopLaunchSent = false
  private var productionHtopMainObserved = false
  private var productionHtopHelpSent = false
  private var productionHtopHelpObserved = false
  private var productionHtopResizeSent = false
  private var productionHtopExitSent = false
  private var productionHtopExitObserved = false
  private var productionBtopMainObserved = false
  private var productionBtopMenuSent = false
  private var productionBtopMenuObserved = false
  private var productionBtopResizeSent = false
  private var productionBtopExitSent = false
  private var productionBtopExitObserved = false
  private var productionClaudeNoEchoObserved = false
  private var productionClaudeLaunchSent = false
  private var productionClaudeMainObserved = false
  private var productionClaudePromptSent = false
  private var productionClaudeResponseObserved = false
  private var productionClaudeInterruptPromptSent = false
  private var productionClaudeInterruptActiveObserved = false
  private var productionClaudeInterruptSent = false
  private var productionClaudeInterruptedObserved = false
  private var productionClaudeShortcutsSent = false
  private var productionClaudeShortcutsObserved = false
  private var productionClaudeResizeSent = false
  private var productionClaudeExitSent = false
  private var productionClaudeExitObserved = false
  private let productionSessionAutomation =
    ProcessInfo.processInfo.environment["GHOSTTEA_AUTORUN_PRODUCTION_SESSION"] == "1"
  private var didAutorunProductionSession = false
  private var sshCancellationRequestedAt: ContinuousClock.Instant?
  private var sshCancellationReason: SSHCancellationReason?
  private var sshGeneration: UInt64?
  private var reconnectModel = TerminalReconnectModel()
  private var networkPathTask: Task<Void, Never>?
  private var terminalInputEncoder: GhostteaTerminalInputEncoder?
  private var lifecycleProbe = LifecycleProbe.none
  private var backgroundCancellationMilliseconds: Int64?
  private var disposableFixtureHost = "10.0.0.103"

  init() {
    if let configuredHost = ProcessInfo.processInfo.environment["GHOSTTEA_FIXTURE_HOST"],
      !configuredHost.isEmpty
    {
      disposableFixtureHost = configuredHost
      host = configuredHost
    }
    let updates = AppleTerminalNetworkPathMonitor().updates()
    networkPathTask = Task { [weak self] in
      for await path in updates {
        guard let self else { return }
        self.handleNetworkPathChange(path)
      }
    }
    if ProcessInfo.processInfo.environment["GHOSTTEA_AUTORUN_MEMORY_GATE"] == "1" {
      Task { [weak self] in
        await Task.yield()
        self?.runWholeAppMemoryGate()
      }
    }
    Task { [weak self] in
      await Task.yield()
      self?.runFontParityProof()
    }
    Task { [weak self] in
      await Task.yield()
      self?.runCoreProof()
    }
    Task { [weak self] in
      await Task.yield()
      self?.runFrameDecoderProof()
    }
  }

  deinit {
    networkPathTask?.cancel()
  }

  var isPresentingSSHInteraction: Bool {
    pendingHostKey != nil || pendingKeyboardChallenge != nil || isBridgingSSHInteraction
  }

  var deviceSummary: String {
    let device = UIDevice.current
    return
      "\(device.model) · iOS \(device.systemVersion) · \(ProcessInfo.processInfo.physicalMemory / 1_048_576) MiB RAM"
  }

  func runVTProof() {
    do {
      vtResult = try HarnessDiagnostics.runVTProof()
    } catch {
      vtResult = "Failed: \(error)"
    }
  }

  func runFontParityProof() {
    guard !isRunningFontParity else { return }
    isRunningFontParity = true
    fontParityResult = "Running bundled-font parity fixture…"
    Task {
      do {
        let result = try await Task.detached(priority: .userInitiated) {
          try GhostteaFontProof.run()
        }.value
        fontParityResult =
          result.passed
          ? "Passed · runtime output matches desktop golden"
          : "Failed · runtime output differs from desktop golden"
        print(result.passed ? "GHOSTTEA_FONT_PARITY_PASS" : "GHOSTTEA_FONT_PARITY_FAIL")
        finishFontParityAutomation(exitCode: result.passed ? 0 : 1)
      } catch {
        fontParityResult = "Failed: \(error)"
        print("GHOSTTEA_FONT_PARITY_ERROR \(error)")
        finishFontParityAutomation(exitCode: 2)
      }
      isRunningFontParity = false
    }
  }

  private func finishFontParityAutomation(exitCode: Int32) {
    guard ProcessInfo.processInfo.environment["GHOSTTEA_FONT_PARITY_AUTOMATION"] == "1" else {
      return
    }
    fflush(nil)
    Darwin.exit(exitCode)
  }

  func runCoreProof() {
    guard !isRunningCore else { return }
    isRunningCore = true
    coreResult = "Running production C ABI fixture…"
    Task {
      do {
        let runtime = try GhostteaRuntime()
        let terminal = try GhostteaTerminal(
          runtime: runtime,
          configuration: .init(sessionHandle: 42)
        )
        let update = try await terminal.feed(
          Data("phase3-device\r\n\u{1B}]0;core-title\u{07}\u{1B}[6n".utf8),
          render: .full
        )
        let kinds = update.effects.map(\.kind)
        guard update.effects.map(\.sequence) == Array(0..<UInt32(update.effects.count)),
          kinds.first == .writeToTransport,
          kinds.contains(.frameReady),
          kinds.contains(.logicalSnapshotJSON),
          !(await terminal.isPoisoned),
          !runtime.isPoisoned
        else {
          throw HarnessError.coreParityMismatch
        }
        let accessibility = try await terminal.accessibilityRows(start: 0, count: 2)
        guard String(decoding: accessibility, as: UTF8.self).contains("phase3-device") else {
          throw HarnessError.coreParityMismatch
        }
        coreResult = "Passed · ordered production ABI effects and TRF1"
        print("GHOSTTEA_CORE_PASS")
        finishCoreAutomation(exitCode: 0)
      } catch {
        coreResult = "Failed: \(error)"
        print("GHOSTTEA_CORE_ERROR \(error)")
        finishCoreAutomation(exitCode: 2)
      }
      isRunningCore = false
    }
  }

  private func finishCoreAutomation(exitCode: Int32) {
    guard ProcessInfo.processInfo.environment["GHOSTTEA_CORE_AUTOMATION"] == "1" else {
      return
    }
    fflush(nil)
    Darwin.exit(exitCode)
  }

  func runFrameDecoderProof() {
    guard !isRunningFrameDecoder else { return }
    isRunningFrameDecoder = true
    frameDecoderResult = "Running strict TRF1 decoder fixture…"
    Task {
      do {
        let runtime = try GhostteaRuntime()
        let terminal = try GhostteaTerminal(
          runtime: runtime,
          configuration: .init(sessionHandle: 74, columns: 100, rows: 30)
        )
        let fullUpdate = try await terminal.feed(
          Data("Metal proof ✓ 界 \u{1b}[31;44;4;9mstyled\u{1b}[0m 🙂\r\n".utf8),
          render: .full
        )
        let incrementalUpdate = try await terminal.feed(
          Data("retained-state\r\n".utf8), render: .damage)
        guard
          let frame = fullUpdate.effects.first(where: { $0.kind == .frameReady })?.payload,
          let incremental = incrementalUpdate.effects.first(where: { $0.kind == .frameReady })?
            .payload
        else {
          throw HarnessError.frameDecoderMismatch
        }
        let summary = try GhostteaTerminalFrameDecoder.inspect(frame)
        let retained = try GhostteaTerminalFrameDecoder.retain([frame, incremental, incremental])
        let metal = try GhostteaMetalProof.run(frame: frame)
        let visualDifference = try GhostteaVisualGolden.evaluate(metal.visualFingerprint)
        let surface = try GhostteaTerminalMetalView(terminalFrame: .zero)
        surface.accessibilityTerminalTitle = "Ghosttea preview"
        surface.accessibilityConnectionState = "Connected"
        surface.terminalAccessibilitySelectionText = "proof selection"
        surface.onAccessibilityReconnect = {}
        var gridChanges: [GhostteaTerminalGridSize] = []
        surface.onGridSizeChange = { gridChanges.append($0) }
        surface.terminalContentInsets = UIEdgeInsets(top: 59, left: 0, bottom: 34, right: 0)
        surface.frame = CGRect(x: 0, y: 0, width: 390, height: 844)
        surface.layoutIfNeeded()
        let portraitGridSize = surface.currentGridSize
        surface.terminalContentInsets = UIEdgeInsets(top: 0, left: 59, bottom: 21, right: 59)
        surface.frame = CGRect(x: 0, y: 0, width: 844, height: 390)
        surface.layoutIfNeeded()
        let landscapeGridSize = surface.currentGridSize
        let surfaceAcceptedFull = try surface.apply(frame: frame)
        let surfaceAcceptedIncremental = try surface.apply(frame: incremental)
        let surfaceAcceptedStale = try surface.apply(frame: incremental)
        let accessibilitySnapshot = surface.accessibilitySnapshot
        let accessibilityElements = surface.accessibilityElements as? [UIAccessibilityElement]
        var accessibilityScrollRows: [Int] = []
        surface.onScrollRows = { accessibilityScrollRows.append($0) }
        let accessibilityScrolled = surface.accessibilityScroll(.up)
        let pointerCell = surface.viewportCell(
          at: CGPoint(
            x: 61 + CGFloat(GhostteaTerminalLayout.cellWidth) * 2 + 1,
            y: 2 + CGFloat(GhostteaTerminalLayout.lineHeight) * 3 + 1
          )
        )
        let pointerEvent = surface.terminalMouseEvent(
          action: .press,
          button: .left,
          at: CGPoint(x: 16, y: 22)
        )
        var selectionChanges: [GhostteaTerminalSelection?] = []
        var selectAllCount = 0
        surface.onSelectionChange = { selectionChanges.append($0) }
        surface.onSelectAll = { selectAllCount += 1 }
        let probeSelection = GhostteaTerminalSelection(
          anchor: GhostteaTerminalCellPoint(column: 1, row: 0),
          focus: GhostteaTerminalCellPoint(column: 8, row: 1)
        )
        surface.setSelection(probeSelection)
        let retainedSelection = surface.selection
        surface.clearSelection()
        surface.selectAllTerminal()
        let retainedSelectAll = surface.selection
        surface.clearSelection()
        let recognizers = surface.gestureRecognizers ?? []
        var softwareInputEvents: [GhostteaSoftwareInputEvent] = []
        var markedTextStates: [GhostteaMarkedTextState?] = []
        surface.onSoftwareInputEvent = { softwareInputEvents.append($0) }
        surface.onMarkedTextChange = { markedTextStates.append($0) }
        surface.setMarkedText("にほん", selectedRange: NSRange(location: 3, length: 0))
        let markedRange = surface.markedTextRange
        let markedText = markedRange.flatMap { surface.text(in: $0) }
        let compositionCaret = surface.caretRect(for: surface.endOfDocument)
        surface.unmarkText()
        surface.insertText("界\n")
        surface.deleteBackward()
        surface.activateAccessoryKey(.control)
        surface.insertText("c")
        surface.activateAccessoryKey(.option)
        surface.activateAccessoryKey(.arrowLeft)
        let accessoryEventsValid = {
          guard softwareInputEvents.count == 6,
            case .key(let controlC) = softwareInputEvents[4],
            case .key(let optionLeft) = softwareInputEvents[5]
          else { return false }
          return controlC.code == "KeyC" && controlC.modifiers == [.control]
            && optionLeft.code == "ArrowLeft" && optionLeft.modifiers == [.option]
        }()
        try surface.prepareGPUResources()
        let surfaceResidentBeforeSuspend = surface.diagnostics.residentAtlasBytes
        surface.suspendGPU()
        let surfaceResidentWhileSuspended = surface.diagnostics.residentAtlasBytes
        surface.resumeGPU()
        try surface.prepareGPUResources()
        guard summary.sessionHandle == 74,
          summary.columns == 100,
          summary.rows == 30,
          summary.sectionCount >= 6,
          summary.glyphDefinitionCount > 0,
          summary.styleDefinitionCount > 0,
          summary.rowReplacementCount == 30,
          summary.accessibilityRows.contains(where: { $0.contains("Metal proof ✓ 界") }),
          summary.cursorRow == 1,
          summary.scrollbarLength == 30,
          retained.appliedFrameCount == 2,
          retained.staleFrameCount == 1,
          retained.refreshRequestCount == 0,
          !retained.awaitingResync,
          retained.rows.contains(where: { $0.contains("Metal proof ✓ 界") }),
          retained.rows.contains(where: { $0.contains("retained-state") }),
          !metal.deviceName.isEmpty,
          metal.uploadedBytes > 0,
          metal.cachedUploadBytes == 0,
          metal.alphaGlyphCount > 0,
          metal.colorGlyphCount > 0,
          metal.residentAtlasBytes == 20 * 1024 * 1024,
          metal.renderedWidth == 787,
          metal.renderedHeight == 574,
          metal.rectangleVertexCount > 0,
          metal.alphaGlyphVertexCount > 0,
          metal.colorGlyphVertexCount > 0,
          metal.nonBackgroundPixelCount > 0,
          metal.pixelHash != 0,
          visualDifference.passed,
          surfaceAcceptedFull,
          surfaceAcceptedIncremental,
          !surfaceAcceptedStale,
          surface.diagnostics.acceptedFrames == 2,
          surface.diagnostics.staleFrames == 1,
          accessibilitySnapshot.rows.contains(where: { $0.text.contains("Metal proof ✓ 界") }),
          accessibilitySnapshot.rows.contains(where: { $0.text.contains("retained-state") }),
          accessibilitySnapshot.visibleRangeDescription == "Rows 1 through 30 of 30",
          accessibilityElements?.count == 31,
          accessibilityElements?.first?.accessibilityIdentifier == "ghosttea.terminal.summary",
          accessibilityElements?.first?.accessibilityLabel == "Ghosttea preview",
          accessibilityElements?.first?.accessibilityValue
            == "Connected. Rows 1 through 30 of 30. Selected text: proof selection",
          accessibilityElements?.first?.accessibilityCustomActions?.map(\.name)
            == ["Focus Terminal", "Reconnect"],
          accessibilityElements?[1].accessibilityIdentifier == "ghosttea.terminal.row.0",
          accessibilityElements?[1].accessibilityCustomActions?.map(\.name)
            == ["Copy", "Select All", "Paste"],
          accessibilityScrolled,
          accessibilityScrollRows == [19],
          surfaceResidentBeforeSuspend == 20 * 1024 * 1024,
          surfaceResidentWhileSuspended == 0,
          surface.diagnostics.resourceEvictions == 1,
          surface.diagnostics.resourceRebuilds == 2,
          surface.diagnostics.residentAtlasBytes == 20 * 1024 * 1024,
          markedText == "にほん",
          markedTextStates.contains(
            GhostteaMarkedTextState(text: "にほん", selectionLocation: 3, selectionLength: 0)
          ),
          markedTextStates.last.map({ $0 == nil }) == true,
          softwareInputEvents
            .prefix(4) == [.text("にほん"), .text("界"), .enter, .deleteBackward],
          accessoryEventsValid,
          surface.latchedAccessoryModifiers.isEmpty,
          surface.inputAccessoryView != nil,
          surface.terminalAccessoryKeys == GhostteaAccessoryKey.terminalDefaults,
          surface.pointerOwner() == .localSelection,
          !surface.terminalMouseTrackingEnabled,
          pointerCell == GhostteaViewportCellPoint(column: 2, row: 3),
          pointerEvent.screenWidth == 844,
          pointerEvent.screenHeight == 390,
          pointerEvent.cellWidth == 8,
          pointerEvent.cellHeight == 19,
          pointerEvent.paddingLeft == 61,
          pointerEvent.paddingTop == 2,
          retainedSelection == probeSelection,
          selectionChanges.count == 4,
          selectionChanges.last.map({ $0 == nil }) == true,
          selectAllCount == 1,
          retainedSelectAll?.anchor == GhostteaTerminalCellPoint(column: 0, row: 0),
          recognizers.contains(where: { $0 is UIPanGestureRecognizer }),
          recognizers.contains(where: { $0 is UILongPressGestureRecognizer }),
          recognizers.contains(where: { $0 is UIHoverGestureRecognizer }),
          compositionCaret.width > 0,
          compositionCaret.height == CGFloat(GhostteaTerminalLayout.lineHeight),
          compositionCaret.origin.x.isFinite,
          compositionCaret.origin.y.isFinite,
          surface.autocapitalizationType == .none,
          surface.autocorrectionType == .no,
          portraitGridSize == GhostteaTerminalGridSize(columns: 49, rows: 39),
          landscapeGridSize == GhostteaTerminalGridSize(columns: 92, rows: 19),
          gridChanges.contains(GhostteaTerminalGridSize(columns: 49, rows: 39)),
          gridChanges.last == GhostteaTerminalGridSize(columns: 92, rows: 19),
          surface.canBecomeFirstResponder,
          surface.focusesInputOnTap,
          surface.isPaused,
          surface.enableSetNeedsDisplay
        else {
          throw HarnessError.frameDecoderMismatch
        }
        let atlasMiB = metal.residentAtlasBytes / 1_048_576
        framePreview = frame
        terminalInputEncoder = GhostteaTerminalInputEncoder(terminal: terminal)
        terminalInputResult = "Ready · tap the preview to type"
        frameDecoderResult =
          "Passed · TRF1 offscreen Metal render (\(metal.deviceName), \(atlasMiB) MiB atlases)"
        print(
          "GHOSTTEA_VISUAL_PASS hash=\(String(format: "%016llx", metal.pixelHash)) "
            + "edges=\(visualDifference.edgeHammingDistance) "
            + "channels=\(visualDifference.maxMeanChannelDelta) "
            + "content=\(visualDifference.nonBackgroundPixelDelta)"
        )
        print("GHOSTTEA_TRF1_PASS")
        finishFrameDecoderAutomation(exitCode: 0)
      } catch {
        frameDecoderResult = "Failed: \(error)"
        print("GHOSTTEA_TRF1_ERROR \(error)")
        finishFrameDecoderAutomation(exitCode: 2)
      }
      isRunningFrameDecoder = false
    }
  }

  private func finishFrameDecoderAutomation(exitCode: Int32) {
    guard ProcessInfo.processInfo.environment["GHOSTTEA_TRF1_AUTOMATION"] == "1" else {
      return
    }
    fflush(nil)
    Darwin.exit(exitCode)
  }

  func handleHardwareInput(_ event: GhostteaHardwareKeyEvent) -> Bool {
    guard let terminalInputEncoder else { return false }
    Task {
      do {
        let encoding = try await terminalInputEncoder.encode(event)
        try await recordInputEncoding(encoding, encoder: terminalInputEncoder)
      } catch {
        terminalInputResult = "Hardware input failed: \(error)"
      }
    }
    return true
  }

  func handleSoftwareInput(_ event: GhostteaSoftwareInputEvent) {
    guard let terminalInputEncoder else { return }
    Task {
      do {
        let encoding = try await terminalInputEncoder.encode(event)
        try await recordInputEncoding(encoding, encoder: terminalInputEncoder)
      } catch {
        terminalInputResult = "Software input failed: \(error)"
      }
    }
  }

  func handleMouseInput(_ event: GhostteaTerminalMouseEvent) {
    guard let terminalInputEncoder else { return }
    Task {
      do {
        let encoding = try await terminalInputEncoder.encode(event)
        try await recordInputEncoding(encoding, encoder: terminalInputEncoder)
      } catch {
        terminalInputResult = "Mouse input failed: \(error)"
      }
    }
  }

  func handleScrollRows(_ rows: Int) {
    guard let terminalInputEncoder, rows != 0 else { return }
    Task {
      do {
        let update = try await terminalInputEncoder.terminal.scroll(
          rows: Int64(rows),
          render: .damage
        )
        if let frame = update.effects.last(where: { $0.kind == .frameReady })?.payload {
          framePreview = frame
        }
        terminalInputResult = "Scrolled \(rows) rows"
      } catch {
        terminalInputResult = "Scroll failed: \(error)"
      }
    }
  }

  func handleSelectionCommit(_ selection: GhostteaTerminalSelection) {
    guard let terminalInputEncoder else { return }
    Task {
      do {
        let text = try await terminalInputEncoder.terminal.selectionText(
          startColumn: selection.anchor.column,
          startRow: selection.anchor.row,
          endColumn: selection.focus.column,
          endRow: selection.focus.row
        )
        UIPasteboard.general.string = text
        terminalInputResult = "Copied \(text.utf8.count) UTF-8 bytes · \(text.prefix(32))"
      } catch {
        terminalInputResult = "Selection extraction failed: \(error)"
      }
    }
  }

  func handleSelectAll() {
    guard let terminalInputEncoder else { return }
    Task {
      do {
        let text = try await terminalInputEncoder.terminal.selectionText(
          startColumn: 0,
          startRow: 0,
          endColumn: 0,
          endRow: 0,
          selectAll: true
        )
        UIPasteboard.general.string = text
        terminalInputResult = "Copied all · \(text.utf8.count) UTF-8 bytes"
      } catch {
        terminalInputResult = "Select All extraction failed: \(error)"
      }
    }
  }

  private func recordInputEncoding(
    _ pending: GhostteaInputEncoding,
    encoder: GhostteaTerminalInputEncoder
  ) async throws {
    var encoding = pending
    if case .pasteFromClipboard = encoding {
      encoding = try await encoder.encode(.paste(UIPasteboard.general.string ?? ""))
    }
    switch encoding {
    case .bytes(let bytes):
      let prefix = bytes.prefix(32).map { String(format: "%02x", $0) }.joined(separator: " ")
      terminalInputResult = "Encoded \(bytes.count) bytes · \(prefix)"
    case .pasteFromClipboard:
      terminalInputResult = "Paste requested"
    case .applicationShortcut(let shortcut):
      terminalInputResult = "Application shortcut · \(String(describing: shortcut))"
    case .ignored:
      terminalInputResult = "Ignored paired input event"
    }
  }

  func runKeychainProof() {
    guard !isRunningKeychain else { return }
    isRunningKeychain = true
    keychainResult = "Running save/load/delete proof…"
    Task {
      let credential = SSHCredentialID(connectionID: UUID(), kind: .password)
      do {
        let store = try KeychainSSHCredentialStore()
        let expected = Data(UUID().uuidString.utf8)
        try await store.store(expected, for: credential)
        guard try await store.load(credential) == expected else {
          throw HarnessError.keychainRoundTripMismatch
        }
        try await store.remove(credential)
        guard try await store.load(credential) == nil else {
          throw HarnessError.keychainRemovalFailed
        }
        keychainResult = "Passed · device-only, non-synchronizing item removed"
      } catch {
        if let store = try? KeychainSSHCredentialStore() {
          try? await store.remove(credential)
        }
        keychainResult = "Failed: \(error)"
      }
      isRunningKeychain = false
    }
  }

  func runMemoryMatrix() {
    guard !isRunningMemory else { return }
    isRunningMemory = true
    memoryStatus = "Running deterministic 1/4/8-session matrix…"
    Task {
      do {
        let results = try await Task.detached(priority: .userInitiated) {
          try HarnessDiagnostics.runMemoryMatrix()
        }.value
        memoryResults = results
        memoryStatus = "Complete"
      } catch {
        memoryStatus = "Failed: \(error)"
      }
      isRunningMemory = false
    }
  }

  func runWholeAppMemoryGate() {
    guard !isRunningWholeAppMemory else { return }
    isRunningWholeAppMemory = true
    wholeAppMemoryStatus = "Running foreground/background process gate…"
    wholeAppMemoryResult = nil
    let physicalMemory = ProcessInfo.processInfo.physicalMemory
    Task {
      do {
        let result = try await Task.detached(priority: .userInitiated) {
          try HarnessDiagnostics.runWholeAppMemoryGate(
            physicalMemoryBytes: physicalMemory
          )
        }.value
        wholeAppMemoryResult = result
        wholeAppMemoryStatus = result.passed ? "Passed" : "Failed"
      } catch {
        wholeAppMemoryStatus = "Failed: \(error)"
      }
      isRunningWholeAppMemory = false
      if ProcessInfo.processInfo.environment["GHOSTTEA_AUTORUN_ACTIVE_SSH_MEMORY_GATE"] == "1" {
        runActiveSSHMemoryGate()
      }
    }
  }

  func runActiveSSHMemoryGate() {
    guard !isRunningActiveSSHMemory, !isRunningSSH else { return }
    let fixtureHost = disposableFixtureHost
    let physicalMemory = ProcessInfo.processInfo.physicalMemory
    let knownHosts: String
    do {
      knownHosts = try knownHostsPath()
    } catch {
      activeSSHMemoryStatus = "Failed: \(error)"
      return
    }
    isRunningActiveSSHMemory = true
    activeSSHMemoryResult = nil
    activeSSHMemoryStatus = "Connecting, pausing demand, then draining 32 MiB…"
    Task {
      do {
        let result = try await HarnessDiagnostics.runActiveSSHMemoryGate(
          host: fixtureHost,
          port: 22_022,
          username: "ghosttea",
          password: Data("ghosttea-password".utf8),
          knownHostsPath: knownHosts,
          physicalMemoryBytes: physicalMemory
        )
        activeSSHMemoryResult = result
        activeSSHMemoryStatus = result.passed ? "Passed" : "Failed"
      } catch {
        activeSSHMemoryStatus = "Failed: \(error)"
      }
      isRunningActiveSSHMemory = false
    }
  }

  func runProductionSessionGate() {
    guard !isRunningProductionSession, !isRunningSSH else { return }
    guard reconnectModel.path.canAttemptConnection else {
      productionSessionStatus = "Waiting for a satisfied network path"
      return
    }

    isRunningProductionSession = true
    productionSessionStatus = "Preparing protected credentials and known hosts…"
    productionSessionInputStatus = "Connecting…"
    productionSessionFrame = nil
    productionShellCommandSent = false
    productionTmuxResizeSent = false
    productionTmuxInitialSizeObserved = false
    productionTmuxResizedSizeObserved = false
    productionTmuxExitSent = false
    productionVimNoEchoObserved = false
    productionVimLaunchSent = false
    productionVimBufferObserved = false
    productionVimInitialProbeSent = false
    productionVimInitialSizeObserved = false
    productionVimResizeSent = false
    productionVimResizedProbeSent = false
    productionVimResizedSizeObserved = false
    productionVimEditSent = false
    productionVimEditObserved = false
    productionVimExitSent = false
    productionZellijNoEchoObserved = false
    productionZellijProbeSent = false
    productionZellijInitialSizeObserved = false
    productionZellijResizeSent = false
    productionZellijResizedSizeObserved = false
    productionZellijInputSent = false
    productionZellijInputObserved = false
    productionZellijExitSent = false
    productionMonitorNoEchoObserved = false
    productionHtopLaunchSent = false
    productionHtopMainObserved = false
    productionHtopHelpSent = false
    productionHtopHelpObserved = false
    productionHtopResizeSent = false
    productionHtopExitSent = false
    productionHtopExitObserved = false
    productionBtopMainObserved = false
    productionBtopMenuSent = false
    productionBtopMenuObserved = false
    productionBtopResizeSent = false
    productionBtopExitSent = false
    productionBtopExitObserved = false
    productionClaudeNoEchoObserved = false
    productionClaudeLaunchSent = false
    productionClaudeMainObserved = false
    productionClaudePromptSent = false
    productionClaudeResponseObserved = false
    productionClaudeInterruptPromptSent = false
    productionClaudeInterruptActiveObserved = false
    productionClaudeInterruptSent = false
    productionClaudeInterruptedObserved = false
    productionClaudeShortcutsSent = false
    productionClaudeShortcutsObserved = false
    productionClaudeResizeSent = false
    productionClaudeExitSent = false
    productionClaudeExitObserved = false

    Task {
      do {
        let store = try KeychainSSHCredentialStore()
        let credential = SSHCredentialID(connectionID: UUID(), kind: .password)
        try await store.store(Data("ghosttea-password".utf8), for: credential)
        let knownHosts = try GhostteaSSHKnownHostsFile(
          applicationDirectoryName: "GhostteaHarness"
        ).prepare()
        let runtime = try GhostteaRuntime()
        let terminal = try GhostteaTerminal(
          runtime: runtime,
          configuration: .init(sessionHandle: 606, columns: 100, rows: 30)
        )
        let profile = productionSSHProfile.attachProfile(sessionName: productionProfileName)
        let fixtureHost = disposableFixtureHost
        let automateTrust = productionSessionAutomation
        let ssh = try GhostteaSSHConfiguration(
          host: fixtureHost,
          port: 22_022,
          knownHostsPath: knownHosts,
          hostKeyPolicy: .ask { [weak self] challenge in
            guard let self else { return .reject }
            if automateTrust, challenge.host == fixtureHost {
              return .acceptAndStore
            }
            return await self.requestHostKeyDecision(challenge)
          },
          authentication: .password(
            username: "ghosttea",
            credential: credential,
            store: store
          ),
          profile: profile,
          columns: 100,
          rows: 30,
          connectTimeoutMilliseconds: 15_000,
          handshakeTimeoutMilliseconds: 15_000
        )
        let session = GhostteaSSHSessionFactory.make(
          terminal: terminal,
          ssh: ssh,
          session: .ssh(initialPath: reconnectModel.path),
          eventHandler: { [weak self] event in
            await self?.handleProductionSessionEvent(event)
          }
        )
        productionTerminal = terminal
        productionCredentialStore = store
        productionCredential = credential
        productionSession = session
        productionSessionStatus = "Connecting through production session…"
        await session.requestConnect()
      } catch {
        productionSessionStatus = "Failed: \(GhostteaSSHFailurePolicy.description(error))"
        productionSessionInputStatus = "Unavailable"
        isRunningProductionSession = false
        finishProductionSessionAutomation(exitCode: 2)
        cleanupProductionCredential()
      }
    }
  }

  func cancelProductionSession() {
    guard let productionSession else { return }
    productionSessionStatus = "Disconnecting…"
    Task {
      await productionSession.disconnect()
      cleanupProductionCredential()
      isRunningProductionSession = false
    }
  }

  func handleProductionHardwareInput(_ event: GhostteaHardwareKeyEvent) -> Bool {
    guard let productionSession, isRunningProductionSession else { return false }
    guard !event.modifiers.contains(.command) else { return false }
    Task {
      do {
        try await productionSession.sendKey(event.coreEvent)
        productionSessionInputStatus = "Hardware key sent"
      } catch {
        productionSessionInputStatus = "Input failed: \(error)"
      }
    }
    return true
  }

  func handleProductionSoftwareInput(_ event: GhostteaSoftwareInputEvent) {
    guard let productionSession, isRunningProductionSession else { return }
    Task {
      do {
        switch event {
        case .text(let text):
          try await productionSession.send(Data(text.utf8))
        case .enter:
          try await productionSession.sendKey(try softwareKey(hidUsage: 0x28))
        case .deleteBackward:
          try await productionSession.sendKey(try softwareKey(hidUsage: 0x2a))
        case .paste(let text):
          try await productionSession.sendPaste(text)
        case .key(let key):
          try await productionSession.sendKey(key.coreEvent)
        }
        productionSessionInputStatus = "Software input sent"
      } catch {
        productionSessionInputStatus = "Input failed: \(error)"
      }
    }
  }

  func handleProductionMouseInput(_ event: GhostteaTerminalMouseEvent) {
    guard let productionSession, isRunningProductionSession else { return }
    Task {
      do {
        try await productionSession.sendMouse(event.coreEvent)
      } catch {
        productionSessionInputStatus = "Mouse input failed: \(error)"
      }
    }
  }

  func handleProductionScrollRows(_ rows: Int) {
    guard let productionSession, rows != 0 else { return }
    Task {
      do {
        try await productionSession.scroll(rows: Int64(rows))
      } catch {
        productionSessionInputStatus = "Scroll failed: \(error)"
      }
    }
  }

  func handleProductionSelectionCommit(_ selection: GhostteaTerminalSelection) {
    guard let productionTerminal else { return }
    Task {
      do {
        let text = try await productionTerminal.selectionText(
          startColumn: selection.anchor.column,
          startRow: selection.anchor.row,
          endColumn: selection.focus.column,
          endRow: selection.focus.row
        )
        UIPasteboard.general.string = text
        productionSessionInputStatus = "Copied \(text.utf8.count) UTF-8 bytes"
      } catch {
        productionSessionInputStatus = "Selection failed: \(error)"
      }
    }
  }

  func handleProductionSelectAll() {
    guard let productionTerminal else { return }
    Task {
      do {
        let text = try await productionTerminal.selectionText(
          startColumn: 0,
          startRow: 0,
          endColumn: 0,
          endRow: 0,
          selectAll: true
        )
        UIPasteboard.general.string = text
        productionSessionInputStatus = "Copied all · \(text.utf8.count) UTF-8 bytes"
      } catch {
        productionSessionInputStatus = "Select All failed: \(error)"
      }
    }
  }

  private func handleProductionSessionEvent(_ event: GhostteaSessionEvent) async {
    switch event {
    case .stateChanged(let snapshot):
      handleProductionSessionState(snapshot)
    case .frameReady(let frame):
      productionSessionFrame = frame
      await observeAutomatedProductionProfileFrame()
    case .metadataChanged:
      break
    case .bell:
      productionSessionInputStatus = "Bell"
    case .clipboardWrite(let data):
      UIPasteboard.general.string = String(decoding: data, as: UTF8.self)
    case .logicalSnapshot:
      break
    }
  }

  private func handleProductionSessionState(_ snapshot: GhostteaSessionSnapshot) {
    switch snapshot.reconnectState {
    case .idle:
      if let exit = snapshot.lastExitStatus {
        validateCompletedProductionShell(exit: exit)
      } else {
        productionSessionStatus = "Disconnected"
        isRunningProductionSession = false
        cleanupProductionCredential()
      }
    case .waitingForNetwork:
      productionSessionStatus = "Waiting for network"
    case .connecting(let generation):
      productionSessionStatus = "Connecting · generation \(generation)"
    case .connected(let generation):
      productionSessionStatus = "Connected · generation \(generation)"
      productionSessionInputStatus = "Tap the terminal to type"
      if productionSessionAutomation {
        print("GHOSTTEA_PRODUCTION_CONNECTED profile=\(productionSSHProfile)")
      }
      sendAutomaticProductionProfileCommandIfNeeded()
    case .reconnectAvailable:
      productionSessionStatus = "Reconnect available"
      isRunningProductionSession = false
      cleanupProductionCredential()
    case .suspended:
      productionSessionStatus = "Suspended"
    case .failed:
      productionSessionStatus = snapshot.lastFailure?.message ?? "SSH session failed"
      productionSessionInputStatus = "Unavailable"
      isRunningProductionSession = false
      finishProductionSessionAutomation(exitCode: 2)
      cleanupProductionCredential()
    }
  }

  private func sendAutomaticProductionProfileCommandIfNeeded() {
    guard !productionShellCommandSent, let productionSession else { return }
    let command: String
    switch productionSSHProfile {
    case .shell:
      command = "printf '\\033[31mghosttea-production-session-ok\\033[0m\\n'; exit\n"
    case .tmux where productionSessionAutomation:
      // tmux's default status line consumes one row of the allocated PTY.
      command =
        "printf '\\033[32mghosttea-tmux-ready\\033[0m '; stty size; "
        + "while [ \"$(stty size)\" = '29 100' ]; do sleep 1; done; "
        + "printf 'ghosttea-tmux-resized '; stty size; read ghosttea_continue; exit\n"
    case .vim where productionSessionAutomation:
      // Confirm echo is disabled before sending commands containing pass markers.
      command = "stty -echo; printf 'ghosttea-vim-%s\\n' noecho\n"
    case .zellij where productionSessionAutomation:
      // Zellij starts a real shell pane; suppress echo before its marker probe.
      command = "stty -echo; printf 'ghosttea-zellij-%s\\n' noecho\n"
    case .monitorTuis where productionSessionAutomation:
      command = "stty -echo; printf 'ghosttea-monitor-%s\\n' noecho\n"
    case .claude where productionSessionAutomation:
      command = "stty -echo; printf 'ghosttea-claude-%s\\n' noecho\n"
    case .tmux, .vim, .zellij, .monitorTuis, .claude:
      return
    }
    productionShellCommandSent = true
    let waitForZellijPane =
      productionSessionAutomation && productionSSHProfile == .zellij
    Task {
      do {
        // The SSH channel becomes connected before Zellij has created its first
        // shell pane. Input sent during that startup window can be consumed by
        // Zellij instead of the pane, so give the production attach command a
        // bounded startup interval before driving the automated shell probe.
        if waitForZellijPane {
          try await Task.sleep(for: .seconds(2))
        }
        try await productionSession.send(Data(command.utf8))
        if productionSessionAutomation {
          print("GHOSTTEA_PRODUCTION_INITIAL_COMMAND_SENT profile=\(productionSSHProfile)")
        }
      } catch {
        productionSessionStatus = "Profile gate input failed: \(error)"
        if productionSessionAutomation {
          print("GHOSTTEA_PRODUCTION_INITIAL_COMMAND_ERROR \(error)")
        }
      }
    }
  }

  private func observeAutomatedProductionProfileFrame() async {
    guard productionSessionAutomation, let productionTerminal else { return }
    do {
      let rows = try await productionTerminal.accessibilityRows(start: 0, count: 100)
      let text = String(decoding: rows, as: UTF8.self)
      switch productionSSHProfile {
      case .tmux:
        advanceAutomatedTmux(text: text)
      case .vim:
        advanceAutomatedVim(text: text)
      case .zellij:
        advanceAutomatedZellij(text: text)
      case .monitorTuis:
        advanceAutomatedMonitorTuis(text: text)
      case .claude:
        advanceAutomatedClaude(text: text)
      case .shell:
        break
      }
    } catch {
      productionSessionStatus = "Profile frame validation failed: \(error)"
      finishProductionSessionAutomation(exitCode: 2)
    }
  }

  private func advanceAutomatedTmux(text: String) {
    guard let productionSession else { return }
    if text.contains("ghosttea-tmux-ready 29 100") {
      productionTmuxInitialSizeObserved = true
    }
    if text.contains("ghosttea-tmux-resized 39 120") {
      productionTmuxResizedSizeObserved = true
    }
    if productionTmuxInitialSizeObserved, !productionTmuxResizeSent {
      productionTmuxResizeSent = true
      Task {
        do {
          try await productionSession.resize(columns: 120, rows: 40, layoutEpoch: 1)
        } catch {
          failAutomatedProductionAction("tmux resize", error: error)
        }
      }
    }
    if productionTmuxResizedSizeObserved, !productionTmuxExitSent {
      productionTmuxExitSent = true
      Task {
        do {
          try await productionSession.send(Data("\n".utf8))
        } catch {
          failAutomatedProductionAction("tmux exit handshake", error: error)
        }
      }
    }
  }

  private func advanceAutomatedVim(text: String) {
    guard let productionSession else { return }
    if text.contains("ghosttea-vim-noecho") {
      if !productionVimNoEchoObserved {
        print("GHOSTTEA_PRODUCTION_VIM_NOECHO_OBSERVED")
      }
      productionVimNoEchoObserved = true
    }
    if text.contains("ghosttea-vim-buffer") {
      if !productionVimBufferObserved {
        print("GHOSTTEA_PRODUCTION_VIM_BUFFER_OBSERVED")
      }
      productionVimBufferObserved = true
    }
    if text.contains("ghosttea-vim-initial 30 100") {
      if !productionVimInitialSizeObserved {
        print("GHOSTTEA_PRODUCTION_VIM_INITIAL_SIZE_OBSERVED")
      }
      productionVimInitialSizeObserved = true
    }
    if text.contains("ghosttea-vim-resized 40 120") {
      if !productionVimResizedSizeObserved {
        print("GHOSTTEA_PRODUCTION_VIM_RESIZED_SIZE_OBSERVED")
      }
      productionVimResizedSizeObserved = true
    }
    if text.contains("ghosttea-vim-edited ghosttea-vim-input") {
      if !productionVimEditObserved {
        print("GHOSTTEA_PRODUCTION_VIM_EDIT_OBSERVED")
      }
      productionVimEditObserved = true
    }

    if productionVimNoEchoObserved, !productionVimLaunchSent {
      productionVimLaunchSent = true
      Task {
        do {
          try await productionSession.send(
            Data(
              "printf 'ghosttea-vim-buffer\\n' > /tmp/ghosttea-vim-buffer; "
                .appending("exec vim.tiny -Nu NONE -n -i NONE /tmp/ghosttea-vim-buffer\n")
                .utf8
            )
          )
        } catch {
          failAutomatedProductionAction("Vim launch", error: error)
        }
      }
    }
    if productionVimBufferObserved, !productionVimInitialProbeSent {
      productionVimInitialProbeSent = true
      print("GHOSTTEA_PRODUCTION_VIM_INITIAL_PROBE_SENT")
      Task {
        do {
          try await sendAutomatedVimCommand(
            ":0read !printf 'ghosttea-vim-initial '; stty size"
          )
        } catch {
          failAutomatedProductionAction("Vim initial-size probe", error: error)
        }
      }
    }
    if productionVimInitialSizeObserved, !productionVimResizeSent {
      productionVimResizeSent = true
      productionVimResizedProbeSent = true
      print("GHOSTTEA_PRODUCTION_VIM_RESIZE_SENT")
      Task {
        do {
          try await productionSession.resize(columns: 120, rows: 40, layoutEpoch: 1)
          try await sendAutomatedVimCommand(
            ":0read !printf 'ghosttea-vim-resized '; stty size"
          )
        } catch {
          failAutomatedProductionAction("Vim resize", error: error)
        }
      }
    }
    if productionVimResizedSizeObserved, !productionVimEditSent {
      productionVimEditSent = true
      print("GHOSTTEA_PRODUCTION_VIM_EDIT_SENT")
      Task {
        do {
          try await productionSession.send(Data("Goghosttea-vim-edited ghosttea-vim-input".utf8))
          try await productionSession.sendKey(try softwareKey(hidUsage: 0x29))
        } catch {
          failAutomatedProductionAction("Vim edit", error: error)
        }
      }
    }
    if productionVimEditObserved, !productionVimExitSent {
      productionVimExitSent = true
      print("GHOSTTEA_PRODUCTION_VIM_EXIT_SENT")
      Task {
        do {
          try await sendAutomatedVimCommand(":qa!")
        } catch {
          failAutomatedProductionAction("Vim exit", error: error)
        }
      }
    }
  }

  private func sendAutomatedVimCommand(_ command: String) async throws {
    guard let productionSession else { return }
    try await productionSession.send(Data(command.utf8))
    try await productionSession.sendKey(try softwareKey(hidUsage: 0x28))
  }

  private func advanceAutomatedZellij(text: String) {
    guard let productionSession else { return }
    if text.contains("ghosttea-zellij-noecho") {
      if !productionZellijNoEchoObserved {
        print("GHOSTTEA_PRODUCTION_ZELLIJ_NOECHO_OBSERVED")
      }
      productionZellijNoEchoObserved = true
    }
    if text.contains("ghosttea-zellij-ready 26 98") {
      if !productionZellijInitialSizeObserved {
        print("GHOSTTEA_PRODUCTION_ZELLIJ_INITIAL_SIZE_OBSERVED")
      }
      productionZellijInitialSizeObserved = true
    }
    if text.contains("ghosttea-zellij-resized 36 118") {
      if !productionZellijResizedSizeObserved {
        print("GHOSTTEA_PRODUCTION_ZELLIJ_RESIZED_SIZE_OBSERVED")
      }
      productionZellijResizedSizeObserved = true
    }
    if text.contains("ghosttea-zellij-input accepted") {
      if !productionZellijInputObserved {
        print("GHOSTTEA_PRODUCTION_ZELLIJ_INPUT_OBSERVED")
      }
      productionZellijInputObserved = true
    }

    if productionZellijNoEchoObserved, !productionZellijProbeSent {
      productionZellijProbeSent = true
      print("GHOSTTEA_PRODUCTION_ZELLIJ_PROBE_SENT")
      Task {
        do {
          try await productionSession.send(
            Data(
              ("initial=\"$(stty size)\"; "
                + "printf 'ghosttea-zellij-ready %s\\n' \"$initial\"; "
                + "while [ \"$(stty size)\" = \"$initial\" ]; do sleep 1; done; "
                + "printf 'ghosttea-zellij-resized '; stty size; "
                + "read ghosttea_input; printf 'ghosttea-zellij-input %s\\n' "
                + "\"$ghosttea_input\"; sleep 1; exit\n").utf8
            )
          )
        } catch {
          failAutomatedProductionAction("Zellij probe", error: error)
        }
      }
    }
    if productionZellijInitialSizeObserved, !productionZellijResizeSent {
      productionZellijResizeSent = true
      print("GHOSTTEA_PRODUCTION_ZELLIJ_RESIZE_SENT")
      Task {
        do {
          try await productionSession.resize(columns: 120, rows: 40, layoutEpoch: 1)
        } catch {
          failAutomatedProductionAction("Zellij resize", error: error)
        }
      }
    }
    if productionZellijResizedSizeObserved, !productionZellijInputSent {
      productionZellijInputSent = true
      productionZellijExitSent = true
      print("GHOSTTEA_PRODUCTION_ZELLIJ_INPUT_SENT")
      Task {
        do {
          try await productionSession.send(Data("accepted\n".utf8))
        } catch {
          failAutomatedProductionAction("Zellij input", error: error)
        }
      }
    }
  }

  private func advanceAutomatedMonitorTuis(text: String) {
    guard let productionSession else { return }
    if text.contains("ghosttea-monitor-noecho") {
      if !productionMonitorNoEchoObserved {
        print("GHOSTTEA_PRODUCTION_MONITOR_NOECHO_OBSERVED")
      }
      productionMonitorNoEchoObserved = true
    }
    if text.contains("Tasks:"), text.contains("Load average:"), text.contains("F10Quit") {
      if !productionHtopMainObserved {
        print("GHOSTTEA_PRODUCTION_HTOP_MAIN_OBSERVED")
      }
      productionHtopMainObserved = true
    }
    if text.contains("htop 3.2.2"), text.contains("F10 q: quit") {
      if !productionHtopHelpObserved {
        print("GHOSTTEA_PRODUCTION_HTOP_HELP_OBSERVED")
      }
      productionHtopHelpObserved = true
    }
    if text.contains("ghosttea-htop-exit 40 120") {
      if !productionHtopExitObserved {
        print("GHOSTTEA_PRODUCTION_HTOP_EXIT_OBSERVED")
      }
      productionHtopExitObserved = true
    }
    if productionHtopExitObserved, text.contains("download"), text.contains("upload"),
      text.contains("proc"), text.contains("mem")
    {
      if !productionBtopMainObserved {
        print("GHOSTTEA_PRODUCTION_BTOP_MAIN_OBSERVED")
      }
      productionBtopMainObserved = true
    }
    if productionBtopMenuSent, text.contains("v1.2.13") {
      if !productionBtopMenuObserved {
        print("GHOSTTEA_PRODUCTION_BTOP_MENU_OBSERVED")
      }
      productionBtopMenuObserved = true
    }
    if text.contains("ghosttea-btop-exit 30 100") {
      if !productionBtopExitObserved {
        print("GHOSTTEA_PRODUCTION_BTOP_EXIT_OBSERVED")
      }
      productionBtopExitObserved = true
    }

    if productionMonitorNoEchoObserved, !productionHtopLaunchSent {
      productionHtopLaunchSent = true
      print("GHOSTTEA_PRODUCTION_HTOP_LAUNCH_SENT")
      Task {
        do {
          try await productionSession.send(
            Data(
              ("htop -C -M --readonly -d 20; "
                + "printf 'ghosttea-htop-exit '; stty size; "
                + "btop --utf-force -lc; "
                + "printf 'ghosttea-btop-exit '; stty size; sleep 1; exit\n").utf8
            )
          )
        } catch {
          failAutomatedProductionAction("monitor TUI launch", error: error)
        }
      }
    }
    if productionHtopMainObserved, !productionHtopHelpSent {
      productionHtopHelpSent = true
      print("GHOSTTEA_PRODUCTION_HTOP_HELP_SENT")
      Task {
        do {
          try await productionSession.send(Data("h".utf8))
        } catch {
          failAutomatedProductionAction("htop help", error: error)
        }
      }
    }
    if productionHtopHelpObserved, !productionHtopResizeSent {
      productionHtopResizeSent = true
      print("GHOSTTEA_PRODUCTION_HTOP_RESIZE_SENT")
      Task {
        do {
          try await productionSession.resize(columns: 120, rows: 40, layoutEpoch: 1)
          try await Task.sleep(for: .milliseconds(500))
          try await productionSession.send(Data("q".utf8))
          print("GHOSTTEA_PRODUCTION_HTOP_HELP_DISMISS_SENT")
        } catch {
          failAutomatedProductionAction("htop resize and help dismissal", error: error)
        }
      }
    }
    if productionHtopResizeSent, !productionHtopExitSent, text.contains("Tasks:"),
      text.contains("Load average:"), text.contains("F10Quit")
    {
      productionHtopExitSent = true
      print("GHOSTTEA_PRODUCTION_HTOP_EXIT_SENT")
      Task {
        do {
          try await productionSession.send(Data("q".utf8))
        } catch {
          failAutomatedProductionAction("htop exit", error: error)
        }
      }
    }
    if productionBtopMainObserved, !productionBtopMenuSent {
      productionBtopMenuSent = true
      print("GHOSTTEA_PRODUCTION_BTOP_MENU_SENT")
      Task {
        do {
          try await productionSession.send(Data("m".utf8))
        } catch {
          failAutomatedProductionAction("btop menu", error: error)
        }
      }
    }
    if productionBtopMenuObserved, !productionBtopResizeSent {
      productionBtopResizeSent = true
      productionBtopExitSent = true
      print("GHOSTTEA_PRODUCTION_BTOP_RESIZE_SENT")
      Task {
        do {
          try await productionSession.resize(columns: 100, rows: 30, layoutEpoch: 2)
          try await Task.sleep(for: .milliseconds(500))
          try await productionSession.send(Data("q".utf8))
          print("GHOSTTEA_PRODUCTION_BTOP_EXIT_SENT")
        } catch {
          failAutomatedProductionAction("btop resize and exit", error: error)
        }
      }
    }
  }

  private func advanceAutomatedClaude(text: String) {
    guard let productionSession else { return }
    if text.contains("ghosttea-claude-noecho") {
      if !productionClaudeNoEchoObserved {
        print("GHOSTTEA_PRODUCTION_CLAUDE_NOECHO_OBSERVED")
      }
      productionClaudeNoEchoObserved = true
    }
    if text.contains("Claude Code v2.1.214"), text.contains("? for shortcuts") {
      if !productionClaudeMainObserved {
        print("GHOSTTEA_PRODUCTION_CLAUDE_MAIN_OBSERVED")
      }
      productionClaudeMainObserved = true
    }
    if text.contains("ghosttea-claude-response-ok") {
      if !productionClaudeResponseObserved {
        print("GHOSTTEA_PRODUCTION_CLAUDE_RESPONSE_OBSERVED")
      }
      productionClaudeResponseObserved = true
    }
    if productionClaudeInterruptPromptSent, text.contains("esc to interrupt") {
      if !productionClaudeInterruptActiveObserved {
        print("GHOSTTEA_PRODUCTION_CLAUDE_INTERRUPT_ACTIVE_OBSERVED")
      }
      productionClaudeInterruptActiveObserved = true
    }
    if text.contains("Interrupted · What should Claude do instead?") {
      if !productionClaudeInterruptedObserved {
        print("GHOSTTEA_PRODUCTION_CLAUDE_INTERRUPTED_OBSERVED")
      }
      productionClaudeInterruptedObserved = true
    }
    if text.contains("! for shell mode"), text.contains("/ for commands"),
      text.contains("ctrl + z to suspend")
    {
      if !productionClaudeShortcutsObserved {
        print("GHOSTTEA_PRODUCTION_CLAUDE_SHORTCUTS_OBSERVED")
      }
      productionClaudeShortcutsObserved = true
    }
    if text.contains("ghosttea-claude-exit 40 120") {
      if !productionClaudeExitObserved {
        print("GHOSTTEA_PRODUCTION_CLAUDE_EXIT_OBSERVED")
      }
      productionClaudeExitObserved = true
    }

    if productionClaudeNoEchoObserved, !productionClaudeLaunchSent {
      productionClaudeLaunchSent = true
      print("GHOSTTEA_PRODUCTION_CLAUDE_LAUNCH_SENT")
      Task {
        do {
          try await productionSession.send(
            Data(
              ("env HOME=/home/ghosttea TERM=xterm-256color "
                + "ANTHROPIC_BASE_URL=http://127.0.0.1:22100 "
                + "ANTHROPIC_AUTH_TOKEN=ghosttea-fixture-token IS_DEMO=1 "
                + "DISABLE_TELEMETRY=1 DISABLE_UPDATES=1 DISABLE_ERROR_REPORTING=1 "
                + "DISABLE_LOGIN_COMMAND=1 DISABLE_LOGOUT_COMMAND=1 "
                + "CLAUDE_CODE_DISABLE_TERMINAL_TITLE=1 "
                + "CLAUDE_CODE_DISABLE_AUTO_MEMORY=1 "
                + "CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL=1 "
                + "CLAUDE_CODE_DISABLE_BUNDLED_SKILLS=1 "
                + "CLAUDE_CODE_DISABLE_CLAUDE_MDS=1 "
                + "claude --model claude-sonnet-4-5-20250929; "
                + "printf 'ghosttea-claude-exit '; stty size; sleep 1; exit\n").utf8
            )
          )
        } catch {
          failAutomatedProductionAction("Claude Code launch", error: error)
        }
      }
    }
    if productionClaudeMainObserved, !productionClaudePromptSent {
      productionClaudePromptSent = true
      print("GHOSTTEA_PRODUCTION_CLAUDE_PROMPT_SENT")
      Task {
        do {
          try await sendAutomatedClaudeLine("Reply with the fixture result.")
        } catch {
          failAutomatedProductionAction("Claude Code prompt", error: error)
        }
      }
    }
    if productionClaudeResponseObserved, !productionClaudeInterruptPromptSent {
      productionClaudeInterruptPromptSent = true
      print("GHOSTTEA_PRODUCTION_CLAUDE_INTERRUPT_PROMPT_SENT")
      Task {
        do {
          try await sendAutomatedClaudeLine("ghosttea-interrupt-request")
        } catch {
          failAutomatedProductionAction("Claude Code interrupt prompt", error: error)
        }
      }
    }
    if productionClaudeInterruptActiveObserved, !productionClaudeInterruptSent {
      productionClaudeInterruptSent = true
      print("GHOSTTEA_PRODUCTION_CLAUDE_INTERRUPT_SENT")
      Task {
        do {
          try await productionSession.sendKey(try softwareKey(hidUsage: 0x29))
        } catch {
          failAutomatedProductionAction("Claude Code interrupt", error: error)
        }
      }
    }
    if productionClaudeInterruptedObserved, !productionClaudeShortcutsSent {
      productionClaudeShortcutsSent = true
      print("GHOSTTEA_PRODUCTION_CLAUDE_SHORTCUTS_SENT")
      Task {
        do {
          try await productionSession.send(Data("?".utf8))
        } catch {
          failAutomatedProductionAction("Claude Code shortcuts", error: error)
        }
      }
    }
    if productionClaudeShortcutsObserved, !productionClaudeResizeSent {
      productionClaudeResizeSent = true
      productionClaudeExitSent = true
      print("GHOSTTEA_PRODUCTION_CLAUDE_RESIZE_SENT")
      Task {
        do {
          try await productionSession.resize(columns: 120, rows: 40, layoutEpoch: 1)
          try await Task.sleep(for: .milliseconds(300))
          try await productionSession.send(Data("?".utf8))
          try await sendAutomatedClaudeLine("/exit")
          print("GHOSTTEA_PRODUCTION_CLAUDE_EXIT_SENT")
        } catch {
          failAutomatedProductionAction("Claude Code resize and exit", error: error)
        }
      }
    }
  }

  private func sendAutomatedClaudeLine(_ line: String) async throws {
    guard let productionSession else { return }
    try await productionSession.send(Data(line.utf8))
    try await productionSession.sendKey(try softwareKey(hidUsage: 0x28))
  }

  private func failAutomatedProductionAction(_ action: String, error: any Error) {
    productionSessionStatus = "\(action) failed: \(error)"
    print("GHOSTTEA_PRODUCTION_ACTION_ERROR action=\(action) error=\(error)")
    finishProductionSessionAutomation(exitCode: 2)
  }

  private func validateCompletedProductionShell(exit: TerminalExitStatus) {
    guard productionSessionAutomation, let productionTerminal else {
      productionSessionStatus = "Completed · \(exit.description)"
      isRunningProductionSession = false
      cleanupProductionCredential()
      return
    }
    Task {
      do {
        let rows = try await productionTerminal.accessibilityRows(start: 0, count: 100)
        let text = String(decoding: rows, as: UTF8.self)
        let markerIsValid: Bool
        switch productionSSHProfile {
        case .shell:
          markerIsValid = text.contains("ghosttea-production-session-ok")
        case .tmux:
          markerIsValid =
            productionTmuxResizeSent
            && productionTmuxInitialSizeObserved
            && productionTmuxResizedSizeObserved
            && productionTmuxExitSent
        case .vim:
          markerIsValid =
            productionVimNoEchoObserved
            && productionVimLaunchSent
            && productionVimBufferObserved
            && productionVimInitialProbeSent
            && productionVimInitialSizeObserved
            && productionVimResizeSent
            && productionVimResizedProbeSent
            && productionVimResizedSizeObserved
            && productionVimEditSent
            && productionVimEditObserved
            && productionVimExitSent
          print(
            "GHOSTTEA_PRODUCTION_VIM_FINAL exit=\(exit.description) "
              + "noecho=\(productionVimNoEchoObserved) "
              + "launch=\(productionVimLaunchSent) buffer=\(productionVimBufferObserved) "
              + "initialProbe=\(productionVimInitialProbeSent) "
              + "initialSize=\(productionVimInitialSizeObserved) "
              + "resize=\(productionVimResizeSent) resizedProbe=\(productionVimResizedProbeSent) "
              + "resizedSize=\(productionVimResizedSizeObserved) edit=\(productionVimEditSent) "
              + "edited=\(productionVimEditObserved) exitSent=\(productionVimExitSent)"
          )
        case .zellij:
          markerIsValid =
            productionZellijNoEchoObserved
            && productionZellijProbeSent
            && productionZellijInitialSizeObserved
            && productionZellijResizeSent
            && productionZellijResizedSizeObserved
            && productionZellijInputSent
            && productionZellijInputObserved
            && productionZellijExitSent
          print(
            "GHOSTTEA_PRODUCTION_ZELLIJ_FINAL exit=\(exit.description) "
              + "noecho=\(productionZellijNoEchoObserved) probe=\(productionZellijProbeSent) "
              + "initialSize=\(productionZellijInitialSizeObserved) "
              + "resize=\(productionZellijResizeSent) "
              + "resizedSize=\(productionZellijResizedSizeObserved) "
              + "input=\(productionZellijInputSent) observed=\(productionZellijInputObserved) "
              + "exitSent=\(productionZellijExitSent)"
          )
        case .monitorTuis:
          markerIsValid =
            productionMonitorNoEchoObserved
            && productionHtopLaunchSent
            && productionHtopMainObserved
            && productionHtopHelpSent
            && productionHtopHelpObserved
            && productionHtopResizeSent
            && productionHtopExitSent
            && productionHtopExitObserved
            && productionBtopMainObserved
            && productionBtopMenuSent
            && productionBtopMenuObserved
            && productionBtopResizeSent
            && productionBtopExitSent
            && productionBtopExitObserved
          print(
            "GHOSTTEA_PRODUCTION_MONITOR_TUIS_FINAL exit=\(exit.description) "
              + "noecho=\(productionMonitorNoEchoObserved) "
              + "htopMain=\(productionHtopMainObserved) "
              + "htopHelp=\(productionHtopHelpObserved) "
              + "htopResize=\(productionHtopResizeSent) "
              + "htopExit=\(productionHtopExitObserved) "
              + "btopMain=\(productionBtopMainObserved) "
              + "btopMenu=\(productionBtopMenuObserved) "
              + "btopResize=\(productionBtopResizeSent) "
              + "btopExit=\(productionBtopExitObserved)"
          )
        case .claude:
          markerIsValid =
            productionClaudeNoEchoObserved
            && productionClaudeLaunchSent
            && productionClaudeMainObserved
            && productionClaudePromptSent
            && productionClaudeResponseObserved
            && productionClaudeInterruptPromptSent
            && productionClaudeInterruptActiveObserved
            && productionClaudeInterruptSent
            && productionClaudeInterruptedObserved
            && productionClaudeShortcutsSent
            && productionClaudeShortcutsObserved
            && productionClaudeResizeSent
            && productionClaudeExitSent
            && productionClaudeExitObserved
          print(
            "GHOSTTEA_PRODUCTION_CLAUDE_FINAL exit=\(exit.description) "
              + "noecho=\(productionClaudeNoEchoObserved) "
              + "main=\(productionClaudeMainObserved) "
              + "response=\(productionClaudeResponseObserved) "
              + "interruptActive=\(productionClaudeInterruptActiveObserved) "
              + "interrupted=\(productionClaudeInterruptedObserved) "
              + "shortcuts=\(productionClaudeShortcutsObserved) "
              + "resize=\(productionClaudeResizeSent) "
              + "exitObserved=\(productionClaudeExitObserved)"
          )
        }
        guard exit == .exited(code: 0), markerIsValid else {
          throw HarnessError.sessionProbeMismatch("production terminal output")
        }
        let passMarker: String
        switch productionSSHProfile {
        case .shell:
          productionSessionStatus = "Passed · SSH → core → TRF1 → Metal"
          passMarker = "GHOSTTEA_PRODUCTION_SESSION_PASS"
        case .tmux:
          productionSessionStatus = "Passed · tmux attach, input, and resize"
          passMarker = "GHOSTTEA_PRODUCTION_TMUX_PASS"
        case .vim:
          productionSessionStatus = "Passed · Vim render, input, and resize"
          passMarker = "GHOSTTEA_PRODUCTION_VIM_PASS"
        case .zellij:
          productionSessionStatus = "Passed · Zellij attach, input, and resize"
          passMarker = "GHOSTTEA_PRODUCTION_ZELLIJ_PASS"
        case .monitorTuis:
          productionSessionStatus = "Passed · htop + btop render, input, and resize"
          passMarker = "GHOSTTEA_PRODUCTION_MONITOR_TUIS_PASS"
        case .claude:
          productionSessionStatus = "Passed · Claude Code prompt, interrupt, shortcuts, and resize"
          passMarker = "GHOSTTEA_PRODUCTION_CLAUDE_PASS"
        }
        productionSessionInputStatus = "Native terminal text validated"
        print(passMarker)
        finishProductionSessionAutomation(exitCode: 0)
      } catch {
        productionSessionStatus = "Failed: \(error)"
        print("GHOSTTEA_PRODUCTION_SESSION_ERROR \(error)")
        finishProductionSessionAutomation(exitCode: 2)
      }
      isRunningProductionSession = false
      cleanupProductionCredential()
    }
  }

  private func cleanupProductionCredential() {
    guard let store = productionCredentialStore, let credential = productionCredential else {
      return
    }
    productionCredentialStore = nil
    productionCredential = nil
    Task { try? await store.remove(credential) }
  }

  private func finishProductionSessionAutomation(exitCode: Int32) {
    guard productionSessionAutomation else { return }
    let store = productionCredentialStore
    let credential = productionCredential
    productionCredentialStore = nil
    productionCredential = nil
    Task {
      if let store, let credential {
        try? await store.remove(credential)
      }
      fflush(nil)
      Darwin.exit(exitCode)
    }
  }

  private func softwareKey(hidUsage: UInt16) throws -> GhostteaKeyEvent {
    guard
      let event = GhostteaHardwareKeyEvent(
        hidUsage: hidUsage,
        characters: "",
        charactersIgnoringModifiers: "",
        action: .down
      )
    else {
      throw HarnessError.sessionProbeMismatch("software key")
    }
    return event.coreEvent
  }

  @discardableResult
  func runSSHCommand() -> Bool {
    guard !isRunningSSH else { return false }
    guard let numericPort = Int(port), (1...65_535).contains(numericPort) else {
      sshStatus = "Enter a valid port"
      return false
    }
    guard !host.isEmpty, !username.isEmpty else {
      sshStatus = "Host and username are required"
      return false
    }
    guard sshAuthentication != .privateKey || !privateKey.isEmpty else {
      sshStatus = "Paste a disposable OpenSSH private key"
      return false
    }

    let reconnectEffects = reconnectModel.update(.connectRequested)
    guard
      case .startFreshConnection(let generation) = reconnectEffects.first
    else {
      updateReconnectStateSummary()
      sshStatus = "Waiting for a usable network path"
      return false
    }

    let requestedHost = host
    let requestedUsername = username
    let requestedAuthentication = sshAuthentication
    let requestedSession = sshSession
    let requestedPassword = Data(password.utf8)
    let requestedPrivateKey = Data(privateKey.utf8)
    let requestedPassphrase = Data(privateKeyPassphrase.utf8)
    let requestedCommand = command
    password = ""
    privateKey = ""
    privateKeyPassphrase = ""
    isRunningSSH = true
    sshStatus = "Connecting…"
    sshOutput = ""
    sshStandardError = ""
    isBridgingSSHInteraction = false

    sshCancellationRequestedAt = nil
    sshCancellationReason = nil
    sshGeneration = generation
    sshTask = Task {
      do {
        let credentialStore = try KeychainSSHCredentialStore()
        let connectionID = UUID()
        let credentials: [SSHCredentialID]
        let authentication: SSHCandidateAuthentication
        do {
          switch requestedAuthentication {
          case .password:
            let credential = SSHCredentialID(connectionID: connectionID, kind: .password)
            credentials = [credential]
            authentication = .passwordCredential(
              username: requestedUsername,
              credential: credential,
              resolver: { requestedCredential in
                try await credentialStore.require(requestedCredential)
              }
            )
            try await credentialStore.store(requestedPassword, for: credential)
          case .privateKey:
            let privateKeyCredential = SSHCredentialID(
              connectionID: connectionID,
              kind: .privateKey
            )
            let passphraseCredential =
              requestedPassphrase.isEmpty
              ? nil
              : SSHCredentialID(
                connectionID: connectionID,
                kind: .privateKeyPassphrase
              )
            credentials = [privateKeyCredential, passphraseCredential].compactMap { $0 }
            authentication = .publicKeyCredential(
              username: requestedUsername,
              privateKeyCredential: privateKeyCredential,
              passphraseCredential: passphraseCredential,
              resolver: { requestedCredential in
                try await credentialStore.require(requestedCredential)
              }
            )
            try await credentialStore.store(requestedPrivateKey, for: privateKeyCredential)
            if let passphraseCredential {
              try await credentialStore.store(requestedPassphrase, for: passphraseCredential)
            }
          case .keyboardInteractive:
            credentials = []
            authentication = .keyboardInteractive(
              username: requestedUsername,
              responder: { [weak self] challenge in
                guard let self else { throw CancellationError() }
                return try await self.requestKeyboardChallengeResponse(challenge)
              }
            )
          }
          let candidateSession: SSHCandidateSession
          let initialColumns: Int
          let initialRows: Int
          switch requestedSession {
          case .command:
            candidateSession = .command(requestedCommand, allocatePTY: false)
            initialColumns = 80
            initialRows = 24
          case .ptyResize:
            candidateSession = .shell
            initialColumns = 132
            initialRows = 41
          case .halfClose:
            candidateSession = .command("cat", allocatePTY: false)
            initialColumns = 80
            initialRows = 24
          }
          let knownHostsPath = try self.knownHostsPath()
          let configuration = try SSHCandidateConfiguration(
            host: requestedHost,
            port: numericPort,
            knownHostsPath: knownHostsPath,
            hostKeyPolicy: .ask { [weak self] challenge in
              guard let self else { return .reject }
              return await self.requestHostKeyDecision(challenge)
            },
            authentication: authentication,
            session: candidateSession,
            columns: initialColumns,
            rows: initialRows,
            connectTimeoutMilliseconds: 15_000,
            handshakeTimeoutMilliseconds: 15_000
          )
          let transport = SSHCandidateTransport(configuration: configuration)
          let connection = try await transport.connect()
          _ = reconnectModel.update(.connectionEstablished(generation: generation))
          updateReconnectStateSummary()
          didEstablishConnectionForLifecycleProbe()
          finishSSHInteraction()
          do {
            try await removeCredentials(credentials, from: credentialStore)
            var negotiatedSummary: String?
            let candidate = connection as? SSHCandidateConnection
            if let candidate {
              let summary =
                "\(candidate.negotiatedAlgorithms.hostKey) · \(candidate.negotiatedAlgorithms.serverToClientCipher)"
              negotiatedSummary = summary
              sshStatus = "Connected · \(summary)"
            } else {
              sshStatus = "Connected"
            }
            let halfClosePayload = Data("ghosttea-half-close-device-ok\n".utf8)
            switch requestedSession {
            case .command:
              break
            case .ptyResize:
              try await connection.write(
                Data(
                  "printf 'INITIAL '; stty size; while [ \"$(stty size)\" = '41 132' ]; do sleep 1; done; printf 'RESIZED '; stty size; exit 0\n"
                    .utf8
                )
              )
            case .halfClose:
              try await connection.write(halfClosePayload)
              try await connection.finishInput()
            }
            var standardOutput = Data()
            var standardError = Data()
            var sentResize = false
            if let candidate {
              while let chunk = try await candidate.readCommandOutput(maxBytes: 32_768) {
                switch chunk {
                case .standardOutput(let bytes):
                  try appendSSHOutput(
                    bytes,
                    to: &standardOutput,
                    otherStreamBytes: standardError.count
                  )
                case .standardError(let bytes):
                  try appendSSHOutput(
                    bytes,
                    to: &standardError,
                    otherStreamBytes: standardOutput.count
                  )
                }
                if requestedSession == .ptyResize,
                  !sentResize,
                  String(decoding: standardOutput, as: UTF8.self).contains("INITIAL 41 132")
                {
                  try await connection.resize(columns: 140, rows: 50)
                  sentResize = true
                }
              }
            } else {
              while let chunk = try await connection.read(maxBytes: 32_768) {
                try appendSSHOutput(chunk, to: &standardOutput, otherStreamBytes: 0)
              }
            }
            let termination = try await connection.waitForExit()
            try validateSSHSessionProbe(
              requestedSession,
              standardOutput: standardOutput,
              standardError: standardError,
              termination: termination,
              sentResize: sentResize,
              halfClosePayload: halfClosePayload
            )
            try validateFreshReconnectProbe(
              standardOutput: standardOutput,
              standardError: standardError,
              termination: termination
            )
            sshOutput = String(decoding: standardOutput, as: UTF8.self)
            sshStandardError = String(decoding: standardError, as: UTF8.self)
            sshStatus = ["Completed", termination.description, negotiatedSummary]
              .compactMap { $0 }
              .joined(separator: " · ")
            _ = reconnectModel.update(.connectionCompleted(generation: generation))
            updateReconnectStateSummary()
            completeFreshReconnectProbeIfNeeded()
            await connection.disconnect()
          } catch {
            await connection.disconnect()
            throw error
          }
        } catch {
          try? await removeCredentials(credentials, from: credentialStore)
          throw error
        }
      } catch {
        if let requestedAt = sshCancellationRequestedAt,
          let cancellationReason = sshCancellationReason
        {
          let duration = requestedAt.duration(to: .now)
          let milliseconds = durationMilliseconds(duration)
          switch cancellationReason {
          case .user:
            sshStatus = "Cancelled in \(milliseconds) ms"
          case .networkChange:
            sshStatus =
              reconnectModel.path.canAttemptConnection
              ? "Network route changed · reconnect available · cancelled in \(milliseconds) ms"
              : "Network unavailable · waiting to reconnect · cancelled in \(milliseconds) ms"
          case .background:
            sshStatus = "Suspended in background · cancelled in \(milliseconds) ms"
          }
          recordLifecycleProbeCancellation(
            reason: cancellationReason,
            milliseconds: milliseconds
          )
        } else {
          _ = reconnectModel.update(
            .connectionFailed(generation: generation, reconnectable: false)
          )
          updateReconnectStateSummary()
          sshStatus = "Failed: \(error)"
          failLifecycleProbeIfActive("SSH failed: \(error)")
        }
      }
      finishSSHInteraction()
      isRunningSSH = false
      sshCancellationRequestedAt = nil
      sshCancellationReason = nil
      sshGeneration = nil
      sshTask = nil
      evaluateBackgroundLifecycleProbe()
    }
    return true
  }

  func loadSSHCommandPreset(_ preset: SSHCommandPreset) {
    switch preset {
    case .defaultOutput:
      command = "printf 'ghosttea-device-ok\\n'; uname -a"
    case .exitStreams:
      command = "printf 'fixture-stdout\\n'; printf 'fixture-stderr\\n' >&2; exit 37"
    case .signalTermination:
      command = "kill -TERM $$"
    }
  }

  func loadDisposableFixtureDefaults() {
    host = disposableFixtureHost
    port = "22022"
    username = "ghosttea"
    sshAuthentication = .password
    password = "ghosttea-password"
  }

  func runAutomaticRouteChangeProbe() {
    guard !isRunningSSH else { return }
    guard reconnectModel.path.canAttemptConnection,
      reconnectModel.path.interfaces.contains(.wifi)
    else {
      lifecycleProbeResult = "Failed · start on a satisfied Wi-Fi path"
      return
    }
    loadDisposableFixtureDefaults()
    sshSession = .command
    command = "printf 'READY\\n'; while :; do sleep 1; done"
    lifecycleProbe = .routeAwaitingConnection
    lifecycleProbeResult = "Connecting · host-key confirmation may be required"
    if !runSSHCommand() {
      lifecycleProbe = .none
      lifecycleProbeResult = "Failed · \(sshStatus)"
    }
  }

  func runAutomaticFreshReconnectProbe() {
    guard !isRunningSSH else { return }
    guard reconnectModel.path.canAttemptConnection else {
      lifecycleProbeResult = "Failed · restore a satisfied path first"
      return
    }
    loadDisposableFixtureDefaults()
    sshSession = .command
    command = "printf 'ghosttea-auto-reconnect-ok\\n'"
    lifecycleProbe = .freshReconnect
    lifecycleProbeResult = "Running explicit fresh reconnect…"
    if !runSSHCommand() {
      lifecycleProbe = .none
      lifecycleProbeResult = "Failed · \(sshStatus)"
    }
  }

  func runAutomaticBackgroundProbe() {
    guard !isRunningSSH else { return }
    guard reconnectModel.path.canAttemptConnection else {
      lifecycleProbeResult = "Failed · start on a satisfied network path"
      return
    }
    loadDisposableFixtureDefaults()
    sshSession = .command
    command = "printf 'READY\\n'; while :; do sleep 1; done"
    backgroundCancellationMilliseconds = nil
    lifecycleProbe = .backgroundAwaitingConnection
    lifecycleProbeResult = "Connecting · host-key confirmation may be required"
    if !runSSHCommand() {
      lifecycleProbe = .none
      lifecycleProbeResult = "Failed · \(sshStatus)"
    }
  }

  func cancelSSHCommand() {
    let effects = reconnectModel.update(.disconnectRequested)
    applyReconnectEffects(effects, cancellationReason: .user)
    updateReconnectStateSummary()
  }

  func sceneDidEnterBackground() {
    if lifecycleProbe == .backgroundAwaitingConnection {
      lifecycleProbeResult = "Failed · backgrounded before SSH connected"
      lifecycleProbe = .none
    } else if lifecycleProbe == .backgroundAwaitingReturn {
      lifecycleProbeResult = "Background observed · waiting for teardown"
    }
    let effects = reconnectModel.update(.enteredBackground)
    applyReconnectEffects(effects, cancellationReason: .background)
    updateReconnectStateSummary()
    if let productionSession {
      Task { await productionSession.enteredBackground() }
    }
  }

  func sceneDidBecomeActive() {
    let effects = reconnectModel.update(.becameActive)
    applyReconnectEffects(effects, cancellationReason: .networkChange)
    updateReconnectStateSummary()
    evaluateBackgroundLifecycleProbe()
    if let productionSession {
      Task { await productionSession.becameActive() }
    }
  }

  private func requestSSHCancellation(_ reason: SSHCancellationReason) {
    guard isRunningSSH, sshCancellationRequestedAt == nil else { return }
    sshCancellationRequestedAt = .now
    sshCancellationReason = reason
    switch reason {
    case .user:
      sshStatus = "Cancelling…"
    case .networkChange:
      sshStatus = "Network route changed · cancelling…"
    case .background:
      sshStatus = "Suspending · cancelling…"
    }
    resolveHostKey(.reject)
    cancelKeyboardChallenge()
    sshTask?.cancel()
  }

  private func handleNetworkPathChange(_ path: TerminalNetworkPath) {
    networkPathSummary = describe(path)
    let effects = reconnectModel.update(.pathChanged(path))
    applyReconnectEffects(effects, cancellationReason: .networkChange)
    updateReconnectStateSummary()
    if let productionSession {
      Task { await productionSession.updateNetworkPath(path) }
    }
    if productionSessionAutomation, !didAutorunProductionSession, path.canAttemptConnection {
      didAutorunProductionSession = true
      switch ProcessInfo.processInfo.environment["GHOSTTEA_PRODUCTION_PROFILE"] {
      case "tmux":
        productionSSHProfile = .tmux
      case "vim":
        productionSSHProfile = .vim
      case "zellij":
        productionSSHProfile = .zellij
      case "monitor-tuis":
        productionSSHProfile = .monitorTuis
      case "claude":
        productionSSHProfile = .claude
      default:
        productionSSHProfile = .shell
      }
      print("GHOSTTEA_PRODUCTION_PROFILE_SELECTED profile=\(productionSSHProfile)")
      runProductionSessionGate()
    }
  }

  private func didEstablishConnectionForLifecycleProbe() {
    switch lifecycleProbe {
    case .routeAwaitingConnection:
      lifecycleProbe = .routeAwaitingTransition
      lifecycleProbeResult = "Connected · disable Wi-Fi; do not tap Cancel"
    case .backgroundAwaitingConnection:
      lifecycleProbe = .backgroundAwaitingReturn
      lifecycleProbeResult = "Connected · background and reopen the app"
    default:
      break
    }
  }

  private func recordLifecycleProbeCancellation(
    reason: SSHCancellationReason,
    milliseconds: Int64
  ) {
    switch lifecycleProbe {
    case .routeAwaitingTransition:
      guard reason == .networkChange else {
        failLifecycleProbeIfActive("expected a network-route cancellation")
        return
      }
      guard milliseconds < 1_000 else {
        failLifecycleProbeIfActive("route teardown took \(milliseconds) ms")
        return
      }
      guard !reconnectModel.path.interfaces.contains(.wifi),
        reconnectModel.state == .reconnectAvailable
          || reconnectModel.state == .waitingForNetwork
      else {
        failLifecycleProbeIfActive("route state did not offer or await reconnect")
        return
      }
      lifecycleProbeResult =
        "Passed · automatic route teardown \(milliseconds) ms · \(reconnectStateSummary)"
      lifecycleProbe = .none
    case .backgroundAwaitingReturn:
      guard reason == .background else {
        failLifecycleProbeIfActive("expected a background cancellation")
        return
      }
      backgroundCancellationMilliseconds = milliseconds
      lifecycleProbeResult = "Background teardown \(milliseconds) ms · reopen to finish"
    default:
      break
    }
  }

  private func evaluateBackgroundLifecycleProbe() {
    guard lifecycleProbe == .backgroundAwaitingReturn,
      let milliseconds = backgroundCancellationMilliseconds,
      !isRunningSSH,
      reconnectModel.state == .reconnectAvailable
    else { return }
    guard milliseconds < 1_000 else {
      failLifecycleProbeIfActive("background teardown took \(milliseconds) ms")
      return
    }
    lifecycleProbeResult =
      "Passed · background teardown \(milliseconds) ms · explicit reconnect available"
    lifecycleProbe = .none
  }

  private func validateFreshReconnectProbe(
    standardOutput: Data,
    standardError: Data,
    termination: TerminalExitStatus
  ) throws {
    guard lifecycleProbe == .freshReconnect else { return }
    guard
      standardOutput == Data("ghosttea-auto-reconnect-ok\n".utf8),
      standardError.isEmpty,
      termination == .exited(code: 0)
    else {
      throw HarnessError.sessionProbeMismatch("explicit fresh reconnect")
    }
  }

  private func completeFreshReconnectProbeIfNeeded() {
    guard lifecycleProbe == .freshReconnect else { return }
    lifecycleProbeResult = "Passed · explicit fresh reconnect produced exact output"
    lifecycleProbe = .none
  }

  private func failLifecycleProbeIfActive(_ reason: String) {
    guard lifecycleProbe != .none else { return }
    lifecycleProbeResult = "Failed · \(reason)"
    lifecycleProbe = .none
  }

  private func applyReconnectEffects(
    _ effects: [TerminalReconnectEffect],
    cancellationReason: SSHCancellationReason
  ) {
    for effect in effects {
      switch effect {
      case .startFreshConnection:
        // Fresh connections are started only by `runSSHCommand`, after fields
        // and credentials have been validated and captured.
        break
      case .tearDownConnection(let generation):
        guard sshGeneration == generation else { continue }
        requestSSHCancellation(cancellationReason)
      case .reconnectBecameAvailable:
        if !isRunningSSH {
          sshStatus = "Reconnect available · submit credentials to start a fresh SSH session"
        }
      }
    }
  }

  private func updateReconnectStateSummary() {
    switch reconnectModel.state {
    case .idle:
      reconnectStateSummary = "Idle"
    case .waitingForNetwork:
      reconnectStateSummary = "Waiting for network"
    case .connecting(let generation):
      reconnectStateSummary = "Connecting · generation \(generation)"
    case .connected(let generation):
      reconnectStateSummary = "Connected · generation \(generation)"
    case .reconnectAvailable:
      reconnectStateSummary = "Reconnect available"
    case .suspended:
      reconnectStateSummary = "Suspended"
    case .failed:
      reconnectStateSummary = "Failed"
    }
  }

  private func describe(_ path: TerminalNetworkPath) -> String {
    let availability: String
    switch path.availability {
    case .unknown: availability = "Unknown"
    case .satisfied: availability = "Satisfied"
    case .unsatisfied: availability = "Unsatisfied"
    case .requiresConnection: availability = "Requires connection"
    }

    let interfaceNames = path.interfaces.map { interface in
      switch interface {
      case .wifi: return "Wi-Fi"
      case .cellular: return "Cellular"
      case .wiredEthernet: return "Ethernet"
      case .loopback: return "Loopback"
      case .other: return "Other"
      }
    }.sorted()
    let route = interfaceNames.isEmpty ? "no route" : interfaceNames.joined(separator: ", ")
    var qualifiers: [String] = []
    if path.isExpensive { qualifiers.append("expensive") }
    if path.isConstrained { qualifiers.append("constrained") }
    return ([availability, route] + qualifiers).joined(separator: " · ")
  }

  func resolveHostKey(_ decision: SSHCandidateHostKeyDecision) {
    let continuation = hostKeyContinuation
    hostKeyContinuation = nil
    pendingHostKey = nil
    isBridgingSSHInteraction = decision != .reject
    continuation?.resume(returning: decision)
  }

  func resolveKeyboardChallenge(_ responses: [String]) {
    let continuation = keyboardChallengeContinuation
    keyboardChallengeContinuation = nil
    pendingKeyboardChallenge = nil
    isBridgingSSHInteraction = true
    continuation?.resume(returning: responses)
  }

  func cancelKeyboardChallenge() {
    let continuation = keyboardChallengeContinuation
    keyboardChallengeContinuation = nil
    pendingKeyboardChallenge = nil
    isBridgingSSHInteraction = false
    continuation?.resume(throwing: CancellationError())
  }

  private func requestHostKeyDecision(
    _ challenge: SSHCandidateHostKeyChallenge
  ) async -> SSHCandidateHostKeyDecision {
    if let continuation = hostKeyContinuation {
      continuation.resume(returning: .reject)
    }
    return await withCheckedContinuation { continuation in
      hostKeyContinuation = continuation
      isBridgingSSHInteraction = false
      pendingHostKey = PendingHostKey(challenge: challenge)
    }
  }

  private func requestKeyboardChallengeResponse(
    _ challenge: SSHKeyboardInteractiveChallenge
  ) async throws -> [String] {
    if let continuation = keyboardChallengeContinuation {
      continuation.resume(throwing: CancellationError())
    }
    return try await withCheckedThrowingContinuation { continuation in
      keyboardChallengeContinuation = continuation
      isBridgingSSHInteraction = false
      pendingKeyboardChallenge = PendingKeyboardChallenge(challenge: challenge)
    }
  }

  private func finishSSHInteraction() {
    isBridgingSSHInteraction = false
  }

  private func knownHostsPath() throws -> String {
    try GhostteaSSHKnownHostsFile(
      applicationDirectoryName: "GhostteaHarness"
    ).prepare()
  }

  private func removeCredentials(
    _ credentials: [SSHCredentialID],
    from store: KeychainSSHCredentialStore
  ) async throws {
    for credential in credentials {
      try await store.remove(credential)
    }
  }

  private func appendSSHOutput(
    _ bytes: Data,
    to stream: inout Data,
    otherStreamBytes: Int
  ) throws {
    guard stream.count + otherStreamBytes + bytes.count <= 1_048_576 else {
      throw HarnessError.outputLimitExceeded
    }
    stream.append(bytes)
  }

  private func validateSSHSessionProbe(
    _ session: SSHProbeSession,
    standardOutput: Data,
    standardError: Data,
    termination: TerminalExitStatus,
    sentResize: Bool,
    halfClosePayload: Data
  ) throws {
    switch session {
    case .command:
      return
    case .ptyResize:
      let output = String(decoding: standardOutput, as: UTF8.self)
      guard
        sentResize,
        output.contains("INITIAL 41 132"),
        output.contains("RESIZED 50 140"),
        standardError.isEmpty,
        termination == .exited(code: 0)
      else {
        throw HarnessError.sessionProbeMismatch("PTY resize")
      }
    case .halfClose:
      guard
        standardOutput == halfClosePayload,
        standardError.isEmpty,
        termination == .exited(code: 0)
      else {
        throw HarnessError.sessionProbeMismatch("input half-close")
      }
    }
  }

  private func durationMilliseconds(_ duration: Duration) -> Int64 {
    let components = duration.components
    return components.seconds * 1_000 + components.attoseconds / 1_000_000_000_000_000
  }
}

private enum HarnessError: Error, CustomStringConvertible {
  case coreParityMismatch
  case frameDecoderMismatch
  case keychainRemovalFailed
  case keychainRoundTripMismatch
  case outputLimitExceeded
  case sessionProbeMismatch(String)

  var description: String {
    switch self {
    case .coreParityMismatch:
      return "production core fixture did not preserve ordered effects and state"
    case .frameDecoderMismatch:
      return "strict TRF1 decoder did not preserve the production frame"
    case .keychainRemovalFailed:
      return "credential remained after Keychain removal"
    case .keychainRoundTripMismatch:
      return "Keychain credential round trip changed the secret"
    case .outputLimitExceeded:
      return "command output exceeded the 1 MiB harness limit"
    case .sessionProbeMismatch(let probe):
      return "\(probe) session probe did not produce its exact expected result"
    }
  }
}

extension TerminalExitStatus {
  fileprivate var description: String {
    switch self {
    case .exited(let code):
      return "exit \(code)"
    case .signaled(let name):
      return "signal \(name)"
    }
  }
}
