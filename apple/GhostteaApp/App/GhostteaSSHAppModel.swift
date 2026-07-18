import Foundation
import GhostteaConnectionProfiles
import GhostteaCore
import GhostteaCredentials
import GhostteaDiagnostics
import GhostteaSSH
import GhostteaSSHWorkspace
import GhostteaSession
import GhostteaTerminal
import GhostteaTransport
import GhostteaWorkspace
import SwiftUI
import UIKit

struct GhostteaPendingHostKey: Identifiable {
  let id = UUID()
  let challenge: GhostteaSSHHostKeyChallenge
}

struct GhostteaPendingKeyboardChallenge: Identifiable {
  let id = UUID()
  let challenge: GhostteaSSHKeyboardInteractiveChallenge
}

@MainActor
final class GhostteaSSHAppModel: ObservableObject {
  @Published private(set) var profiles: [GhostteaSSHConnectionProfile] = []
  @Published private(set) var workspace: GhostteaWorkspaceTabsDocument?
  @Published private(set) var frames: [String: Data] = [:]
  @Published private(set) var sessionStatuses: [String: String] = [:]
  @Published private(set) var status = "Loading saved connections…"
  @Published private(set) var isBusy = false
  @Published var presentsProfileManager = false
  @Published var presentsCommandPalette = false
  @Published var pendingHostKey: GhostteaPendingHostKey?
  @Published var pendingKeyboardChallenge: GhostteaPendingKeyboardChallenge?

  private var runtime: GhostteaRuntime?
  private let diagnostics: GhostteaDiagnosticRecorder
  private var factory: GhostteaSSHWorkspaceSessionFactory?
  private var coordinator: GhostteaWorkspaceSessionCoordinator<GhostteaSSHWorkspaceSession>?
  private var repository: GhostteaSSHConnectionProfileRepository?
  private var credentialStore: KeychainSSHCredentialStore?
  private var restorationStore: GhostteaWorkspaceRestorationStore?
  private var sessionProfileIDs: [String: String] = [:]
  private var grids: [String: GhostteaTerminalGridSize] = [:]
  private var layoutEpochs: [String: UInt64] = [:]
  private var shortcutState = GhostteaWorkspaceShortcutState()
  private var requestedProfileID: String?
  private var networkTask: Task<Void, Never>?
  private var networkPath = TerminalNetworkPath.unknown
  private var hostKeyContinuation: CheckedContinuation<GhostteaSSHHostKeyDecision, Never>?
  private var keyboardContinuation: CheckedContinuation<[String], Error>?
  private var nextFactoryHandle: UInt64 = 10_000
  private var started = false

  init(diagnostics: GhostteaDiagnosticRecorder) {
    self.diagnostics = diagnostics
  }

  var selectedSessionID: String? {
    guard
      let workspace,
      let tab = workspace.tabs.first(where: { $0.id == workspace.selectedTabID })
    else { return nil }
    return tab.workspace.root.panes
      .first(where: { $0.id == tab.workspace.activePaneID })?.sessionID
  }

  var commandPaletteEntries: [GhostteaWorkspacePaletteEntry] {
    profiles.map { profile in
      GhostteaWorkspacePaletteEntry.connectionProfile(
        profileID: profile.id.uuidString.lowercased(),
        name: profile.name,
        subtitle: "\(profile.username)@\(profile.host):\(profile.port)",
        keywords: ["ssh", "remote", profile.host, profile.username])
    } + [.manageConnectionProfiles()] + GhostteaWorkspacePaletteEntry.workspaceCommands()
  }

  func start() {
    guard !started else { return }
    started = true
    networkTask = Task { [weak self] in
      for await path in AppleTerminalNetworkPathMonitor().updates() {
        guard let self else { return }
        await self.networkChanged(path)
      }
    }
    Task {
      do {
        let store = try KeychainSSHCredentialStore()
        let root = try applicationSupportRoot()
        let profileStore = GhostteaSSHConnectionProfileStore(
          fileURL: root.appendingPathComponent("ssh-profiles.json"))
        let repository = GhostteaSSHConnectionProfileRepository(
          profileStore: profileStore,
          credentialVault: store)
        let restorationStore = GhostteaWorkspaceRestorationStore(
          fileURL: root.appendingPathComponent("ssh-workspace.json"))
        credentialStore = store
        self.repository = repository
        self.restorationStore = restorationStore
        profiles = try await repository.load()
        if try await restoreWorkspace() { return }
        status = profiles.isEmpty ? "Add an SSH connection to begin." : "Choose a saved connection"
      } catch {
        record(.sshRepositoryLoadFailed)
        status = "Could not load saved connections"
      }
    }
  }

