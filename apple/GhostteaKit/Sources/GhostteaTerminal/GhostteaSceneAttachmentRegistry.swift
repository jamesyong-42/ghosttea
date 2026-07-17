import Foundation

public enum GhostteaScenePhase: String, Codable, Equatable, Sendable {
  case active
  case inactive
  case background

  public var presentsTerminal: Bool { self == .active }
}

public struct GhostteaAggregateSceneTransition: Equatable, Sendable {
  public let previous: GhostteaScenePhase
  public let current: GhostteaScenePhase
}

public struct GhostteaSceneLifecycleState: Sendable {
  private var phases: [UUID: GhostteaScenePhase] = [:]

  public init() {}

  public var aggregatePhase: GhostteaScenePhase {
    if phases.values.contains(.active) { return .active }
    if phases.values.contains(.inactive) { return .inactive }
    return .background
  }

  @discardableResult
  public mutating func update(
    sceneID: UUID,
    phase: GhostteaScenePhase
  ) -> GhostteaAggregateSceneTransition? {
    let previous = aggregatePhase
    phases[sceneID] = phase
    return transition(from: previous)
  }

  @discardableResult
  public mutating func disconnect(
    sceneID: UUID
  ) -> GhostteaAggregateSceneTransition? {
    guard phases[sceneID] != nil else { return nil }
    let previous = aggregatePhase
    phases[sceneID] = nil
    return transition(from: previous)
  }

  private func transition(
    from previous: GhostteaScenePhase
  ) -> GhostteaAggregateSceneTransition? {
    let current = aggregatePhase
    guard previous != current else { return nil }
    return GhostteaAggregateSceneTransition(previous: previous, current: current)
  }
}

public struct GhostteaSceneAttachmentToken: Hashable, Codable, Sendable {
  public let sessionID: UUID
  public let sceneID: UUID
  public let generation: UInt64
}

public struct GhostteaSceneAttachmentTransition: Equatable, Sendable {
  public let detached: GhostteaSceneAttachmentToken?
  public let attached: GhostteaSceneAttachmentToken
  public let visible: Bool
}

public struct GhostteaSceneVisibilityChange: Equatable, Sendable {
  public let attachment: GhostteaSceneAttachmentToken
  public let visible: Bool
}

public actor GhostteaSceneAttachmentRegistry {
  private var scenePhases: [UUID: GhostteaScenePhase] = [:]
  private var attachmentsBySession: [UUID: GhostteaSceneAttachmentToken] = [:]
  private var sessionIDsByScene: [UUID: Set<UUID>] = [:]
  private var nextGeneration: UInt64 = 1

  public init() {}

  public func registerScene(
    _ sceneID: UUID,
    phase: GhostteaScenePhase = .inactive
  ) {
    if scenePhases[sceneID] == nil {
      scenePhases[sceneID] = phase
    }
  }

  public func attach(sessionID: UUID, to sceneID: UUID) -> GhostteaSceneAttachmentTransition {
    let detached = attachmentsBySession[sessionID]
    if let detached {
      remove(sessionID: sessionID, from: detached.sceneID)
    }
    if scenePhases[sceneID] == nil {
      scenePhases[sceneID] = .inactive
    }
    let attached = GhostteaSceneAttachmentToken(
      sessionID: sessionID,
      sceneID: sceneID,
      generation: takeGeneration()
    )
    attachmentsBySession[sessionID] = attached
    sessionIDsByScene[sceneID, default: []].insert(sessionID)
    return GhostteaSceneAttachmentTransition(
      detached: detached,
      attached: attached,
      visible: scenePhases[sceneID]?.presentsTerminal == true
    )
  }

  @discardableResult
  public func detach(_ token: GhostteaSceneAttachmentToken) -> Bool {
    guard attachmentsBySession[token.sessionID] == token else { return false }
    attachmentsBySession[token.sessionID] = nil
    remove(sessionID: token.sessionID, from: token.sceneID)
    return true
  }

  public func updateScene(
    _ sceneID: UUID,
    phase: GhostteaScenePhase
  ) -> [GhostteaSceneVisibilityChange] {
    guard scenePhases[sceneID] != phase else { return [] }
    scenePhases[sceneID] = phase
    return currentAttachments(in: sceneID).map {
      GhostteaSceneVisibilityChange(attachment: $0, visible: phase.presentsTerminal)
    }
  }

  public func disconnectScene(_ sceneID: UUID) -> [GhostteaSceneAttachmentToken] {
    let detached = currentAttachments(in: sceneID)
    for token in detached {
      attachmentsBySession[token.sessionID] = nil
    }
    sessionIDsByScene[sceneID] = nil
    scenePhases[sceneID] = nil
    return detached
  }

  public func attachment(for sessionID: UUID) -> GhostteaSceneAttachmentToken? {
    attachmentsBySession[sessionID]
  }

  private func currentAttachments(in sceneID: UUID) -> [GhostteaSceneAttachmentToken] {
    (sessionIDsByScene[sceneID] ?? []).compactMap { attachmentsBySession[$0] }
      .sorted { $0.generation < $1.generation }
  }

  private func remove(sessionID: UUID, from sceneID: UUID) {
    sessionIDsByScene[sceneID]?.remove(sessionID)
    if sessionIDsByScene[sceneID]?.isEmpty == true {
      sessionIDsByScene[sceneID] = nil
    }
  }

  private func takeGeneration() -> UInt64 {
    precondition(nextGeneration < .max, "scene attachment generation exhausted")
    let generation = nextGeneration
    nextGeneration += 1
    return generation
  }
}
