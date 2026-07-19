import Combine
import Foundation
import GhostteaCore
import GhostteaDiagnostics
import GhostteaTerminal
import GhostteaTruffle
import SwiftUI
import UIKit

@MainActor
final class GhostteaAppModel: ObservableObject {
  @Published private(set) var sessions: [GhostteaSharedSessionSummary] = []
  @Published private(set) var selectedHostName: String?
  @Published private(set) var selectedSession: GhostteaSharedSessionSummary?
  @Published private(set) var frame: Data?
  @Published private(set) var hasControl = false
  @Published private(set) var readWriteAllowed = false
  @Published private var localStatus: String?
  @Published private var localBusy = false

  private let sharedRuntime: GhostteaSharedRuntimeModel
  let diagnostics: GhostteaDiagnosticRecorder
  private let sceneIdentity: GhostteaSceneTerminalIdentity
  private var runtimeObservation: AnyCancellable?
  private var selectedHost: GhostteaTruffleHostCandidate?
  private var attachment: GhostteaTruffleAttachment?
  private var replicaPump: GhostteaTruffleReplicaPump?
  private var pendingAttachmentTask: Task<Void, Never>?
  private var attachmentTask: Task<Void, Never>?
  private var renderRuntime: GhostteaRuntime?
  private var nextSessionHandle: UInt64 = 1
  private var inputSequence: UInt64 = 0
  private var resizeSequence: UInt64 = 0
  private var claimSequence: UInt64 = 0
  private var controlEpoch: UInt64?
  private var grid = GhostteaTerminalGridSize(columns: 80, rows: 24)

  var phase: GhostteaTruffleRuntimePhase { sharedRuntime.phase }
  var status: String { localStatus ?? sharedRuntime.status }
  var hosts: [GhostteaTruffleHostCandidate] { sharedRuntime.hosts }
  var isBusy: Bool { localBusy || sharedRuntime.isBusy }
  var terminalViewID: String { sceneIdentity.viewID }
  var authPage: GhostteaLoginPage? {
    get { sharedRuntime.authPage }
    set { sharedRuntime.authPage = newValue }
  }

  init(
    sharedRuntime: GhostteaSharedRuntimeModel,
    diagnostics: GhostteaDiagnosticRecorder,
    sceneID: UUID = UUID()
  ) {
    self.sharedRuntime = sharedRuntime
    self.diagnostics = diagnostics
    sceneIdentity = GhostteaSceneTerminalIdentity(sceneID: sceneID)
    runtimeObservation = sharedRuntime.objectWillChange.sink { [weak self] _ in
      self?.objectWillChange.send()
    }
  }

  func start() {
    #if DEBUG
      if ProcessInfo.processInfo.environment["GHOSTTEA_AUTORUN_MULTISCENE"] == "1"
        || ghostteaAutomationDirectory() != nil
      {
        return
      }
    #endif
    if renderRuntime == nil {
      do { renderRuntime = try GhostteaRuntime() } catch {
        fail("Could not start terminal renderer", code: .rendererStartFailed)
        return
      }
    }
    sharedRuntime.start()
  }

  func stop() {
    Task {
      await disconnectAttachment(clearSelection: true)
      await sharedRuntime.stop()
      sessions = []
      localStatus = nil
    }
  }

  func loginSheetDismissed() {
    sharedRuntime.loginSheetDismissed()
  }

  func refreshHosts() async {
    await sharedRuntime.refreshHosts()
  }

  func loadSessions(from candidate: GhostteaTruffleHostCandidate) {
    guard let directory = sharedRuntime.directory, !isBusy else { return }
    localBusy = true
    selectedHost = candidate
    selectedHostName = candidate.displayName
    sessions = []
    localStatus = "Loading sessions from \(candidate.displayName)…"
    Task {
      do {
        let client = try await directory.connect(to: candidate)
        do {
          sessions = try await client.listSessions().filter(\.attachable)
          trace("host \(candidate.displayName) advertised \(sessions.count) attachable session(s)")
          await client.close()
        } catch {
          await client.close()
          throw error
        }
        localStatus =
          sessions.isEmpty
          ? "This host has no attachable sessions."
          : "Choose a desktop session"
        localBusy = false
      } catch {
        fail("Could not list shared sessions", code: .truffleSessionListFailed)
      }
    }
  }

