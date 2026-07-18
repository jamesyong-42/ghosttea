import Foundation

public let ghostteaWorkspaceRestorationSchemaVersion = 1

public struct GhostteaWorkspaceSessionProfileBinding: Equatable, Sendable, Codable {
  public let sessionID: String
  public let profileID: String

  public init(sessionID: String, profileID: String) {
    self.sessionID = sessionID
    self.profileID = profileID
  }
}

public enum GhostteaWorkspaceRestorationError: Error, Equatable, Sendable {
  case unsupportedVersion(Int)
  case emptyProfileID
  case duplicateSessionID(String)
  case bindingMismatch
}

/// Secret-free workspace metadata persisted across process death.
///
/// A binding says which connection recipe may be used to recreate a session;
/// it is not evidence that the session is live. Hosts must allocate resources
/// first, then call `restoring(allocatedSessionIDs:)` so failed or unavailable
/// profiles are removed through the ordinary workspace-collapse rules.
public struct GhostteaWorkspaceRestorationDocument: Equatable, Sendable, Codable {
  public let version: Int
  public let workspace: GhostteaWorkspaceTabsDocument
  public let sessionProfiles: [GhostteaWorkspaceSessionProfileBinding]

  private enum CodingKeys: String, CodingKey {
    case version
    case workspace
    case sessionProfiles
  }

  public init(
    version: Int = ghostteaWorkspaceRestorationSchemaVersion,
    workspace: GhostteaWorkspaceTabsDocument,
    sessionProfiles: [GhostteaWorkspaceSessionProfileBinding]
  ) throws {
    guard version == ghostteaWorkspaceRestorationSchemaVersion else {
      throw GhostteaWorkspaceRestorationError.unsupportedVersion(version)
    }
    var bindingSessionIDs = Set<String>()
    for binding in sessionProfiles {
      guard !binding.profileID.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
        throw GhostteaWorkspaceRestorationError.emptyProfileID
      }
      guard bindingSessionIDs.insert(binding.sessionID).inserted else {
        throw GhostteaWorkspaceRestorationError.duplicateSessionID(binding.sessionID)
      }
    }
    guard bindingSessionIDs == Set(workspace.sessionIDs) else {
      throw GhostteaWorkspaceRestorationError.bindingMismatch
    }
    let bindingsBySessionID = Dictionary(
      uniqueKeysWithValues: sessionProfiles.map { ($0.sessionID, $0) }
    )
    self.version = version
    self.workspace = workspace
    self.sessionProfiles = workspace.sessionIDs.compactMap { bindingsBySessionID[$0] }
  }

  public init(from decoder: any Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    try self.init(
      version: container.decode(Int.self, forKey: .version),
      workspace: container.decode(GhostteaWorkspaceTabsDocument.self, forKey: .workspace),
      sessionProfiles: container.decode(
        [GhostteaWorkspaceSessionProfileBinding].self,
        forKey: .sessionProfiles
      )
    )
  }

  public var profileIDBySessionID: [String: String] {
    Dictionary(uniqueKeysWithValues: sessionProfiles.map { ($0.sessionID, $0.profileID) })
  }

  public func restoring(
    allocatedSessionIDs: Set<String>
  ) throws -> GhostteaWorkspaceTabsDocument? {
    try workspace.restoring(liveSessionIDs: allocatedSessionIDs)
  }
}
