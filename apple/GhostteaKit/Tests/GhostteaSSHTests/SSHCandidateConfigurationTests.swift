import GhostteaTransport
import Testing

@testable import GhostteaSSH

@Test func configurationValidatesPortAndTerminalSize() throws {
  #expect(throws: SSHCandidateError.invalidPort(0)) {
    try SSHCandidateConfiguration(
      host: "localhost",
      port: 0,
      knownHostsPath: "/tmp/known_hosts",
      authentication: .password(username: "user", password: "secret")
    )
  }

  #expect(throws: TerminalTransportError.invalidTerminalSize(columns: 0, rows: 24)) {
    try SSHCandidateConfiguration(
      host: "localhost",
      knownHostsPath: "/tmp/known_hosts",
      authentication: .password(username: "user", password: "secret"),
      columns: 0
    )
  }

  #expect(
    throws: SSHCandidateError.terminalSizeOutOfRange(
      columns: Int(Int32.max) + 1,
      rows: 24
    )
  ) {
    try SSHCandidateConfiguration(
      host: "localhost",
      knownHostsPath: "/tmp/known_hosts",
      authentication: .password(username: "user", password: "secret"),
      columns: Int(Int32.max) + 1
    )
  }
}

@Test func configurationRetainsCandidateAuthenticationSequence() async throws {
  let responder: SSHKeyboardInteractiveResponder = { challenge in
    challenge.prompts.map(\.text)
  }
  let authentication = SSHCandidateAuthentication.publicKeyThenKeyboardInteractive(
    username: "ghosttea",
    publicKeyPath: "/keys/id_ed25519.pub",
    privateKeyPath: "/keys/id_ed25519",
    passphrase: nil,
    responder: responder
  )
  let configuration = try SSHCandidateConfiguration(
    host: "127.0.0.1",
    port: 22_024,
    knownHostsPath: "/keys/known_hosts",
    authentication: authentication,
    columns: 132,
    rows: 41
  )

  guard
    case .publicKeyThenKeyboardInteractive(
      let username,
      let publicKeyPath,
      let privateKeyPath,
      nil,
      let retainedResponder
    ) = configuration.authentication
  else {
    Issue.record("configuration did not retain chained authentication")
    return
  }
  #expect(username == "ghosttea")
  #expect(publicKeyPath == "/keys/id_ed25519.pub")
  #expect(privateKeyPath == "/keys/id_ed25519")
  let answers = try await retainedResponder(
    SSHKeyboardInteractiveChallenge(
      name: "fixture",
      instruction: "answer",
      prompts: [
        SSHKeyboardInteractivePrompt(text: "password", echoesResponse: false),
        SSHKeyboardInteractivePrompt(text: "123456", echoesResponse: true),
      ]
    )
  )
  #expect(answers == ["password", "123456"])
  #expect(configuration.initialSize == TerminalSize(uncheckedColumns: 132, rows: 41))
}

extension TerminalSize {
  fileprivate init(uncheckedColumns columns: Int, rows: Int) {
    try! self.init(columns: columns, rows: rows)
  }
}
