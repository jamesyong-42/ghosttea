import Foundation
import GhostteaConnectionProfiles
import GhostteaCore
import GhostteaCredentials
import GhostteaSSH
import GhostteaSession
import GhostteaWorkspace

/// The independently owned native and transport state behind one workspace pane.
///
/// A runtime may be shared by many resources, but a terminal and session never are.
/// Keeping the opaque workspace identity beside those actors makes event routing and
/// teardown independent of the currently selected tab or pane.
public struct GhostteaSSHWorkspaceSession: Sendable {
  public let id: String
  public let profileID: String?
  public let terminalSessionHandle: UInt64
  public let request: GhostteaWorkspaceSessionRequest
  public let terminal: GhostteaTerminal
  public let session: GhostteaSession

  public init(
    id: String,
    profileID: String? = nil,
    terminalSessionHandle: UInt64,
    request: GhostteaWorkspaceSessionRequest,
    terminal: GhostteaTerminal,
    session: GhostteaSession
  ) {
    self.id = id
    self.profileID = profileID
    self.terminalSessionHandle = terminalSessionHandle
    self.request = request
    self.terminal = terminal
    self.session = session
  }
}

public struct GhostteaSSHWorkspaceSessionEvent: Equatable, Sendable {
  public let sessionID: String
  public let event: GhostteaSessionEvent

  public init(sessionID: String, event: GhostteaSessionEvent) {
    self.sessionID = sessionID
    self.event = event
  }
}

public enum GhostteaSSHWorkspaceSessionFactoryError: Error, Equatable, Sendable {
  case invalidInitialSessionHandle
  case terminalSizeOutOfRange(columns: Int, rows: Int)
  case sessionHandleExhausted
  case invalidSessionID
  case duplicateSessionID(String)
  case duplicateProfileID(UUID)
  case missingProfile(String)
}