  func connect(_ profile: GhostteaSSHConnectionProfile) {
    guard !isBusy else { return }
    isBusy = true
    status = "Preparing \(profile.name)…"
    Task {
      await disconnectWorkspace(clearPersistence: true)
      do {
        let runtime = try self.runtime ?? GhostteaRuntime()
        self.runtime = runtime
        let factory = try makeFactory(runtime: runtime, defaultProfile: profile)
        let allocation = try await factory.allocate(.newTab)
        let paneID = identity("pane")
        let tabID = identity("tab")
        let pane = GhostteaWorkspacePane(id: paneID, sessionID: allocation.sessionID)
        let terminal = try GhostteaWorkspaceDocument(root: .pane(pane), activePaneID: paneID)
        let document = try GhostteaWorkspaceTabsDocument(
          selectedTabID: tabID,
          tabs: [GhostteaWorkspaceTab(id: tabID, workspace: terminal)])

        sessionProfileIDs[allocation.sessionID] = profile.id.uuidString.lowercased()
        grids[allocation.sessionID] = GhostteaTerminalGridSize(
          columns: UInt16(profile.columns), rows: UInt16(profile.rows))
        sessionStatuses[allocation.sessionID] = "Connecting…"
        self.factory = factory
        coordinator = try makeCoordinator(
          document: document,
          sessions: [allocation.sessionID: allocation.session],
          factory: factory)
        workspace = document
        status = "Workspace ready"
        isBusy = false
        try await persistWorkspace()
      } catch {
        isBusy = false
        record(.sshConnectFailed)
        status = GhostteaSSHFailurePolicy.description(error)
      }
    }
  }

  func createTab(profileID: String? = nil) {
    guard let coordinator, !isBusy else { return }
    isBusy = true
    requestedProfileID = profileID
    Task {
      defer {
        requestedProfileID = nil
        isBusy = false
      }
      do {
        let transition = try await coordinator.createTab()
        workspace = transition.document
        try await persistWorkspace()
      } catch {
        record(.sshTabCreateFailed)
        status = "Could not create tab"
      }
    }
  }

  func split(_ axis: GhostteaWorkspaceSplitAxis) {
    guard let coordinator, !isBusy else { return }
    isBusy = true
    Task {
      do {
        let transition = try await coordinator.splitSelected(axis: axis)
        workspace = transition.document
        try await persistWorkspace()
      } catch {
        record(.sshSplitFailed)
        status = "Could not split terminal"
      }
      isBusy = false
    }
  }

  func apply(_ action: GhostteaWorkspaceTabsAction) {
    guard let coordinator else { return }
    Task {
      do {
        let transition = try await coordinator.apply(action)
        if transition.shouldCloseWindow {
          await disconnectWorkspace(clearPersistence: true)
          return
        }
        workspace = transition.document
        try await persistWorkspace()
      } catch {
        record(.sshWorkspaceUpdateFailed)
        status = "Workspace update failed"
      }
    }
  }

  func invoke(_ invocation: GhostteaWorkspacePaletteInvocation) {
    switch invocation {
    case .connectionProfile(let profileID):
      createTab(profileID: profileID)
    case .manageConnectionProfiles:
      presentsProfileManager = true
    case .command(let command):
      route(command)
    }
  }

  func reconnect(_ sessionID: String? = nil) {
    guard let coordinator else { return }
    let target = sessionID ?? selectedSessionID
    guard let target else { return }
    sessionStatuses[target] = "Connecting…"
    Task {
      guard let resource = await coordinator.session(for: target) else { return }
      await resource.session.requestConnect()
    }
  }

  func disconnect() {
    Task { await disconnectWorkspace(clearPersistence: true) }
  }

  func saveProfile(_ request: GhostteaSSHConnectionProfileSaveRequest) {
    guard let repository else { return }
    Task {
      do {
        let mutation = try await repository.save(request)
        profiles = try await repository.load()
        status =
          mutation.credentialCleanupFailures.isEmpty
          ? "Saved connection"
          : "Saved connection; credential cleanup will be retried"
      } catch {
        record(.sshProfileSaveFailed)
        status = "Could not save connection"
      }
    }
  }

