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
  case inconsistentAllocationResult
}

public actor GhostteaWorkspaceRestorationStore {
  public let fileURL: URL

  public init(fileURL: URL) {
    self.fileURL = fileURL
  }

  public func load() throws -> GhostteaWorkspaceRestorationDocument? {
    guard FileManager.default.fileExists(atPath: fileURL.path) else { return nil }
    return try JSONDecoder().decode(
      GhostteaWorkspaceRestorationDocument.self,
      from: Data(contentsOf: fileURL)
    )
  }

  public func save(_ document: GhostteaWorkspaceRestorationDocument) throws {
    try FileManager.default.createDirectory(
      at: fileURL.deletingLastPathComponent(),
      withIntermediateDirectories: true
    )
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
    try encoder.encode(document).write(to: fileURL, options: .atomic)
    #if os(iOS)
      try FileManager.default.setAttributes(
        [.protectionKey: FileProtectionType.complete],
        ofItemAtPath: fileURL.path
      )
    #endif
  }

  public func remove() throws {
    guard FileManager.default.fileExists(atPath: fileURL.path) else { return }
    try FileManager.default.removeItem(at: fileURL)
  }
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
    self.sessionProfiles = workspace.uniqueSessionIDs.compactMap { bindingsBySessionID[$0] }
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

public struct GhostteaWorkspaceRestorationResult<Session: Sendable>: Sendable {
  public let document: GhostteaWorkspaceTabsDocument?
  public let sessions: [String: Session]
  public let unavailableSessionIDs: [String]

  public init(
    document: GhostteaWorkspaceTabsDocument?,
    sessions: [String: Session],
    unavailableSessionIDs: [String]
  ) {
    self.document = document
    self.sessions = sessions
    self.unavailableSessionIDs = unavailableSessionIDs
  }
}

/// Recreates persisted identities without treating persistence as live state.
///
/// Allocation is deliberately sequential and follows workspace order. This
/// keeps authentication prompts deterministic and bounds simultaneous restore
/// work. Ordinary allocation errors make only that session unavailable;
/// cancellation terminates everything allocated by the interrupted attempt.
public enum GhostteaWorkspaceRestorer {
  public typealias Allocator<Session: Sendable> =
    @Sendable (GhostteaWorkspaceSessionProfileBinding) async throws -> Session
  public typealias Terminator<Session: Sendable> =
    @Sendable (String, Session) async -> Void

  public static func restore<Session: Sendable>(
    _ persisted: GhostteaWorkspaceRestorationDocument,
    allocator: Allocator<Session>,
    terminator: Terminator<Session>
  ) async throws -> GhostteaWorkspaceRestorationResult<Session> {
    var sessions: [String: Session] = [:]
    var unavailableSessionIDs: [String] = []

    for binding in persisted.sessionProfiles {
      do {
        try Task.checkCancellation()
        sessions[binding.sessionID] = try await allocator(binding)
      } catch is CancellationError {
        await terminate(sessions, in: persisted.workspace.sessionIDs, using: terminator)
        throw CancellationError()
      } catch {
        unavailableSessionIDs.append(binding.sessionID)
      }
    }

    do {
      try Task.checkCancellation()
      let document = try persisted.restoring(allocatedSessionIDs: Set(sessions.keys))
      guard document != nil || sessions.isEmpty else {
        throw GhostteaWorkspaceRestorationError.inconsistentAllocationResult
      }
      return GhostteaWorkspaceRestorationResult(
        document: document,
        sessions: sessions,
        unavailableSessionIDs: unavailableSessionIDs
      )
    } catch {
      await terminate(sessions, in: persisted.workspace.sessionIDs, using: terminator)
      throw error
    }
  }

  private static func terminate<Session: Sendable>(
    _ sessions: [String: Session],
    in orderedSessionIDs: [String],
    using terminator: Terminator<Session>
  ) async {
    var terminatedSessionIDs = Set<String>()
    for sessionID in orderedSessionIDs {
      if terminatedSessionIDs.insert(sessionID).inserted, let session = sessions[sessionID] {
        await terminator(sessionID, session)
      }
    }
  }
}
