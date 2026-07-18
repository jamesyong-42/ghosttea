import Foundation

public enum GhostteaWorkspaceSessionRequest: Equatable, Sendable {
  case newTab
  case split(axis: GhostteaWorkspaceSplitAxis, sourceSessionID: String)
}

public struct GhostteaWorkspaceSessionAllocation<Session: Sendable>: Sendable {
  public let sessionID: String
  public let session: Session

  public init(sessionID: String, session: Session) {
    self.sessionID = sessionID
    self.session = session
  }
}

public enum GhostteaWorkspaceSessionCoordinatorError: Error, Equatable, Sendable {
  case closed
  case registryMismatch
  case invalidSessionID
  case duplicateSessionID(String)
  case missingResidentSession(String)
  case sessionNotInDocument(String)
  case missingSelectedSession
  case rejectedTransition
}

public actor GhostteaWorkspaceSessionCoordinator<Session: Sendable> {
  public typealias Allocator =
    @Sendable (GhostteaWorkspaceSessionRequest) async throws ->
    GhostteaWorkspaceSessionAllocation<Session>
  public typealias Terminator = @Sendable (String, Session) async -> Void

  public private(set) var document: GhostteaWorkspaceTabsDocument

  private var sessions: [String: Session]
  private let allocator: Allocator
  private let terminator: Terminator
  private let identityPrefix: String
  private var nextIdentity = 0
  private var closed = false

  public init(
    document: GhostteaWorkspaceTabsDocument,
    sessions: [String: Session],
    identityPrefix: String = UUID().uuidString.lowercased(),
    allocator: @escaping Allocator,
    terminator: @escaping Terminator
  ) throws {
    guard Set(document.sessionIDs) == Set(sessions.keys) else {
      throw GhostteaWorkspaceSessionCoordinatorError.registryMismatch
    }
    self.document = document
    self.sessions = sessions
    self.identityPrefix = identityPrefix
    self.allocator = allocator
    self.terminator = terminator
  }

  public var sessionIDs: Set<String> { Set(sessions.keys) }

  public func session(for id: String) -> Session? { sessions[id] }

  /// Removes a live resource without changing its pane or stable session identity.
  /// The caller owns transport teardown and may later install a fresh resource.
  public func evictSession(_ id: String) throws -> Session {
    try requireOpen()
    guard document.sessionIDs.contains(id) else {
      throw GhostteaWorkspaceSessionCoordinatorError.sessionNotInDocument(id)
    }
    guard let session = sessions.removeValue(forKey: id) else {
      throw GhostteaWorkspaceSessionCoordinatorError.missingResidentSession(id)
    }
    return session
  }

  /// Installs a freshly allocated resource behind an existing cold pane identity.
  public func rehydrateSession(_ id: String, session: Session) throws {
    try requireOpen()
    guard document.sessionIDs.contains(id) else {
      throw GhostteaWorkspaceSessionCoordinatorError.sessionNotInDocument(id)
    }
    guard sessions[id] == nil else {
      throw GhostteaWorkspaceSessionCoordinatorError.duplicateSessionID(id)
    }
    sessions[id] = session
  }

  @discardableResult
  public func createTab() async throws -> GhostteaWorkspaceTabsTransition {
    try requireOpen()
    let allocation = try await allocator(.newTab)
    do {
      try validate(allocation)
      let paneID = identity(kind: "pane")
      let tabID = identity(kind: "tab")
      let workspace = try GhostteaWorkspaceDocument(
        root: .pane(GhostteaWorkspacePane(id: paneID, sessionID: allocation.sessionID)),
        activePaneID: paneID
      )
      let transition = try document.applying(
        .createTab(GhostteaWorkspaceTab(id: tabID, workspace: workspace))
      )
      guard transition.document.tabs.count == document.tabs.count + 1 else {
        throw GhostteaWorkspaceSessionCoordinatorError.rejectedTransition
      }
      sessions[allocation.sessionID] = allocation.session
      document = transition.document
      return transition
    } catch {
      await terminator(allocation.sessionID, allocation.session)
      throw error
    }
  }

  @discardableResult
  public func splitSelected(
    axis: GhostteaWorkspaceSplitAxis
  ) async throws -> GhostteaWorkspaceTabsTransition {
    try requireOpen()
    guard let sourceSessionID = selectedSessionID else {
      throw GhostteaWorkspaceSessionCoordinatorError.missingSelectedSession
    }
    let allocation = try await allocator(.split(axis: axis, sourceSessionID: sourceSessionID))
    do {
      try validate(allocation)
      let transition = try document.applying(
        .applyToSelected(
          .split(
            axis: axis,
            paneID: identity(kind: "pane"),
            sessionID: allocation.sessionID,
            splitID: identity(kind: "split")
          )
        )
      )
      guard transition.document.sessionIDs.count == document.sessionIDs.count + 1 else {
        throw GhostteaWorkspaceSessionCoordinatorError.rejectedTransition
      }
      sessions[allocation.sessionID] = allocation.session
      document = transition.document
      return transition
    } catch {
      await terminator(allocation.sessionID, allocation.session)
      throw error
    }
  }

  @discardableResult
  public func apply(
    _ action: GhostteaWorkspaceTabsAction
  ) async throws -> GhostteaWorkspaceTabsTransition {
    try requireOpen()
    let transition = try document.applying(action)
    document = transition.document
    for sessionID in transition.closedSessionIDs {
      if let session = sessions.removeValue(forKey: sessionID) {
        await terminator(sessionID, session)
      }
    }
    return transition
  }

  public func closeAll() async {
    guard !closed else { return }
    closed = true
    let sessionIDs = document.sessionIDs
    for sessionID in sessionIDs {
      if let session = sessions.removeValue(forKey: sessionID) {
        await terminator(sessionID, session)
      }
    }
  }

  private var selectedSessionID: String? {
    guard let tab = document.tabs.first(where: { $0.id == document.selectedTabID }) else {
      return nil
    }
    return tab.workspace.root.panes.first(where: { $0.id == tab.workspace.activePaneID })?.sessionID
  }

  private func requireOpen() throws {
    if closed { throw GhostteaWorkspaceSessionCoordinatorError.closed }
  }

  private func validate(_ allocation: GhostteaWorkspaceSessionAllocation<Session>) throws {
    guard !allocation.sessionID.isEmpty else {
      throw GhostteaWorkspaceSessionCoordinatorError.invalidSessionID
    }
    guard sessions[allocation.sessionID] == nil else {
      throw GhostteaWorkspaceSessionCoordinatorError.duplicateSessionID(allocation.sessionID)
    }
  }

  private func identity(kind: String) -> String {
    nextIdentity += 1
    return "\(identityPrefix)-\(kind)-\(nextIdentity)"
  }
}