  func deleteProfile(_ id: UUID) {
    guard let repository else { return }
    Task {
      do {
        let profileID = id.uuidString.lowercased()
        if sessionProfileIDs.values.contains(profileID) {
          await disconnectWorkspace(clearPersistence: true)
        }
        _ = try await repository.delete(profileID: id)
        profiles = try await repository.load()
        status = profiles.isEmpty ? "Add an SSH connection to begin." : "Deleted connection"
      } catch {
        record(.sshProfileDeleteFailed)
        status = "Could not delete connection"
      }
    }
  }

  func resolveHostKey(_ decision: GhostteaSSHHostKeyDecision) {
    let continuation = hostKeyContinuation
    hostKeyContinuation = nil
    pendingHostKey = nil
    continuation?.resume(returning: decision)
  }

  func resolveKeyboardChallenge(_ responses: [String]) {
    let continuation = keyboardContinuation
    keyboardContinuation = nil
    pendingKeyboardChallenge = nil
    continuation?.resume(returning: responses)
  }

  func cancelKeyboardChallenge() {
    let continuation = keyboardContinuation
    keyboardContinuation = nil
    pendingKeyboardChallenge = nil
    continuation?.resume(throwing: CancellationError())
  }

  func frame(for sessionID: String) -> Data? { frames[sessionID] }

  func sessionStatus(for sessionID: String) -> String {
    sessionStatuses[sessionID] ?? "Reconnect available"
  }

  func title(for sessionID: String) -> String {
    guard
      let profileID = sessionProfileIDs[sessionID],
      let profile = profiles.first(where: { $0.id.uuidString.lowercased() == profileID })
    else { return "Terminal" }
    return profile.name
  }

  func updateGrid(_ value: GhostteaTerminalGridSize, sessionID: String) {
    guard value != grids[sessionID], let coordinator else { return }
    grids[sessionID] = value
    let epoch = (layoutEpochs[sessionID] ?? 0) &+ 1
    layoutEpochs[sessionID] = epoch
    Task {
      guard let resource = await coordinator.session(for: sessionID) else { return }
      try? await resource.session.resize(
        columns: Int(value.columns), rows: Int(value.rows), layoutEpoch: epoch)
    }
  }

  func handleHardwareKey(_ event: GhostteaHardwareKeyEvent, sessionID: String) -> Bool {
    guard coordinator != nil else { return false }
    let modifiers = event.modifiers
    let chord = GhostteaWorkspaceKeyChord(
      domCode: event.code,
      command: modifiers.contains(.command),
      shift: modifiers.contains(.shift),
      option: modifiers.contains(.option),
      control: modifiers.contains(.control))
    let phase: GhostteaWorkspaceKeyPhase
    switch event.action {
    case .down: phase = .down
    case .repeated: phase = .repeated
    case .up: phase = .up
    }
    let shortcut = shortcutState.handle(
      usage: event.hidUsage,
      phase: phase,
      chord: chord)
    if let command = shortcut.command { route(command) }
    if shortcut.handled { return true }
    guard !modifiers.contains(.command) else { return false }
    withSession(sessionID) { try? await $0.session.sendKey(event.coreEvent) }
    return true
  }

  func handleSoftwareInput(_ event: GhostteaSoftwareInputEvent, sessionID: String) {
    withSession(sessionID) { resource in
      switch event {
      case .text(let text): try await resource.session.send(Data(text.utf8))
      case .enter: try await resource.session.sendKey(Self.softwareKey(hidUsage: 0x28))
      case .deleteBackward:
        try await resource.session.sendKey(Self.softwareKey(hidUsage: 0x2a))
      case .paste(let text): try await resource.session.sendPaste(text)
      case .key(let key): try await resource.session.sendKey(key.coreEvent)
      }
    }
  }

  func handleMouse(_ event: GhostteaTerminalMouseEvent, sessionID: String) {
    withSession(sessionID) { try? await $0.session.sendMouse(event.coreEvent) }
  }

  func handleScroll(_ rows: Int, sessionID: String) {
    guard rows != 0 else { return }
    withSession(sessionID) { try? await $0.session.scroll(rows: Int64(rows)) }
  }

  func requestFullRefresh(sessionID: String) {
    withSession(sessionID) { try? await $0.session.refresh() }
  }

