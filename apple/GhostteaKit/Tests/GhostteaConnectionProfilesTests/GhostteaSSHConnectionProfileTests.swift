import Foundation
import GhostteaConnectionProfiles
import GhostteaCredentials
import GhostteaSSH
import Testing

private let profileID = UUID(uuidString: "11111111-1111-4111-8111-111111111111")!
private let connectionID = UUID(uuidString: "22222222-2222-4222-8222-222222222222")!

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
