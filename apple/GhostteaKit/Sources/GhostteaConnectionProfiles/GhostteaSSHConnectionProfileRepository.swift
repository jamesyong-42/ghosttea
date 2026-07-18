import Foundation
import GhostteaCredentials

public protocol GhostteaSSHCredentialVault: Sendable {
  func store(_ secret: Data, for credential: SSHCredentialID) async throws
  func remove(_ credential: SSHCredentialID) async throws
}

extension KeychainSSHCredentialStore: GhostteaSSHCredentialVault {}

public enum GhostteaSSHConnectionProfileRepositoryError: Error, Equatable, Sendable {
  case missingProfile(UUID)
  case credentialWriteFailed
  case profilePersistenceFailed
  case rollbackIncomplete([SSHCredentialID])
}

public struct GhostteaSSHConnectionProfileMutation: Equatable, Sendable {
  public let profile: GhostteaSSHConnectionProfile?
  public let credentialCleanupFailures: [SSHCredentialID]

  public init(
    profile: GhostteaSSHConnectionProfile?,
    credentialCleanupFailures: [SSHCredentialID]
  ) {
    self.profile = profile
    self.credentialCleanupFailures = credentialCleanupFailures
  }
}

/// Serializes profile JSON and Keychain mutations without persisting secrets.
///
/// New credentials are written under fresh opaque IDs before the profile file
/// changes. A profile-write failure rolls those new items back. After a
/// successful update/delete, retired credential cleanup is attempted and any
/// orphan IDs are returned for an explicit retry instead of invalidating the
/// already-durable non-secret profile document.
public actor GhostteaSSHConnectionProfileRepository {
  private let profileStore: GhostteaSSHConnectionProfileStore
  private let credentialVault: any GhostteaSSHCredentialVault

  public init(
    profileStore: GhostteaSSHConnectionProfileStore,
    credentialVault: any GhostteaSSHCredentialVault
  ) {
    self.profileStore = profileStore
    self.credentialVault = credentialVault
  }

  public func load() async throws -> [GhostteaSSHConnectionProfile] {
    try await profileStore.load()
  }

  public func save(
    _ request: GhostteaSSHConnectionProfileSaveRequest,
    connectionID: UUID = UUID()
  ) async throws -> GhostteaSSHConnectionProfileMutation {
    var profiles = try await profileStore.load()
    let existingIndex = profiles.firstIndex { $0.id == request.draft.id }
    let existingProfile = existingIndex.map { profiles[$0] }
    let prepared = try request.prepare(
      existingProfile: existingProfile,
      connectionID: connectionID
    )
    var writtenCredentialIDs: [SSHCredentialID] = []
    do {
      for write in prepared.credentialWrites {
        try await credentialVault.store(write.secret, for: write.credential)
        writtenCredentialIDs.append(write.credential)
      }
    } catch {
      let rollbackFailures = await removeCredentials(writtenCredentialIDs)
      if !rollbackFailures.isEmpty {
        throw GhostteaSSHConnectionProfileRepositoryError.rollbackIncomplete(rollbackFailures)
      }
      throw GhostteaSSHConnectionProfileRepositoryError.credentialWriteFailed
    }

    if let existingIndex {
      profiles[existingIndex] = prepared.profile
    } else {
      profiles.append(prepared.profile)
    }
    do {
      try await profileStore.save(profiles)
    } catch {
      let rollbackFailures = await removeCredentials(writtenCredentialIDs)
      if !rollbackFailures.isEmpty {
        throw GhostteaSSHConnectionProfileRepositoryError.rollbackIncomplete(rollbackFailures)
      }
      throw GhostteaSSHConnectionProfileRepositoryError.profilePersistenceFailed
    }

    let retainedIDs = Set(prepared.profile.authentication.credentialIDs)
    let retiredIDs =
      existingProfile?.authentication.credentialIDs.filter {
        !retainedIDs.contains($0)
      } ?? []
    return GhostteaSSHConnectionProfileMutation(
      profile: prepared.profile,
      credentialCleanupFailures: await removeCredentials(retiredIDs)
    )
  }

  public func delete(
    profileID: UUID
  ) async throws -> GhostteaSSHConnectionProfileMutation {
    var profiles = try await profileStore.load()
    guard let index = profiles.firstIndex(where: { $0.id == profileID }) else {
      throw GhostteaSSHConnectionProfileRepositoryError.missingProfile(profileID)
    }
    let removed = profiles.remove(at: index)
    do {
      try await profileStore.save(profiles)
    } catch {
      throw GhostteaSSHConnectionProfileRepositoryError.profilePersistenceFailed
    }
    return GhostteaSSHConnectionProfileMutation(
      profile: nil,
      credentialCleanupFailures: await removeCredentials(removed.authentication.credentialIDs)
    )
  }

  public func retryCredentialCleanup(
    _ credentialIDs: [SSHCredentialID]
  ) async -> [SSHCredentialID] {
    await removeCredentials(credentialIDs)
  }

  private func removeCredentials(
    _ credentialIDs: [SSHCredentialID]
  ) async -> [SSHCredentialID] {
    var failures: [SSHCredentialID] = []
    for credentialID in credentialIDs {
      do {
        try await credentialVault.remove(credentialID)
      } catch {
        failures.append(credentialID)
      }
    }
    return failures
  }
}