  func copySelection(_ selection: GhostteaTerminalSelection, sessionID: String) {
    withSession(sessionID) { resource in
      let data = try await resource.terminal.selectionTextBytes(
        startColumn: selection.anchor.column,
        startRow: selection.anchor.row,
        endColumn: selection.focus.column,
        endRow: selection.focus.row)
      await MainActor.run {
        UIPasteboard.general.string = String(decoding: data, as: UTF8.self)
      }
    }
  }

  func copyAll(sessionID: String) {
    withSession(sessionID) { resource in
      let data = try await resource.terminal.selectionTextBytes(
        startColumn: 0, startRow: 0, endColumn: 0, endRow: 0, selectAll: true)
      await MainActor.run {
        UIPasteboard.general.string = String(decoding: data, as: UTF8.self)
      }
    }
  }

  func sceneChanged(_ phase: ScenePhase) {
    guard coordinator != nil else { return }
    Task {
      await forEachSession { resource in
        switch phase {
        case .active: await resource.session.becameActive()
        case .background: await resource.session.enteredBackground()
        case .inactive: break
        @unknown default: break
        }
      }
    }
  }

  private func restoreWorkspace() async throws -> Bool {
    guard
      let restorationStore,
      let credentialStore,
      let persisted = try await restorationStore.load()
    else { return false }
    guard
      let defaultBinding = persisted.sessionProfiles.first,
      let defaultProfile = profile(id: defaultBinding.profileID)
    else {
      try await restorationStore.remove()
      return false
    }

    let runtime = try self.runtime ?? GhostteaRuntime()
    self.runtime = runtime
    let factory = try makeFactory(runtime: runtime, defaultProfile: defaultProfile)
    let result = try await factory.restore(
      persisted,
      profiles: profiles,
      knownHostsPath: try GhostteaSSHKnownHostsFile().prepare(),
      hostKeyPolicy: hostKeyPolicy(),
      credentialStore: credentialStore,
      keyboardInteractiveResponder: keyboardInteractiveResponder(),
      connect: false)
    guard let document = result.document else {
      try await restorationStore.remove()
      return false
    }

    let liveIDs = Set(result.sessions.keys)
    sessionProfileIDs = persisted.profileIDBySessionID.filter { liveIDs.contains($0.key) }
    for (sessionID, resource) in result.sessions {
      let restoredProfile = resource.profileID.flatMap { profile(id: $0) } ?? defaultProfile
      grids[sessionID] = GhostteaTerminalGridSize(
        columns: UInt16(restoredProfile.columns),
        rows: UInt16(restoredProfile.rows))
      sessionStatuses[sessionID] = "Reconnect available"
    }
    self.factory = factory
    coordinator = try makeCoordinator(
      document: document, sessions: result.sessions, factory: factory)
    workspace = document
    status =
      result.unavailableSessionIDs.isEmpty
      ? "Workspace restored · reconnect when ready"
      : "Workspace restored; \(result.unavailableSessionIDs.count) unavailable pane(s) removed"
    try await persistWorkspace()
    return true
  }

  private func makeFactory(
    runtime: GhostteaRuntime,
    defaultProfile: GhostteaSSHConnectionProfile
  ) throws -> GhostteaSSHWorkspaceSessionFactory {
    let initialHandle = nextFactoryHandle
    nextFactoryHandle = initialHandle > UInt64.max - 10_000 ? 10_000 : initialHandle + 10_000
    return try GhostteaSSHWorkspaceSessionFactory(
      runtime: runtime,
      ssh: try configuration(for: defaultProfile),
      profileID: defaultProfile.id.uuidString.lowercased(),
      sessionConfiguration: .ssh(initialPath: networkPath),
      initialSessionHandle: initialHandle,
      eventHandler: { [weak self] event in await self?.handle(event) })
  }

  private func makeCoordinator(
    document: GhostteaWorkspaceTabsDocument,
    sessions: [String: GhostteaSSHWorkspaceSession],
    factory: GhostteaSSHWorkspaceSessionFactory
  ) throws -> GhostteaWorkspaceSessionCoordinator<GhostteaSSHWorkspaceSession> {
    try GhostteaWorkspaceSessionCoordinator(
      document: document,
      sessions: sessions,
      allocator: { [weak self, factory] request in
        guard let self else { throw GhostteaSSHAppError.notReady }
        return try await self.allocate(request, factory: factory)
      },
      terminator: { [weak self] sessionID, resource in
        await GhostteaSSHWorkspaceSessionFactory.disconnect(resource)
        await self?.sessionTerminated(sessionID)
      })
  }