  func attach(to session: GhostteaSharedSessionSummary) {
    guard
      let directory = sharedRuntime.directory,
      let selectedHost,
      let renderRuntime,
      !isBusy
    else { return }
    localBusy = true
    localStatus = "Attaching to \(session.title)…"
    pendingAttachmentTask?.cancel()
    pendingAttachmentTask = Task { [weak self] in
      guard let self else { return }
      await disconnectAttachment(clearSelection: false, cancelPending: false)
      do {
        let handle = nextSessionHandle
        nextSessionHandle = handle == UInt64.max ? 1 : handle + 1
        let attached = try await directory.attach(
          to: selectedHost,
          sessionID: session.sessionID,
          viewID: terminalViewID,
          cols: grid.columns,
          rows: grid.rows)
        guard !Task.isCancelled else {
          await attached.detach()
          localBusy = false
          pendingAttachmentTask = nil
          return
        }
        let pump = try GhostteaTruffleReplicaPump(
          attachment: attached,
          runtime: renderRuntime,
          sessionHandle: handle)
        let attachmentInfo = await attached.info
        attachment = attached
        replicaPump = pump
        selectedSession = session
        readWriteAllowed = attachmentInfo.readWrite
        frame = nil
        inputSequence = 0
        resizeSequence = 0
        claimSequence = 1
        controlEpoch = nil
        hasControl = false
        trace(
          "attached to \(session.sessionID); read-write=\(attachmentInfo.readWrite); "
            + "grid=\(attachmentInfo.cols)x\(attachmentInfo.rows)")
        attachmentTask = Task { [weak self] in
          do {
            while !Task.isCancelled {
              let event = try await pump.next()
              guard let self else { return }
              await self.handle(event, attachment: attached)
            }
          } catch is CancellationError {
          } catch {
            guard let self else { return }
            await self.attachmentFailed(error)
          }
        }
        if attachmentInfo.readWrite {
          try await attached.claimControl(
            cols: grid.columns, rows: grid.rows, sequence: claimSequence)
        }
        localStatus =
          attachmentInfo.readWrite
          ? "Attached · requesting keyboard control"
          : "Attached read-only"
        localBusy = false
        pendingAttachmentTask = nil
      } catch {
        pendingAttachmentTask = nil
        await disconnectAttachment(clearSelection: false, cancelPending: false)
        if Task.isCancelled || error is CancellationError {
          localBusy = false
          return
        }
        fail("Could not attach to session", code: .truffleAttachFailed)
      }
    }
  }

  func disconnect() {
    Task { await disconnectAttachment(clearSelection: true) }
  }

  func sceneDisconnected() {
    Task { await disconnectAttachment(clearSelection: true) }
  }

  func updateGrid(_ value: GhostteaTerminalGridSize) {
    guard value != grid else { return }
    grid = value
    guard let attachment, readWriteAllowed else { return }
    if let controlEpoch, hasControl {
      resizeSequence &+= 1
      let sequence = resizeSequence
      Task {
        try? await attachment.resize(
          cols: value.columns, rows: value.rows,
          controlEpoch: controlEpoch, sequence: sequence)
      }
    } else {
      claimSequence &+= 1
      let sequence = claimSequence
      Task {
        try? await attachment.claimControl(
          cols: value.columns, rows: value.rows, sequence: sequence)
      }
    }
  }

  func handleHardwareKey(_ event: GhostteaHardwareKeyEvent) -> Bool {
    guard attachment != nil, readWriteAllowed else { return false }
    let modifiers = event.modifiers
    let operation = GhostteaTunnelInput.key(
      GhostteaKeyInput(
        type: event.action == .up ? "up" : "down",
        key: event.text.isEmpty ? event.code : event.text,
        code: event.code,
        repeat: event.action == .repeated,
        shift: modifiers.contains(.shift),
        control: modifiers.contains(.control),
        alt: modifiers.contains(.option),
        meta: modifiers.contains(.command),
        unshiftedCodepoint: event.unshiftedCodepoint))
    send(operation)
    return true
  }

  func handleSoftwareInput(_ event: GhostteaSoftwareInputEvent) {
    switch event {
    case .text(let text): send(.text(text))
    case .enter: send(.text("\r"))
    case .deleteBackward:
      send(
        .key(
          GhostteaKeyInput(
            type: "down", key: "Backspace", code: "Backspace", repeat: false,
            shift: false, control: false, alt: false, meta: false,
            unshiftedCodepoint: 0)))
    case .paste(let text): send(.paste(text))
    case .key(let key): _ = handleHardwareKey(key)
    }
  }

