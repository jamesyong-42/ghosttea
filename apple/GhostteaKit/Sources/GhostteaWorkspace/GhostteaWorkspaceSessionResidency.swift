import Foundation

/// Deterministic recency bookkeeping for bounded live workspace resources.
/// Layout and stable session identities remain owned by the workspace document.
public struct GhostteaWorkspaceSessionResidency: Equatable, Sendable {
  private var generation: UInt64 = 0
  private var lastAccess: [String: UInt64] = [:]

  public init(sessionIDs: [String] = []) {
    for sessionID in sessionIDs {
      touch(sessionID)
    }
  }

  public mutating func touch(_ sessionID: String) {
    if generation == UInt64.max {
      compactGenerations()
    }
    generation += 1
    lastAccess[sessionID] = generation
  }

  public mutating func touch<S: Sequence>(_ sessionIDs: S) where S.Element == String {
    for sessionID in sessionIDs {
      touch(sessionID)
    }
  }

  public mutating func remove(_ sessionID: String) {
    lastAccess[sessionID] = nil
  }

  /// Returns only detached, resident sessions, oldest first, until the cap is met.
  /// Every pane in the selected tab is protected even if that exceeds the cap.
  public func evictionCandidates(
    in document: GhostteaWorkspaceTabsDocument,
    residentSessionIDs: Set<String>,
    maximumResidentSessions: Int
  ) -> [String] {
    let excess = max(0, residentSessionIDs.count - max(0, maximumResidentSessions))
    guard excess > 0 else { return [] }
    let workspaceOrder = Dictionary(
      uniqueKeysWithValues: document.sessionIDs.enumerated().map { ($0.element, $0.offset) }
    )
    return document.inactiveSessionIDs
      .filter { residentSessionIDs.contains($0) }
      .sorted {
        let left = lastAccess[$0] ?? 0
        let right = lastAccess[$1] ?? 0
        if left != right { return left < right }
        return (workspaceOrder[$0] ?? Int.max) < (workspaceOrder[$1] ?? Int.max)
      }
      .prefix(excess)
      .map { $0 }
  }

  private mutating func compactGenerations() {
    let ordered = lastAccess.sorted {
      if $0.value != $1.value { return $0.value < $1.value }
      return $0.key < $1.key
    }
    lastAccess.removeAll(keepingCapacity: true)
    generation = 0
    for (sessionID, _) in ordered {
      generation += 1
      lastAccess[sessionID] = generation
    }
  }
}