  private func allocate(
    _ request: GhostteaWorkspaceSessionRequest,
    factory: GhostteaSSHWorkspaceSessionFactory
  ) async throws -> GhostteaWorkspaceSessionAllocation<GhostteaSSHWorkspaceSession> {
    guard let profile = profileForAllocation(request, requestedProfileID: requestedProfileID) else {
      throw GhostteaSSHAppError.missingProfile
    }
    let profileID = profile.id.uuidString.lowercased()
    let allocation = try await factory.allocate(
      request,
      ssh: try configuration(for: profile),
      sessionID: nil,
      profileID: profileID,
      connect: true)
    sessionProfileIDs[allocation.sessionID] = profileID
    grids[allocation.sessionID] = GhostteaTerminalGridSize(
      columns: UInt16(profile.columns), rows: UInt16(profile.rows))
    sessionStatuses[allocation.sessionID] = "Connecting…"
    return allocation
  }

  private func configuration(
    for profile: GhostteaSSHConnectionProfile
  ) throws -> GhostteaSSHConfiguration {
    guard let credentialStore else { throw GhostteaSSHAppError.notReady }
    return try profile.configuration(
      knownHostsPath: try GhostteaSSHKnownHostsFile().prepare(),
      hostKeyPolicy: hostKeyPolicy(),
      credentialStore: credentialStore,
      keyboardInteractiveResponder: keyboardInteractiveResponder())
  }

  private func hostKeyPolicy() -> GhostteaSSHHostKeyPolicy {
    .ask { [weak self] challenge in
      guard let self else { return .reject }
      return await self.requestHostKeyDecision(challenge)
    }
  }

  private func keyboardInteractiveResponder() -> GhostteaSSHKeyboardInteractiveResponder {
    { [weak self] challenge in
      guard let self else { throw CancellationError() }
      return try await self.requestKeyboardResponses(challenge)
    }
  }

  private func profileForAllocation(
    _ request: GhostteaWorkspaceSessionRequest,
    requestedProfileID: String?
  ) -> GhostteaSSHConnectionProfile? {
    if case .newTab = request,
      let requestedProfileID,
      let requested = profile(id: requestedProfileID)
    {
      return requested
    }
    let sourceID: String?
    switch request {
    case .newTab: sourceID = selectedSessionID
    case .split(_, let sourceSessionID): sourceID = sourceSessionID
    }
    if let sourceID, let profileID = sessionProfileIDs[sourceID],
      let profile = profile(id: profileID)
    {
      return profile
    }
    return profiles.first
  }

  private func profile(id: String) -> GhostteaSSHConnectionProfile? {
    profiles.first { $0.id.uuidString.lowercased() == id.lowercased() }
  }

  private func route(_ command: GhostteaWorkspaceCommand) {
    guard let workspace, let route = command.route(in: workspace) else { return }
    switch route {
    case .reducer(let action): apply(action)
    case .requestNewTab: createTab()
    case .requestSplit(let axis): split(axis)
    case .openRemoteSessions: presentsCommandPalette = true
    }
  }

  private func persistWorkspace() async throws {
    guard let workspace, let restorationStore else { return }
    let document = try GhostteaWorkspaceRestorationDocument(
      workspace: workspace,
      sessionProfiles: workspace.sessionIDs.compactMap { sessionID in
        sessionProfileIDs[sessionID].map {
          GhostteaWorkspaceSessionProfileBinding(sessionID: sessionID, profileID: $0)
        }
      })
    try await restorationStore.save(document)
  }

  private func networkChanged(_ path: TerminalNetworkPath) async {
    networkPath = path
    await forEachSession { await $0.session.updateNetworkPath(path) }
  }

