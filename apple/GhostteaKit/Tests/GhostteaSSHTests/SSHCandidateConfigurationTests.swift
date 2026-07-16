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

@Test func configurationRetainsCandidateAuthenticationSequence() throws {
  let authentication = SSHCandidateAuthentication.publicKeyThenKeyboardInteractive(
    username: "ghosttea",
    publicKeyPath: "/keys/id_ed25519.pub",
    privateKeyPath: "/keys/id_ed25519",
    passphrase: nil,
    answers: ["password", "123456"]
  )
  let configuration = try SSHCandidateConfiguration(
    host: "127.0.0.1",
    port: 22_024,
    knownHostsPath: "/keys/known_hosts",
    authentication: authentication,
    columns: 132,
    rows: 41
  )

  #expect(configuration.authentication == authentication)
  #expect(configuration.initialSize == TerminalSize(uncheckedColumns: 132, rows: 41))
}

extension TerminalSize {
  fileprivate init(uncheckedColumns columns: Int, rows: Int) {
    try! self.init(columns: columns, rows: rows)
  }
}