  func handleMouse(_ event: GhostteaTerminalMouseEvent) {
    let modifiers = event.modifiers
    let action: String
    switch event.action {
    case .press: action = "press"
    case .release: action = "release"
    case .motion: action = "motion"
    }
    send(
      .mouse(
        GhostteaMouseInput(
          action: action, button: event.button.rawValue, x: event.x, y: event.y,
          screenWidth: event.screenWidth, screenHeight: event.screenHeight,
          cellWidth: event.cellWidth, cellHeight: event.cellHeight,
          paddingLeft: event.paddingLeft, paddingTop: event.paddingTop,
          shift: modifiers.contains(.shift), control: modifiers.contains(.control),
          alt: modifiers.contains(.option), meta: modifiers.contains(.command))))
  }

  func handleScroll(_ rows: Int) {
    guard rows != 0 else { return }
    send(.scroll(Int64(rows)))
  }

  func copySelection(_ selection: GhostteaTerminalSelection) {
    guard let attachment else { return }
    Task {
      do {
        _ = try await attachment.requestSelectionText(
          GhostteaSelectionRequest(
            startColumn: selection.anchor.column,
            startRow: selection.anchor.row,
            endColumn: selection.focus.column,
            endRow: selection.focus.row))
      } catch {
        record(.truffleSelectionFailed)
        localStatus = "Copy failed"
      }
    }
  }

  func copyAll() {
    guard let attachment else { return }
    Task {
      do {
        _ = try await attachment.requestSelectionText(
          GhostteaSelectionRequest(selectAll: true))
      } catch {
        record(.truffleSelectionFailed)
        localStatus = "Copy all failed"
      }
    }
  }

  func sceneChanged(_ scenePhase: ScenePhase) {
    switch scenePhase {
    case .active: record(.applicationBecameActive, severity: .info)
    case .background: record(.applicationEnteredBackground, severity: .info)
    case .inactive: break
    @unknown default: break
    }
    guard scenePhase == .active, attachment != nil else { return }
    Task { try? await attachment?.requestSnapshot() }
  }

  func requestFullRefresh() {
    guard attachment != nil else { return }
    Task { try? await attachment?.requestSnapshot() }
  }

  func terminationRecorded() {
    Task { try? await diagnostics.markTerminationRecorded() }
  }

  private func send(_ operation: GhostteaTunnelInput) {
    guard let attachment, readWriteAllowed else { return }
    inputSequence &+= 1
    let sequence = inputSequence
    Task {
      do { try await attachment.send(operation, sequence: sequence) } catch {
        record(.truffleInputFailed)
        localStatus = "Input failed"
      }
    }
  }

  private func handle(
    _ event: GhostteaRenderedAttachmentEvent,
    attachment expectedAttachment: GhostteaTruffleAttachment
  ) async {
    guard attachment === expectedAttachment else { return }
    switch event {
    case .frame(let update, _):
      if let rendered = update.effects.last(where: { $0.kind == .frameReady })?.payload {
        frame = rendered
      }
    case .controlChanged(let controller, let epoch, let cols, let rows, _):
      controlEpoch = epoch
      hasControl = controller == (await expectedAttachment.viewID)
      grid = GhostteaTerminalGridSize(columns: cols, rows: rows)
      localStatus = hasControl ? "Read-write control" : "Read-only · another view has control"
    case .selectionText(_, let text):
      UIPasteboard.general.string = text
      localStatus = "Copied \(text.utf8.count) bytes"
    case .resynchronizing:
      localStatus = "Resynchronizing terminal state…"
    }
  }

  private func attachmentFailed(_: Error) async {
    record(.truffleStreamFailed)
    trace("shared-session attachment failed")
    localStatus = "Shared session ended"
    await disconnectAttachment(clearSelection: false)
  }

  private func disconnectAttachment(
    clearSelection: Bool,
    cancelPending: Bool = true
  ) async {
    if cancelPending {
      pendingAttachmentTask?.cancel()
      pendingAttachmentTask = nil
    }
    attachmentTask?.cancel()
    attachmentTask = nil
    let current = attachment
    attachment = nil
    replicaPump = nil
    await current?.detach()
    frame = nil
    localBusy = false
    hasControl = false
    readWriteAllowed = false
    controlEpoch = nil
    if clearSelection {
      selectedSession = nil
      selectedHost = nil
      selectedHostName = nil
      sessions = []
      localStatus = phase == .running ? "Choose a Ghosttea desktop" : nil
    }
  }

  private func fail(_ message: String, code: GhostteaDiagnosticCode) {
    record(code)
    trace(message)
    localBusy = false
    localStatus = message
  }

  private func record(
    _ code: GhostteaDiagnosticCode,
    severity: GhostteaDiagnosticSeverity = .error
  ) {
    Task { try? await diagnostics.record(code, severity: severity) }
  }

  private func trace(_ message: String) {
    #if DEBUG
      print("[Ghosttea] \(message)")
    #endif
  }

}