  private func handle(_ routed: GhostteaSSHWorkspaceSessionEvent) async {
    let sessionID = routed.sessionID
    switch routed.event {
    case .stateChanged(let snapshot):
      switch snapshot.reconnectState {
      case .idle:
        sessionStatuses[sessionID] =
          snapshot.lastExitStatus.map(Self.exitDescription) ?? "Disconnected"
      case .waitingForNetwork: sessionStatuses[sessionID] = "Waiting for network"
      case .connecting: sessionStatuses[sessionID] = "Connecting…"
      case .connected: sessionStatuses[sessionID] = "Connected"
      case .reconnectAvailable: sessionStatuses[sessionID] = "Reconnect available"
      case .suspended: sessionStatuses[sessionID] = "Suspended"
      case .failed: sessionStatuses[sessionID] = snapshot.lastFailure?.message ?? "SSH failed"
      }
    case .frameReady(let value): frames[sessionID] = value
    case .clipboardWrite(let data):
      UIPasteboard.general.string = String(decoding: data, as: UTF8.self)
    case .bell: sessionStatuses[sessionID] = "Bell"
    case .logicalSnapshot, .metadataChanged: break
    }
  }

  private func disconnectWorkspace(clearPersistence: Bool) async {
    resolveHostKey(.reject)
    cancelKeyboardChallenge()
    let current = coordinator
    coordinator = nil
    factory = nil
    await current?.closeAll()
    workspace = nil
    frames = [:]
    sessionStatuses = [:]
    sessionProfileIDs = [:]
    grids = [:]
    layoutEpochs = [:]
    requestedProfileID = nil
    shortcutState = GhostteaWorkspaceShortcutState()
    if clearPersistence { try? await restorationStore?.remove() }
    status = profiles.isEmpty ? "Add an SSH connection to begin." : "Choose a saved connection"
  }

  private func sessionTerminated(_ sessionID: String) {
    frames[sessionID] = nil
    sessionStatuses[sessionID] = nil
    sessionProfileIDs[sessionID] = nil
    grids[sessionID] = nil
    layoutEpochs[sessionID] = nil
  }

  private func withSession(
    _ sessionID: String,
    operation: @escaping @Sendable (GhostteaSSHWorkspaceSession) async throws -> Void
  ) {
    guard let coordinator else { return }
    Task {
      do {
        guard let resource = await coordinator.session(for: sessionID) else { return }
        try await operation(resource)
      } catch {
        record(.sshSessionOperationFailed)
        sessionStatuses[sessionID] = "Operation failed"
      }
    }
  }

  private func forEachSession(
    _ operation: @escaping @Sendable (GhostteaSSHWorkspaceSession) async -> Void
  ) async {
    guard let coordinator else { return }
    let sessionIDs = await coordinator.sessionIDs
    for sessionID in sessionIDs {
      if let resource = await coordinator.session(for: sessionID) {
        await operation(resource)
      }
    }
  }

  private func requestHostKeyDecision(
    _ challenge: GhostteaSSHHostKeyChallenge
  ) async -> GhostteaSSHHostKeyDecision {
    hostKeyContinuation?.resume(returning: .reject)
    return await withCheckedContinuation { continuation in
      hostKeyContinuation = continuation
      pendingHostKey = GhostteaPendingHostKey(challenge: challenge)
    }
  }

  private func requestKeyboardResponses(
    _ challenge: GhostteaSSHKeyboardInteractiveChallenge
  ) async throws -> [String] {
    keyboardContinuation?.resume(throwing: CancellationError())
    return try await withCheckedThrowingContinuation { continuation in
      keyboardContinuation = continuation
      pendingKeyboardChallenge = GhostteaPendingKeyboardChallenge(challenge: challenge)
    }
  }

  private func applicationSupportRoot() throws -> URL {
    guard
      let root = FileManager.default.urls(
        for: .applicationSupportDirectory, in: .userDomainMask
      ).first
    else { throw GhostteaSSHAppError.applicationSupportUnavailable }
    return root.appendingPathComponent("Ghosttea", isDirectory: true)
  }

  private func identity(_ kind: String) -> String {
    "ios-\(kind)-\(UUID().uuidString.lowercased())"
  }

  private func record(_ code: GhostteaDiagnosticCode) {
    Task { try? await diagnostics.record(code, severity: .error) }
  }

  private static func softwareKey(hidUsage: UInt16) -> GhostteaKeyEvent {
    GhostteaHardwareKeyEvent(
      hidUsage: hidUsage,
      characters: "",
      charactersIgnoringModifiers: "",
      action: .down)!.coreEvent
  }

  private static func exitDescription(_ status: TerminalExitStatus) -> String {
    switch status {
    case .exited(let code): "Session ended · exit \(code)"
    case .signaled(let signal): "Session ended · signal \(signal)"
    }
  }
}

private enum GhostteaSSHAppError: Error {
  case notReady
  case missingProfile
  case applicationSupportUnavailable
}
