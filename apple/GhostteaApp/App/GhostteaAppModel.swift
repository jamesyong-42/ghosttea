import Foundation
import GhostteaCore
import GhostteaTerminal
import GhostteaTruffle
import SwiftUI
import UIKit

struct GhostteaLoginPage: Identifiable {
  let url: URL
  var id: String { url.absoluteString }
}

@MainActor
final class GhostteaAppModel: ObservableObject {
  @Published private(set) var phase: GhostteaTruffleRuntimePhase = .stopped
  @Published private(set) var status = "Starting Ghosttea…"
  @Published private(set) var hosts: [GhostteaTruffleHostCandidate] = []
  @Published private(set) var sessions: [GhostteaSharedSessionSummary] = []
  @Published private(set) var selectedHostName: String?
  @Published private(set) var selectedSession: GhostteaSharedSessionSummary?
  @Published private(set) var frame: Data?
  @Published private(set) var hasControl = false
  @Published private(set) var readWriteAllowed = false
  @Published var authPage: GhostteaLoginPage?
  @Published private(set) var isBusy = false

  private var mesh: GhostteaTruffleRuntime?
  private var directory: GhostteaTrufflePeerDirectory?
  private var selectedHost: GhostteaTruffleHostCandidate?
  private var attachment: GhostteaTruffleAttachment?
  private var replicaPump: GhostteaTruffleReplicaPump?
  private var eventTask: Task<Void, Never>?
  private var attachmentTask: Task<Void, Never>?
  private var renderRuntime: GhostteaRuntime?
  private var nextSessionHandle: UInt64 = 1
  private var inputSequence: UInt64 = 0
  private var resizeSequence: UInt64 = 0
  private var claimSequence: UInt64 = 0
  private var controlEpoch: UInt64?
  private var grid = GhostteaTerminalGridSize(columns: 80, rows: 24)

  func start() {
    guard mesh == nil, !isBusy else { return }
    isBusy = true
    status = "Starting private mesh…"
    phase = .starting
    Task {
      do {
        if renderRuntime == nil { renderRuntime = try GhostteaRuntime() }
        let runtime = try await GhostteaTruffleRuntime.start(
          deviceName: UIDevice.current.name,
          onAuthRequired: { [weak self] url in
            self?.authPage = GhostteaLoginPage(url: url)
          })
        mesh = runtime
        directory = await runtime.directory
        let events = await runtime.events()
        eventTask = Task { [weak self] in
          for await event in events {
            guard let self else { return }
            await self.handle(event)
          }
        }
        phase = await runtime.phase
        isBusy = false
        await refreshHosts()
      } catch {
        fail("Could not start Truffle: \(error)")
      }
    }
  }

  func stop() {
    let runtime = mesh
    Task {
      await disconnectAttachment(clearSelection: true)
      eventTask?.cancel()
      eventTask = nil
      await runtime?.stop()
      mesh = nil
      directory = nil
      hosts = []
      sessions = []
      phase = .stopped
      status = "Disconnected"
    }
  }

  func loginSheetDismissed() {
    authPage = nil
    Task {
      do { try await mesh?.refresh() }
      catch { status = "Login refresh failed: \(error)" }
    }
  }

  func refreshHosts() async {
    guard let mesh else { return }
    hosts = await mesh.candidates()
    if phase == .running {
      status = hosts.isEmpty
        ? "Connected. Start the Ghosttea desktop demo to share a session."
        : "\(hosts.count) Ghosttea host\(hosts.count == 1 ? "" : "s") available"
    }
  }

  func loadSessions(from candidate: GhostteaTruffleHostCandidate) {
    guard let directory, !isBusy else { return }
    isBusy = true
    selectedHost = candidate
    selectedHostName = candidate.displayName
    sessions = []
    status = "Loading sessions from \(candidate.displayName)…"
    Task {
      do {
        let client = try await directory.connect(to: candidate)
        do {
          sessions = try await client.listSessions().filter(\.attachable)
          await client.close()
        } catch {
          await client.close()
          throw error
        }
        status = sessions.isEmpty
          ? "This host has no attachable sessions."
          : "Choose a desktop session"
        isBusy = false
      } catch {
        fail("Could not list shared sessions: \(error)")
      }
    }
  }

  func attach(to session: GhostteaSharedSessionSummary) {
    guard let directory, let selectedHost, let renderRuntime, !isBusy else { return }
    isBusy = true
    status = "Attaching to \(session.title)…"
    Task {
      await disconnectAttachment(clearSelection: false)
      do {
        let handle = nextSessionHandle
        nextSessionHandle = handle == UInt64.max ? 1 : handle + 1
        let attached = try await directory.attach(
          to: selectedHost,
          sessionID: session.sessionID,
          cols: grid.columns,
          rows: grid.rows)
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
        status = attachmentInfo.readWrite
          ? "Attached · requesting keyboard control"
          : "Attached read-only"
        isBusy = false
      } catch {
        fail("Could not attach to session: \(error)")
      }
    }
  }

  func disconnect() {
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
      } catch { status = "Copy failed: \(error)" }
    }
  }

  func copyAll() {
    guard let attachment else { return }
    Task {
      do {
        _ = try await attachment.requestSelectionText(
          GhostteaSelectionRequest(selectAll: true))
      } catch { status = "Copy all failed: \(error)" }
    }
  }

  func sceneChanged(_ scenePhase: ScenePhase) {
    guard scenePhase == .active, attachment != nil else { return }
    Task { try? await attachment?.requestSnapshot() }
  }

  private func send(_ operation: GhostteaTunnelInput) {
    guard let attachment, readWriteAllowed else { return }
    inputSequence &+= 1
    let sequence = inputSequence
    Task {
      do { try await attachment.send(operation, sequence: sequence) }
      catch { status = "Input failed: \(error)" }
    }
  }

  private func handle(_ event: GhostteaTruffleRuntimeEvent) async {
    switch event {
    case .phase(let newPhase):
      phase = newPhase
      switch newPhase {
      case .running:
        authPage = nil
        await refreshHosts()
      case .needsLogin: status = "Sign in to Tailscale to find your desktop"
      case .needsMachineAuth: status = "Waiting for Tailscale device approval"
      case .starting: status = "Connecting private mesh…"
      case .failed: status = "The private mesh stopped unexpectedly"
      case .stopping, .stopped: status = "Disconnected"
      }
    case .authRequired(let url):
      authPage = GhostteaLoginPage(url: url)
    case .peersChanged:
      await refreshHosts()
    case .health(let message):
      status = message
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
      status = hasControl ? "Read-write control" : "Read-only · another view has control"
    case .selectionText(_, let text):
      UIPasteboard.general.string = text
      status = "Copied \(text.utf8.count) bytes"
    case .resynchronizing:
      status = "Resynchronizing terminal state…"
    }
  }

  private func attachmentFailed(_ error: Error) async {
    status = "Shared session ended: \(error)"
    await disconnectAttachment(clearSelection: false)
  }

  private func disconnectAttachment(clearSelection: Bool) async {
    attachmentTask?.cancel()
    attachmentTask = nil
    let current = attachment
    attachment = nil
    replicaPump = nil
    await current?.detach()
    frame = nil
    hasControl = false
    readWriteAllowed = false
    controlEpoch = nil
    if clearSelection {
      selectedSession = nil
      selectedHost = nil
      selectedHostName = nil
      sessions = []
      status = phase == .running ? "Choose a Ghosttea desktop" : status
    }
  }

  private func fail(_ message: String) {
    isBusy = false
    status = message
    if mesh == nil { phase = .failed }
  }
}
