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
  @Published private(set) var selectedActivity = GhostteaSessionActivity.unknown
  @Published private(set) var frame: Data?
  @Published private(set) var presentationConfiguration: GhostteaTerminalPresentationConfig
  @Published private(set) var hasControl = false
  @Published private(set) var readWriteAllowed = false
  /// The §8.1 outage banner, or `nil` when the session needs no explanation.
  @Published private(set) var banner: GhostteaAttachmentBanner?
  /// A transient note that a keystroke was dropped (§4.3).
  @Published private(set) var inputCue: GhostteaAttachmentInputCue?
  @Published private var localStatus: String?
  @Published private var localBusy = false

  private let sharedRuntime: GhostteaSharedRuntimeModel
  let diagnostics: GhostteaDiagnosticRecorder
  let configuration: GhostteaConfigSnapshot
  private let sceneIdentity: GhostteaSceneTerminalIdentity
  private var runtimeObservation: AnyCancellable?
  private var selectedHost: GhostteaTruffleHostCandidate?
  /// The §3 state machine for the attached session. It owns the connection, the
  /// heartbeat, and every sequence space the wire orders; this model owns only
  /// the presentation of what it reports.
  private var lifecycle: GhostteaAttachmentLifecycle?
  private var pendingAttachmentTask: Task<Void, Never>?
  private var lifecycleTask: Task<Void, Never>?
  /// Wakes the banner when it would change without a new event — the grace
  /// window opening, a countdown ticking, the resumed flash closing.
  private var bannerRefreshTask: Task<Void, Never>?
  private var bannerPresenter: GhostteaAttachmentBannerPresenter?
  private let clock = GhostteaSystemClock()
  private var renderRuntime: GhostteaRuntime?
  private var nextSessionHandle: UInt64 = 1
  private var hasRequestedControl = false
  /// The lifecycle's own verdict on whether input would land, cached from the
  /// last snapshot so a gesture does not have to await the actor to be dropped.
  private var inputAccepted = false
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
    configuration: GhostteaConfigSnapshot,
    sceneID: UUID = UUID()
  ) {
    self.sharedRuntime = sharedRuntime
    self.diagnostics = diagnostics
    self.configuration = configuration
    presentationConfiguration = configuration.terminalPresentation
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
      do { renderRuntime = try GhostteaRuntime(config: configuration) } catch {
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
      renderRuntime != nil,
      !isBusy
    else { return }
    // The reconnect engine re-resolves the host on every dial, so it needs the
    // durable device id rather than the peer value discovery happened to see.
    guard let hostReference = selectedHost.persistentReference else {
      fail("This desktop has not confirmed its identity yet", code: .truffleAttachFailed)
      return
    }
    localBusy = true
    localStatus = "Attaching to \(session.title)…"
    pendingAttachmentTask?.cancel()
    pendingAttachmentTask = Task { [weak self] in
      guard let self else { return }
      await disconnectAttachment(clearSelection: false, cancelPending: false)
      do {
        let handle = nextSessionHandle
        nextSessionHandle = handle == UInt64.max ? 1 : handle + 1
        // The host opens every state stream with its presentation, so this
        // default only ever renders the gap before the first frame.
        let presentation = configuration.terminalPresentation
        let attachmentRuntime = try GhostteaRuntime(presentation: presentation)
        let localDeviceID = try await directory.localDeviceID()
        let sink = try GhostteaAttachmentReplicaSink(
          runtime: attachmentRuntime,
          sessionHandle: handle,
          presentation: presentation
        ) { [weak self] event in
          await self?.handle(event)
        }
        let engine = GhostteaAttachmentLifecycle(
          sessionID: session.sessionID,
          localViewID: terminalViewID,
          cols: grid.columns,
          rows: grid.rows,
          dialer: GhostteaTruffleAttachmentDialer(
            directory: directory, host: hostReference, localDeviceID: localDeviceID),
          sink: sink)
        guard !Task.isCancelled else {
          await engine.close()
          localBusy = false
          pendingAttachmentTask = nil
          return
        }
        renderRuntime = attachmentRuntime
        presentationConfiguration = presentation
        lifecycle = engine
        bannerPresenter = GhostteaAttachmentBannerPresenter(
          deviceName: selectedHost.displayName)
        selectedSession = session
        selectedActivity = session.activity
        readWriteAllowed = false
        frame = nil
        hasControl = false
        hasRequestedControl = false
        banner = nil
        inputCue = nil
        trace("opening \(session.sessionID) on \(selectedHost.displayName)")
        lifecycleTask = Task { [weak self] in
          for await event in await engine.events() {
            guard let self else { return }
            self.handle(event, from: engine)
          }
        }
        await engine.start()
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

  /// Retry, resume, browse, or close — whichever the current banner offered.
  func perform(_ action: GhostteaAttachmentBannerAction) {
    switch action {
    case .retryNow:
      guard let lifecycle else { return }
      Task { await lifecycle.retryNow() }
    case .resume:
      guard let lifecycle else { return }
      Task { await lifecycle.resumeFromForeground() }
    case .browseSessions:
      Task { [weak self] in
        guard let self else { return }
        await disconnectAttachment(clearSelection: false)
        selectedSession = nil
        if let selectedHost { loadSessions(from: selectedHost) }
      }
    case .close:
      disconnect()
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
    guard let lifecycle else { return }
    Task {
      // Recorded first so a resize typed during an outage still shapes the
      // attach that ends it, rather than being lost with the connection.
      await lifecycle.setViewport(cols: value.columns, rows: value.rows)
      do {
        if await lifecycle.heldControlEpoch == nil {
          try await lifecycle.claimControl(cols: value.columns, rows: value.rows)
        } else {
          try await lifecycle.resize(cols: value.columns, rows: value.rows)
        }
      } catch {
        // Control refusals are thrown to the caller and deliberately kept off
        // the event stream, so this is the only place they can become visible.
        note(error)
      }
    }
  }

  func handleHardwareKey(_ event: GhostteaHardwareKeyEvent) -> Bool {
    // Deliberately not gated on read-write or phase: the lifecycle rejects what
    // it must and says so, and a silent local drop would teach the user nothing
    // (§4.3).
    guard lifecycle != nil else { return false }
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
    sendGesture(
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
    sendGesture(.scroll(Int64(rows)))
  }

  func copySelection(_ selection: GhostteaTerminalSelection) {
    copy(
      GhostteaSelectionRequest(
        startColumn: selection.anchor.column,
        startRow: selection.anchor.row,
        endColumn: selection.focus.column,
        endRow: selection.focus.row),
      failure: "Copy failed")
  }

  func copyAll() {
    copy(GhostteaSelectionRequest(selectAll: true), failure: "Copy all failed")
  }

  func sceneChanged(_ scenePhase: ScenePhase) {
    switch scenePhase {
    case .active:
      record(.applicationBecameActive, severity: .info)
      guard let lifecycle else { return }
      Task {
        // §8.2: foreground dials immediately rather than waiting out a
        // schedule. A session that never suspended only wants a fresh frame.
        if case .suspended(.suspendedByApp) = await lifecycle.currentSnapshot.phase {
          await lifecycle.resumeFromForeground()
        } else {
          await lifecycle.requestSnapshot()
        }
      }
    case .background:
      record(.applicationEnteredBackground, severity: .info)
      // §8.2: an orderly suspend, not a connection left to rot — the heartbeat
      // stops, the compact connection closes, and the reason is recorded.
      guard let lifecycle else { return }
      Task { await lifecycle.suspendForBackground() }
    // Transient on iOS (the app switcher, a notification shade); suspending
    // here would tear the connection down every time a banner slid past.
    case .inactive: break
    @unknown default: break
    }
  }

  func requestFullRefresh() {
    guard let lifecycle else { return }
    Task { await lifecycle.requestSnapshot() }
  }

  func terminationRecorded() {
    Task { try? await diagnostics.markTerminationRecorded() }
  }

  private func send(_ operation: GhostteaTunnelInput) {
    guard let lifecycle else { return }
    // The throw is the lifecycle's private half of the §4.3 contract; the half
    // the user sees arrives as `.inputRejected` on the event stream, which
    // ``handle(_:from:)`` turns into the visible cue.
    Task { try? await lifecycle.send(operation) }
  }

  /// Pointer and scroll gestures, which are viewport-shaped rather than
  /// keystroke-shaped. §4.3's replay hazard is about typed input, and
  /// "keystrokes are not delivered" is the wrong sentence for a swipe — so
  /// these are dropped quietly rather than rejected loudly. They also arrive
  /// continuously, which would turn the cue into a strobe.
  private func sendGesture(_ operation: GhostteaTunnelInput) {
    guard inputAccepted else { return }
    send(operation)
  }

  private func copy(_ request: GhostteaSelectionRequest, failure: String) {
    guard let lifecycle else { return }
    Task {
      do {
        let text = try await lifecycle.selectionText(request)
        UIPasteboard.general.string = text
        localStatus = "Copied \(text.utf8.count) bytes"
      } catch {
        record(.truffleSelectionFailed)
        localStatus = failure
        // The status line is not on screen while a frame is, so the cue is the
        // only way a failed copy reaches someone looking at the terminal.
        note(error)
      }
    }
  }

  /// Surface a refusal the lifecycle threw rather than published. Keystroke
  /// rejections arrive on the event stream instead and must not come through
  /// here, or they would render twice.
  private func note(_ error: Error) {
    guard let rejection = error as? GhostteaAttachmentInputRejection else { return }
    bannerPresenter?.apply(.inputRejected(rejection), at: clock.nowMs)
    republishBanner()
  }

  /// One lifecycle transition, or one refusal (§3, §4.3).
  private func handle(
    _ event: GhostteaAttachmentLifecycleEvent,
    from engine: GhostteaAttachmentLifecycle
  ) {
    // A stream outlives the attachment it belongs to by however long the last
    // event takes to arrive; a superseded engine must not repaint the new one.
    guard lifecycle === engine else { return }
    bannerPresenter?.apply(event, at: clock.nowMs)
    if case .state(let snapshot) = event {
      readWriteAllowed = snapshot.readWrite
      inputAccepted = snapshot.acceptsInput
      switch snapshot.phase {
      case .live:
        claimControlOnFirstLive(engine)
      case .ended(let reason):
        trace("session \(snapshot.sessionID) ended: \(reason.rawValue)")
        // Only the endings nobody asked for are diagnostics. A process that
        // exited, a session someone closed, and a local disconnect are the
        // system working, and recording them as stream failures would bury the
        // real ones.
        switch reason {
        case .hostRestarted, .hostShutdown, .sessionUnavailable:
          record(.truffleStreamFailed)
        case .sessionExited, .sessionClosed, .closedLocally:
          break
        }
      case .opening, .synchronizing, .reconnecting, .suspended:
        break
      }
    }
    republishBanner()
  }

  /// Take resize control once, when the session first goes live. The attach
  /// path used to claim unconditionally; doing it again on every resume would
  /// be a takeover from whichever view holds it now, which §4.2.3 reserves for
  /// the focus-owning layer.
  private func claimControlOnFirstLive(_ engine: GhostteaAttachmentLifecycle) {
    guard readWriteAllowed, !hasRequestedControl else { return }
    hasRequestedControl = true
    let size = grid
    Task { try? await engine.claimControl(cols: size.columns, rows: size.rows) }
  }

  /// One applied frame, or one thing the frame said about the session.
  private func handle(_ event: GhostteaAttachmentSinkEvent) {
    switch event {
    case .frame(let update, _):
      if let rendered = update.effects.last(where: { $0.kind == .frameReady })?.payload {
        frame = rendered
      }
    case .controller:
      guard let lifecycle else { return }
      Task { [weak self] in
        // Asked rather than compared locally: against a legacy host the wire
        // view id rotates under the stable one this model knows, and only the
        // lifecycle knows which identity is currently attached.
        let held = await lifecycle.heldControlEpoch != nil
        guard let self, self.lifecycle === lifecycle else { return }
        hasControl = held
        localStatus = held ? "Read-write control" : "Read-only · another view has control"
      }
    case .activity(let activity):
      selectedActivity = activity
    case .presentation(let presentation):
      presentationConfiguration = presentation
    }
  }

  /// Recompute what the banner says now, and arm the next wake it needs.
  private func republishBanner() {
    bannerRefreshTask?.cancel()
    bannerRefreshTask = nil
    guard let bannerPresenter else {
      banner = nil
      inputCue = nil
      return
    }
    let now = clock.nowMs
    banner = bannerPresenter.banner(at: now)
    inputCue = bannerPresenter.inputCue(at: now)
    if let title = banner?.title { localStatus = title }
    guard let delay = bannerPresenter.nextRefreshMs(at: now) else { return }
    bannerRefreshTask = Task { [weak self] in
      try? await Task.sleep(nanoseconds: delay * 1_000_000)
      guard !Task.isCancelled else { return }
      self?.republishBanner()
    }
  }

  private func disconnectAttachment(
    clearSelection: Bool,
    cancelPending: Bool = true
  ) async {
    if cancelPending {
      pendingAttachmentTask?.cancel()
      pendingAttachmentTask = nil
    }
    lifecycleTask?.cancel()
    lifecycleTask = nil
    bannerRefreshTask?.cancel()
    bannerRefreshTask = nil
    let current = lifecycle
    lifecycle = nil
    bannerPresenter = nil
    banner = nil
    inputCue = nil
    await current?.close()
    frame = nil
    presentationConfiguration = configuration.terminalPresentation
    localBusy = false
    hasControl = false
    readWriteAllowed = false
    inputAccepted = false
    if clearSelection {
      selectedSession = nil
      selectedActivity = .unknown
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
