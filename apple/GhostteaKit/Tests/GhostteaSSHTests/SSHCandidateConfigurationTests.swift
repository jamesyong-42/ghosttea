import Foundation
import GhostteaCredentials
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

  #expect(
    throws: SSHCandidateError.invalidTimeout(
      operation: "TCP connect",
      milliseconds: 0
    )
  ) {
    try SSHCandidateConfiguration(
      host: "localhost",
      knownHostsPath: "/tmp/known_hosts",
      authentication: .password(username: "user", password: "secret"),
      connectTimeoutMilliseconds: 0
    )
  }

  #expect(
    throws: SSHCandidateError.invalidTimeout(
      operation: "SSH handshake",
      milliseconds: Int(Int32.max) + 1
    )
  ) {
    try SSHCandidateConfiguration(
      host: "localhost",
      knownHostsPath: "/tmp/known_hosts",
      authentication: .password(username: "user", password: "secret"),
      handshakeTimeoutMilliseconds: Int(Int32.max) + 1
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
  #expect(configuration.connectTimeoutMilliseconds == 10_000)
  #expect(configuration.handshakeTimeoutMilliseconds == 10_000)
}

@Test func configurationRetainsOpaqueCredentialResolver() async throws {
  let credential = SSHCredentialID(
    connectionID: UUID(uuidString: "73BB90FB-6BD6-4167-A261-1226F78E824F")!,
    kind: .password
  )
  let expected = Data("resolved-only-during-authentication".utf8)
  let authentication = SSHCandidateAuthentication.passwordCredential(
    username: "ghosttea",
    credential: credential,
    resolver: { requested in
      #expect(requested == credential)
      return expected
    }
  )
  let configuration = try SSHCandidateConfiguration(
    host: "example.test",
    knownHostsPath: "/keys/known_hosts",
    authentication: authentication
  )

  guard
    case .passwordCredential(let username, let retainedID, let resolver) =
      configuration.authentication
  else {
    Issue.record("configuration did not retain the opaque credential resolver")
    return
  }
  #expect(username == "ghosttea")
  #expect(retainedID == credential)
  #expect(try await resolver(retainedID) == expected)
}

@Test func configurationRetainsHostKeyDecisionBoundary() async throws {
  let policy = SSHCandidateHostKeyPolicy.ask { challenge in
    #expect(challenge.host == "example.test")
    #expect(challenge.port == 2_222)
    #expect(challenge.algorithm == "ssh-ed25519")
    #expect(challenge.fingerprint == "SHA256:fixture")
    #expect(challenge.status == .unknown)
    return .acceptOnce
  }
  let configuration = try SSHCandidateConfiguration(
    host: "example.test",
    port: 2_222,
    knownHostsPath: "/tmp/known_hosts",
    hostKeyPolicy: policy,
    authentication: .password(username: "user", password: "secret")
  )
  guard case .ask(let responder) = configuration.hostKeyPolicy else {
    Issue.record("configuration did not retain host-key responder")
    return
  }
  let decision = try await responder(
    SSHCandidateHostKeyChallenge(
      host: "example.test",
      port: 2_222,
      algorithm: "ssh-ed25519",
      fingerprint: "SHA256:fixture",
      status: .unknown
    )
  )
  #expect(decision == .acceptOnce)
}

@Test func connectionObservesCancellationBeforeSocketWork() async throws {
  let configuration = try SSHCandidateConfiguration(
    host: "127.0.0.1",
    port: 9,
    knownHostsPath: "/tmp/known_hosts",
    authentication: .password(username: "user", password: "secret")
  )
  let transport = SSHCandidateTransport(configuration: configuration)
  let result = await Task {
    withUnsafeCurrentTask { task in
      task?.cancel()
    }
    return try await transport.connect()
  }.result

  switch result {
  case .success(let connection):
    await connection.disconnect()
    Issue.record("a pre-cancelled connection opened a socket")
  case .failure(let error):
    #expect(error is CancellationError)
  }
}

extension TerminalSize {
  fileprivate init(uncheckedColumns columns: Int, rows: Int) {
    try! self.init(columns: columns, rows: rows)
  }
}
