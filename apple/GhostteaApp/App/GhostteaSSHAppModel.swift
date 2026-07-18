import Foundation
import GhostteaConnectionProfiles
import GhostteaCore
import GhostteaCredentials
import GhostteaSSH
import GhostteaSession
import GhostteaTerminal
import GhostteaTransport
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
  @Published private(set) var activeProfile: GhostteaSSHConnectionProfile?
  @Published private(set) var frame: Data?
  @Published private(set) var status = "Loading saved connections…"
  @Published private(set) var isBusy = false
  @Published var presentsProfileManager = false
  @Published var pendingHostKey: GhostteaPendingHostKey?
  @Published var pendingKeyboardChallenge: GhostteaPendingKeyboardChallenge?

  private var runtime: GhostteaRuntime?
  private var terminal: GhostteaTerminal?
  private var session: GhostteaSession?
  private var repository: GhostteaSSHConnectionProfileRepository?
  private var credentialStore: KeychainSSHCredentialStore?
  private var networkTask: Task<Void, Never>?
  private var networkPath = TerminalNetworkPath.unknown
  private var hostKeyContinuation: CheckedContinuation<GhostteaSSHHostKeyDecision, Never>?
  private var keyboardContinuation: CheckedContinuation<[String], Error>?
  private var nextSessionHandle: UInt64 = 10_000
  private var layoutEpoch: UInt64 = 0
  private var grid = GhostteaTerminalGridSize(columns: 80, rows: 24)
  private var started = false

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
        let profileStore = GhostteaSSHConnectionProfileStore(fileURL: try profilesURL())
        let repository = GhostteaSSHConnectionProfileRepository(
          profileStore: profileStore,
          credentialVault: store)
        credentialStore = store
        self.repository = repository
        profiles = try await repository.load()
        status = profiles.isEmpty ? "Add an SSH connection to begin." : "Choose a saved connection"
      } catch {
        status = "Could not load saved connections: \(error)"
      }
    }
  }

  func connect(_ profile: GhostteaSSHConnectionProfile) {
    guard !isBusy else { return }
    isBusy = true
    status = "Preparing \(profile.name)…"
    Task {
      await disconnectSession(clearProfile: false)
      do {
        guard let credentialStore else { throw GhostteaSSHAppError.notReady }
        let runtime = try self.runtime ?? GhostteaRuntime()
        self.runtime = runtime
        let handle = nextSessionHandle
        nextSessionHandle = handle == UInt64.max ? 10_000 : handle + 1
        let terminal = try GhostteaTerminal(
          runtime: runtime,
          configuration: GhostteaTerminalConfiguration(
            sessionHandle: handle,
            columns: UInt16(profile.columns),
            rows: UInt16(profile.rows)))
        let configuration = try profile.configuration(
          knownHostsPath: try GhostteaSSHKnownHostsFile().prepare(),
          hostKeyPolicy: .ask { [weak self] challenge in
            guard let self else { return .reject }
            return await self.requestHostKeyDecision(challenge)
          },
          credentialStore: credentialStore,
          keyboardInteractiveResponder: { [weak self] challenge in
            guard let self else { throw CancellationError() }
            return try await self.requestKeyboardResponses(challenge)
          })
        let session = GhostteaSSHSessionFactory.make(
          terminal: terminal,
          ssh: configuration,
          session: .ssh(initialPath: networkPath),
          eventHandler: { [weak self] event in await self?.handle(event) })
        self.terminal = terminal
        self.session = session
        activeProfile = profile
        frame = nil
        grid = GhostteaTerminalGridSize(
          columns: UInt16(profile.columns), rows: UInt16(profile.rows))
        layoutEpoch = 0
        status = "Connecting to \(profile.name)…"
        isBusy = false
        await session.requestConnect()
      } catch {
        isBusy = false
        status = GhostteaSSHFailurePolicy.description(error)
      }
    }
  }

  func reconnect() {
    guard let session, !isBusy else { return }
    status = "Reconnecting…"
    Task { await session.requestConnect() }
  }

  func disconnect() {
    Task { await disconnectSession(clearProfile: true) }
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
        status = "Could not save connection: \(error)"
      }
    }
  }

  func deleteProfile(_ id: UUID) {
    guard let repository else { return }
    Task {
      do {
        _ = try await repository.delete(profileID: id)
        profiles = try await repository.load()
        if activeProfile?.id == id { await disconnectSession(clearProfile: true) }
        status = profiles.isEmpty ? "Add an SSH connection to begin." : "Deleted connection"
      } catch {
        status = "Could not delete connection: \(error)"
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

  func updateGrid(_ value: GhostteaTerminalGridSize) {
    guard value != grid, let session else { return }
    grid = value
    layoutEpoch &+= 1
    let epoch = layoutEpoch
    Task {
      try? await session.resize(
        columns: Int(value.columns), rows: Int(value.rows), layoutEpoch: epoch)
    }
  }

  func handleHardwareKey(_ event: GhostteaHardwareKeyEvent) -> Bool {
    guard let session, !event.modifiers.contains(.command) else { return false }
    Task { try? await session.sendKey(event.coreEvent) }
    return true
  }

  func handleSoftwareInput(_ event: GhostteaSoftwareInputEvent) {
    guard let session else { return }
    Task {
      do {
        switch event {
        case .text(let text): try await session.send(Data(text.utf8))
        case .enter: try await session.sendKey(Self.softwareKey(hidUsage: 0x28))
        case .deleteBackward: try await session.sendKey(Self.softwareKey(hidUsage: 0x2a))
        case .paste(let text): try await session.sendPaste(text)
        case .key(let key): try await session.sendKey(key.coreEvent)
        }
      } catch { status = "Input failed" }
    }
  }

  func handleMouse(_ event: GhostteaTerminalMouseEvent) {
    guard let session else { return }
    Task { try? await session.sendMouse(event.coreEvent) }
  }

  func handleScroll(_ rows: Int) {
    guard let session, rows != 0 else { return }
    Task { try? await session.scroll(rows: Int64(rows)) }
  }

  func copySelection(_ selection: GhostteaTerminalSelection) {
    guard let terminal else { return }
    Task {
      do {
        let data = try await terminal.selectionTextBytes(
          startColumn: selection.anchor.column,
          startRow: selection.anchor.row,
          endColumn: selection.focus.column,
          endRow: selection.focus.row)
        UIPasteboard.general.string = String(decoding: data, as: UTF8.self)
      } catch { status = "Copy failed" }
    }
  }

  func copyAll() {
    guard let terminal else { return }
    Task {
      do {
        let data = try await terminal.selectionTextBytes(
          startColumn: 0, startRow: 0, endColumn: 0, endRow: 0, selectAll: true)
        UIPasteboard.general.string = String(decoding: data, as: UTF8.self)
      } catch { status = "Copy failed" }
    }
  }

  func sceneChanged(_ phase: ScenePhase) {
    guard let session else { return }
    Task {
      switch phase {
      case .active: await session.becameActive()
      case .background: await session.enteredBackground()
      case .inactive: break
      @unknown default: break
      }
    }
  }

  private func networkChanged(_ path: TerminalNetworkPath) async {
    networkPath = path
    await session?.updateNetworkPath(path)
  }

  private func handle(_ event: GhostteaSessionEvent) async {
    switch event {
    case .stateChanged(let snapshot):
      switch snapshot.reconnectState {
      case .idle:
        status = snapshot.lastExitStatus.map(Self.exitDescription) ?? "Disconnected"
      case .waitingForNetwork: status = "Waiting for network"
      case .connecting: status = "Connecting…"
      case .connected: status = "Connected"
      case .reconnectAvailable: status = "Reconnect available"
      case .suspended: status = "Suspended"
      case .failed: status = snapshot.lastFailure?.message ?? "SSH session failed"
      }
    case .frameReady(let value): frame = value
    case .clipboardWrite(let data):
      UIPasteboard.general.string = String(decoding: data, as: UTF8.self)
    case .bell: status = "Bell"
    case .logicalSnapshot, .metadataChanged: break
    }
  }

  private func disconnectSession(clearProfile: Bool) async {
    resolveHostKey(.reject)
    cancelKeyboardChallenge()
    let current = session
    session = nil
    terminal = nil
    frame = nil
    await current?.disconnect()
    if clearProfile {
      activeProfile = nil
      status = profiles.isEmpty ? "Add an SSH connection to begin." : "Choose a saved connection"
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

  private func profilesURL() throws -> URL {
    guard
      let root = FileManager.default.urls(
        for: .applicationSupportDirectory, in: .userDomainMask
      ).first
    else { throw GhostteaSSHAppError.applicationSupportUnavailable }
    return
      root
      .appendingPathComponent("Ghosttea", isDirectory: true)
      .appendingPathComponent("ssh-profiles.json", isDirectory: false)
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
  case applicationSupportUnavailable
}
