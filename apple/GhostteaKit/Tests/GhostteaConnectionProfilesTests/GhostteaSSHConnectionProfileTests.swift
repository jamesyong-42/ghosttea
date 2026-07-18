import Foundation
import GhostteaConnectionProfiles
import GhostteaCredentials
import GhostteaSSH
import Testing

private let profileID = UUID(uuidString: "11111111-1111-4111-8111-111111111111")!
private let connectionID = UUID(uuidString: "22222222-2222-4222-8222-222222222222")!

private actor InMemoryCredentialVault: GhostteaSSHCredentialVault {
  private var secrets: [SSHCredentialID: Data] = [:]
  private var removalFailures: Set<SSHCredentialID> = []

  func store(_ secret: Data, for credential: SSHCredentialID) {
    secrets[credential] = secret
  }

  func remove(_ credential: SSHCredentialID) throws {
    if removalFailures.contains(credential) { throw VaultFailure() }
    secrets.removeValue(forKey: credential)
  }

  func failRemoval(of credential: SSHCredentialID) {
    removalFailures.insert(credential)
  }

  func snapshot() -> [SSHCredentialID: Data] { secrets }

  private struct VaultFailure: Error {}
}

private func passwordProfile() throws -> GhostteaSSHConnectionProfile {
  try GhostteaSSHConnectionProfile(
    id: profileID,
    name: "Production",
    host: "terminal.example.com",
    port: 2222,
    username: "james",
    authentication: .password(
      credential: SSHCredentialID(connectionID: connectionID, kind: .password)
    ),
    attach: .tmux(sessionName: "main"),
    columns: 120,
    rows: 40
  )
}

@Test func profileEncodingIsVersionedAndContainsOnlyOpaqueCredentialIdentity() throws {
  let data = try JSONEncoder().encode(passwordProfile())
  let json = String(decoding: data, as: UTF8.self)

  #expect(json.contains("terminal.example.com"))
  #expect(json.contains(connectionID.uuidString.lowercased()))
  #expect(json.contains("password"))
  #expect(!json.contains("secret"))
  #expect(!json.contains("privateKeyData"))
  #expect(!json.contains("passphrase"))

  let decoded = try JSONDecoder().decode(GhostteaSSHConnectionProfile.self, from: data)
  let expected = try passwordProfile()
  #expect(decoded == expected)
}

@Test func profileStoreRoundTripsAtomicallyAndRejectsDuplicates() async throws {
  let directory = FileManager.default.temporaryDirectory.appendingPathComponent(
    "ghosttea-profile-tests-\(UUID().uuidString)",
    isDirectory: true
  )
  defer { try? FileManager.default.removeItem(at: directory) }
  let store = GhostteaSSHConnectionProfileStore(
    fileURL: directory.appendingPathComponent("profiles.json")
  )
  let profile = try passwordProfile()

  #expect(try await store.load().isEmpty)
  try await store.save([profile])
  #expect(try await store.load() == [profile])
  await #expect(throws: GhostteaSSHConnectionProfileError.duplicateProfileID(profileID)) {
    try await store.save([profile, profile])
  }
}

@Test func profileValidationRejectsCredentialConfusion() throws {
  #expect(throws: GhostteaSSHConnectionProfileError.invalidPasswordCredentialKind) {
    try GhostteaSSHConnectionProfile(
      name: "Invalid",
      host: "terminal.example.com",
      username: "james",
      authentication: .password(
        credential: SSHCredentialID(connectionID: connectionID, kind: .privateKey)
      )
    )
  }
  #expect(throws: GhostteaSSHConnectionProfileError.mismatchedCredentialConnection) {
    try GhostteaSSHConnectionProfile(
      name: "Invalid",
      host: "terminal.example.com",
      username: "james",
      authentication: .privateKey(
        privateKeyCredential: SSHCredentialID(
          connectionID: connectionID,
          kind: .privateKey
        ),
        passphraseCredential: SSHCredentialID(
          connectionID: UUID(),
          kind: .privateKeyPassphrase
        )
      )
    )
  }
}

@Test func keyboardInteractiveProfileRequiresRuntimeResponder() throws {
  let profile = try GhostteaSSHConnectionProfile(
    name: "Two factor",
    host: "terminal.example.com",
    username: "james",
    authentication: .keyboardInteractive
  )
  let store = try KeychainSSHCredentialStore(service: "com.vibecook.ghosttea.profile-tests")

  #expect(throws: GhostteaSSHConnectionProfileError.missingKeyboardInteractiveResponder) {
    try profile.configuration(
      knownHostsPath: "/tmp/ghosttea-profile-known-hosts",
      credentialStore: store
    )
  }
  _ = try profile.configuration(
    knownHostsPath: "/tmp/ghosttea-profile-known-hosts",
    credentialStore: store,
    keyboardInteractiveResponder: { challenge in
      Array(repeating: "", count: challenge.prompts.count)
    }
  )
}