/// Creates the concrete SSH-backed resources consumed by a workspace coordinator.
///
/// Allocation is serialized so native terminal handles and workspace identities are
/// unique even when multiple scenes request tabs concurrently. The SSH configuration
/// is immutable and may resolve the same protected credential for each independent
/// connection; plaintext credentials never become part of workspace state.
public actor GhostteaSSHWorkspaceSessionFactory {
  public typealias EventHandler =
    @Sendable (GhostteaSSHWorkspaceSessionEvent) async -> Void

  private let runtime: GhostteaRuntime
  private let ssh: GhostteaSSHConfiguration
  private let defaultProfileID: String?
  private let sessionConfiguration: GhostteaSessionConfiguration
  private let scrollbackBytes: UInt64
  private var terminalConfiguration: GhostteaConfigSnapshot?
  private let identityPrefix: String
  private let eventHandler: EventHandler
  private var nextSessionHandle: UInt64?
  private var allocatedSessionIDs: Set<String> = []

  public init(
    runtime: GhostteaRuntime,
    ssh: GhostteaSSHConfiguration,
    profileID: String? = nil,
    sessionConfiguration: GhostteaSessionConfiguration = .ssh(),
    initialSessionHandle: UInt64 = 1,
    scrollbackBytes: UInt64 = 5_000_000,
    terminalConfiguration: GhostteaConfigSnapshot? = nil,
    identityPrefix: String = UUID().uuidString.lowercased(),
    eventHandler: @escaping EventHandler = { _ in }
  ) throws {
    guard initialSessionHandle != 0 else {
      throw GhostteaSSHWorkspaceSessionFactoryError.invalidInitialSessionHandle
    }
    self.runtime = runtime
    self.ssh = ssh
    self.defaultProfileID = profileID
    self.sessionConfiguration = sessionConfiguration
    self.nextSessionHandle = initialSessionHandle
    self.scrollbackBytes = scrollbackBytes
    self.terminalConfiguration = terminalConfiguration
    self.identityPrefix = identityPrefix
    self.eventHandler = eventHandler
  }

  /// Allocates one terminal and one SSH session, then requests its initial connection.
  ///
  /// `connect` is exposed for deterministic tests and restoration flows that need to
  /// create resources while network demand remains paused.
  public func allocate(
    _ request: GhostteaWorkspaceSessionRequest,
    connect: Bool = true
  ) async throws -> GhostteaWorkspaceSessionAllocation<GhostteaSSHWorkspaceSession> {
    try await allocate(
      request,
      ssh: ssh,
      sessionID: nil,
      profileID: defaultProfileID,
      connect: connect
    )
  }

  /// Recreates a persisted workspace identity with a fresh native handle and
  /// transport. Callers may also select a different saved profile per session.
  public func allocate(
    _ request: GhostteaWorkspaceSessionRequest,
    ssh: GhostteaSSHConfiguration,
    sessionID requestedSessionID: String?,
    profileID: String?,
    connect: Bool = true
  ) async throws -> GhostteaWorkspaceSessionAllocation<GhostteaSSHWorkspaceSession> {
    guard let handle = nextSessionHandle else {
      throw GhostteaSSHWorkspaceSessionFactoryError.sessionHandleExhausted
    }
    guard
      let columns = UInt16(exactly: ssh.initialSize.columns),
      let rows = UInt16(exactly: ssh.initialSize.rows)
    else {
      throw GhostteaSSHWorkspaceSessionFactoryError.terminalSizeOutOfRange(
        columns: ssh.initialSize.columns,
        rows: ssh.initialSize.rows
      )
    }

    let sessionID = requestedSessionID ?? "\(identityPrefix)-session-\(handle)"
    guard !sessionID.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
      throw GhostteaSSHWorkspaceSessionFactoryError.invalidSessionID
    }
    guard !allocatedSessionIDs.contains(sessionID) else {
      throw GhostteaSSHWorkspaceSessionFactoryError.duplicateSessionID(sessionID)
    }
    let terminal = try GhostteaTerminal(
      runtime: runtime,
      configuration: GhostteaTerminalConfiguration(
        sessionHandle: handle,
        scrollbackBytes: scrollbackBytes,
        columns: columns,
        rows: rows
      )
    )
    if let terminalConfiguration {
      _ = try await terminal.apply(config: terminalConfiguration, render: .none)
    }
    let handler = eventHandler
    let session = GhostteaSSHSessionFactory.make(
      terminal: terminal,
      ssh: ssh,
      session: sessionConfiguration,
      eventHandler: { event in
        await handler(
          GhostteaSSHWorkspaceSessionEvent(sessionID: sessionID, event: event)
        )
      }
    )
    let resource = GhostteaSSHWorkspaceSession(
      id: sessionID,
      profileID: profileID,
      terminalSessionHandle: handle,
      request: request,
      terminal: terminal,
      session: session
    )

    allocatedSessionIDs.insert(sessionID)
    nextSessionHandle = handle == UInt64.max ? nil : handle + 1
    if connect {
      await session.requestConnect()
    }
    return GhostteaWorkspaceSessionAllocation(sessionID: sessionID, session: resource)
  }

  public nonisolated static func disconnect(
    _ resource: GhostteaSSHWorkspaceSession
  ) async {
    await resource.session.disconnect()
  }

  /// Updates colors and palette for terminals allocated after this call. The
  /// shared runtime's font metrics and the factory's scrollback budget remain
  /// startup-owned until the workspace is recreated.
  public func updateTerminalConfiguration(_ configuration: GhostteaConfigSnapshot) {
    terminalConfiguration = configuration
  }

  /// Tears down an evicted resource and releases its stable identity so a later
  /// allocation can rehydrate the same workspace pane with a fresh native handle.
  public func evict(_ resource: GhostteaSSHWorkspaceSession) async {
    await resource.session.disconnect()
    allocatedSessionIDs.remove(resource.id)
  }

  /// Recreates every resolvable persisted session with a fresh native terminal
  /// and transport. Restore defaults to demand-paused; the host decides when a
  /// foreground scene may explicitly request connections.
  public func restore(
    _ persisted: GhostteaWorkspaceRestorationDocument,
    profiles: [GhostteaSSHConnectionProfile],
    knownHostsPath: String,
    hostKeyPolicy: GhostteaSSHHostKeyPolicy = .strictKnownHosts,
    credentialStore: KeychainSSHCredentialStore,
    keyboardInteractiveResponder: GhostteaSSHKeyboardInteractiveResponder? = nil,
    connect: Bool = false
  ) async throws -> GhostteaWorkspaceRestorationResult<GhostteaSSHWorkspaceSession> {
    var profilesByID: [String: GhostteaSSHConnectionProfile] = [:]
    for profile in profiles {
      let profileID = profile.id.uuidString.lowercased()
      guard profilesByID[profileID] == nil else {
        throw GhostteaSSHWorkspaceSessionFactoryError.duplicateProfileID(profile.id)
      }
      profilesByID[profileID] = profile
    }
    let resolvedProfilesByID = profilesByID

    return try await GhostteaWorkspaceRestorer.restore(
      persisted,
      allocator: { [self] binding in
        guard let profile = resolvedProfilesByID[binding.profileID.lowercased()] else {
          throw GhostteaSSHWorkspaceSessionFactoryError.missingProfile(binding.profileID)
        }
        let ssh = try profile.configuration(
          knownHostsPath: knownHostsPath,
          hostKeyPolicy: hostKeyPolicy,
          credentialStore: credentialStore,
          keyboardInteractiveResponder: keyboardInteractiveResponder
        )
        return try await allocate(
          .newTab,
          ssh: ssh,
          sessionID: binding.sessionID,
          profileID: binding.profileID,
          connect: connect
        ).session
      },
      terminator: { _, resource in
        await Self.disconnect(resource)
      }
    )
  }
}
