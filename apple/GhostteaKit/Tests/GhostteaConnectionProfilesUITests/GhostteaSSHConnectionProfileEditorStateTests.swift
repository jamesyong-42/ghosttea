import Foundation
import GhostteaConnectionProfiles
import GhostteaConnectionProfilesUI
import GhostteaCredentials
import Testing

@Test func editorClearsTransientSecretsBeforeReturningARequest() throws {
  var state = GhostteaSSHConnectionProfileEditorState()
  state.draft = GhostteaSSHConnectionProfileDraft(
    name: "Production",
    host: "terminal.example.com",
    username: "james",
    authenticationKind: .privateKey
  )
  state.privateKey = "private-key-secret"
  state.usePrivateKeyPassphrase = true
  state.privateKeyPassphrase = "passphrase-secret"

  let request = try state.takeSaveRequest()

  #expect(state.password.isEmpty)
  #expect(state.privateKey.isEmpty)
  #expect(state.privateKeyPassphrase.isEmpty)
  guard case .privateKey(let privateKey, let passphrase) = request.credentialSubmission else {
    Issue.record("Expected a private-key submission")
    return
  }
  #expect(privateKey == Data("private-key-secret".utf8))
  #expect(passphrase == Data("passphrase-secret".utf8))
}

@Test func editorKeepsAnExistingCredentialOnlyForTheSameAuthenticationKind() throws {
  let credential = SSHCredentialID(connectionID: UUID(), kind: .password)
  let profile = try GhostteaSSHConnectionProfile(
    name: "Production",
    host: "terminal.example.com",
    username: "james",
    authentication: .password(credential: credential)
  )
  var state = GhostteaSSHConnectionProfileEditorState(profile: profile)

  #expect(try state.takeSaveRequest().credentialSubmission == .keepExisting)

  state.draft.authenticationKind = .privateKey
  #expect(throws: GhostteaSSHConnectionProfileDraftError.authenticationKindMismatch) {
    try state.takeSaveRequest()
  }
}