@Test func profileDraftKeepsSecretBytesOutOfTheResultingProfile() throws {
  let draft = GhostteaSSHConnectionProfileDraft(
    id: profileID,
    name: "Production",
    host: "terminal.example.com",
    port: "2222",
    username: "james",
    authenticationKind: .privateKey,
    attachKind: .zellij,
    attachSessionName: "main",
    columns: "120",
    rows: "40"
  )
  let prepared = try GhostteaSSHConnectionProfileSaveRequest(
    draft: draft,
    credentialSubmission: .privateKey(
      privateKey: Data("private-key-secret".utf8),
      passphrase: Data("passphrase-secret".utf8)
    )
  ).prepare(existingProfile: nil, connectionID: connectionID)

  #expect(prepared.credentialWrites.count == 2)
  #expect(prepared.credentialWrites.map(\.credential.kind) == [.privateKey, .privateKeyPassphrase])
  let encoded = String(decoding: try JSONEncoder().encode(prepared.profile), as: UTF8.self)
  #expect(!encoded.contains("private-key-secret"))
  #expect(!encoded.contains("passphrase-secret"))
  #expect(prepared.profile.attach == .zellij(sessionName: "main"))
}

@Test func profileRepositoryReplacesCredentialsAndReportsRetiredCleanup() async throws {
  let directory = FileManager.default.temporaryDirectory.appendingPathComponent(
    "ghosttea-profile-repository-\(UUID().uuidString)",
    isDirectory: true
  )
  defer { try? FileManager.default.removeItem(at: directory) }
  let vault = InMemoryCredentialVault()
  let repository = GhostteaSSHConnectionProfileRepository(
    profileStore: GhostteaSSHConnectionProfileStore(
      fileURL: directory.appendingPathComponent("profiles.json")
    ),
    credentialVault: vault
  )
  let draft = GhostteaSSHConnectionProfileDraft(
    id: profileID,
    name: "Production",
    host: "terminal.example.com",
    username: "james"
  )
  let firstConnectionID = UUID(uuidString: "33333333-3333-4333-8333-333333333333")!
  let first = try await repository.save(
    GhostteaSSHConnectionProfileSaveRequest(
      draft: draft,
      credentialSubmission: .password(Data("first".utf8))
    ),
    connectionID: firstConnectionID
  )
  #expect(first.credentialCleanupFailures.isEmpty)
  let oldCredential = SSHCredentialID(connectionID: firstConnectionID, kind: .password)
  #expect((await vault.snapshot())[oldCredential] == Data("first".utf8))

  let secondConnectionID = UUID(uuidString: "44444444-4444-4444-8444-444444444444")!
  let second = try await repository.save(
    GhostteaSSHConnectionProfileSaveRequest(
      draft: draft,
      credentialSubmission: .password(Data("second".utf8))
    ),
    connectionID: secondConnectionID
  )
  let newCredential = SSHCredentialID(connectionID: secondConnectionID, kind: .password)
  #expect(second.credentialCleanupFailures.isEmpty)
  #expect((await vault.snapshot())[oldCredential] == nil)
  #expect((await vault.snapshot())[newCredential] == Data("second".utf8))
  #expect(try await repository.load().count == 1)

  await vault.failRemoval(of: newCredential)
  let deletion = try await repository.delete(profileID: profileID)
  #expect(deletion.credentialCleanupFailures == [newCredential])
  #expect(try await repository.load().isEmpty)
}

@Test func profileRepositoryRollsBackNewCredentialWhenProfilePersistenceFails() async throws {
  let directory = FileManager.default.temporaryDirectory.appendingPathComponent(
    "ghosttea-profile-rollback-\(UUID().uuidString)",
    isDirectory: true
  )
  defer { try? FileManager.default.removeItem(at: directory) }
  try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
  let blockedParent = directory.appendingPathComponent("not-a-directory")
  try Data("file".utf8).write(to: blockedParent)

  let vault = InMemoryCredentialVault()
  let repository = GhostteaSSHConnectionProfileRepository(
    profileStore: GhostteaSSHConnectionProfileStore(
      fileURL: blockedParent.appendingPathComponent("profiles.json")
    ),
    credentialVault: vault
  )
  let request = GhostteaSSHConnectionProfileSaveRequest(
    draft: GhostteaSSHConnectionProfileDraft(
      id: profileID,
      name: "Production",
      host: "terminal.example.com",
      username: "james"
    ),
    credentialSubmission: .password(Data("must-roll-back".utf8))
  )

  await #expect(throws: GhostteaSSHConnectionProfileRepositoryError.profilePersistenceFailed) {
    try await repository.save(request, connectionID: connectionID)
  }
  #expect(await vault.snapshot().isEmpty)
}
