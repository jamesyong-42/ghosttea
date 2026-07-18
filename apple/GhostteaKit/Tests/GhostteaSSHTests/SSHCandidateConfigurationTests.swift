import Darwin
import Foundation
import GhostteaCredentials
import GhostteaSession
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

@Test func configurationRetainsOpaquePrivateKeyResolver() async throws {
  let connectionID = UUID(uuidString: "12BD069C-2890-4893-A1BE-3BB66BFB2BC7")!
  let privateKeyCredential = SSHCredentialID(
    connectionID: connectionID,
    kind: .privateKey
  )
  let passphraseCredential = SSHCredentialID(
    connectionID: connectionID,
    kind: .privateKeyPassphrase
  )
  let privateKey = Data("private-key".utf8)
  let passphrase = Data("passphrase".utf8)
  let authentication = SSHCandidateAuthentication.publicKeyCredential(
    username: "ghosttea",
    privateKeyCredential: privateKeyCredential,
    passphraseCredential: passphraseCredential,
    resolver: { requested in
      switch requested.kind {
      case .privateKey:
        return privateKey
      case .privateKeyPassphrase:
        return passphrase
      case .password:
        Issue.record("unexpected password credential request")
        return Data()
      }
    }
  )
  let configuration = try SSHCandidateConfiguration(
    host: "example.test",
    knownHostsPath: "/keys/known_hosts",
    authentication: authentication
  )

  guard
    case .publicKeyCredential(
      let username,
      let retainedPrivateKey,
      let retainedPassphrase,
      let resolver
    ) = configuration.authentication
  else {
    Issue.record("configuration did not retain private-key credentials")
    return
  }
  #expect(username == "ghosttea")
  #expect(retainedPrivateKey == privateKeyCredential)
  #expect(retainedPassphrase == passphraseCredential)
  #expect(try await resolver(retainedPrivateKey) == privateKey)
  #expect(try await resolver(retainedPassphrase!) == passphrase)
}

@Test func configurationRejectsMismatchedCredentialKinds() throws {
  let connectionID = UUID(uuidString: "1BB465D6-E38D-46C2-BC92-042C5B7C02E3")!
  let passwordCredential = SSHCredentialID(connectionID: connectionID, kind: .password)
  let privateKeyCredential = SSHCredentialID(connectionID: connectionID, kind: .privateKey)

  #expect(
    throws: SSHCandidateError.credentialKindMismatch(
      expected: .privateKey,
      actual: .password
    )
  ) {
    try SSHCandidateConfiguration(
      host: "example.test",
      knownHostsPath: "/keys/known_hosts",
      authentication: .publicKeyCredential(
        username: "ghosttea",
        privateKeyCredential: passwordCredential,
        passphraseCredential: nil,
        resolver: { _ in Data() }
      )
    )
  }

  #expect(
    throws: SSHCandidateError.credentialKindMismatch(
      expected: .privateKeyPassphrase,
      actual: .password
    )
  ) {
    try SSHCandidateConfiguration(
      host: "example.test",
      knownHostsPath: "/keys/known_hosts",
      authentication: .publicKeyCredential(
        username: "ghosttea",
        privateKeyCredential: privateKeyCredential,
        passphraseCredential: passwordCredential,
        resolver: { _ in Data() }
      )
    )
  }
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

@Test func productionConfigurationBuildsSafeAttachProfiles() throws {
  let authentication = GhostteaSSHAuthentication.keyboardInteractive(
    username: "ghosttea",
    responder: { _ in [] }
  )
  let tmux = try GhostteaSSHConfiguration(
    host: "example.test",
    knownHostsPath: "/tmp/known_hosts",
    authentication: authentication,
    profile: .tmux(sessionName: "team's work"),
    columns: 132,
    rows: 41
  )
  let zellij = try GhostteaSSHConfiguration(
    host: "example.test",
    knownHostsPath: "/tmp/known_hosts",
    authentication: authentication,
    profile: .zellij(sessionName: "main")
  )

  #expect(
    tmux.candidate.session
      == .command(
        "exec tmux new-session -A -s 'team'\\''s work'",
        allocatePTY: true
      )
  )
  #expect(
    zellij.candidate.session
      == .command(
        "exec zellij attach --create 'main'",
        allocatePTY: true
      )
  )
  #expect(tmux.initialSize == TerminalSize(uncheckedColumns: 132, rows: 41))

  #expect(throws: GhostteaSSHProfileError.invalidSessionName) {
    try GhostteaSSHConfiguration(
      host: "example.test",
      knownHostsPath: "/tmp/known_hosts",
      authentication: authentication,
      profile: .tmux(sessionName: "  ")
    )
  }
}

@Test func productionAuthenticationRetainsOnlyOpaqueKeychainReferences() throws {
  let connectionID = UUID(uuidString: "42F18E0C-AB32-44D4-B183-EF5CA727149E")!
  let privateKey = SSHCredentialID(connectionID: connectionID, kind: .privateKey)
  let passphrase = SSHCredentialID(connectionID: connectionID, kind: .privateKeyPassphrase)
  let store = try KeychainSSHCredentialStore(service: "com.vibecook.ghosttea.tests.production")
  let configuration = try GhostteaSSHConfiguration(
    host: "example.test",
    knownHostsPath: "/tmp/known_hosts",
    authentication: .privateKey(
      username: "ghosttea",
      privateKeyCredential: privateKey,
      passphraseCredential: passphrase,
      store: store
    )
  )

  guard
    case .publicKeyCredential(
      let username,
      let retainedPrivateKey,
      let retainedPassphrase,
      _
    ) = configuration.candidate.authentication
  else {
    Issue.record("production authentication did not map to opaque key references")
    return
  }
  #expect(username == "ghosttea")
  #expect(retainedPrivateKey == privateKey)
  #expect(retainedPassphrase == passphrase)
}

@Test func knownHostsFilePreparesAnAppPrivatePath() throws {
  let root = FileManager.default.temporaryDirectory.appendingPathComponent(
    UUID().uuidString,
    isDirectory: true
  )
  defer { try? FileManager.default.removeItem(at: root) }

  let file = try GhostteaSSHKnownHostsFile(
    applicationDirectoryName: "GhostteaTests",
    fileName: "known_hosts"
  )
  let path = try file.prepare(in: root)

  var isDirectory: ObjCBool = false
  #expect(
    FileManager.default.fileExists(
      atPath: root.appendingPathComponent("GhostteaTests").path,
      isDirectory: &isDirectory
    )
  )
  #expect(isDirectory.boolValue)
  #expect(path == root.appendingPathComponent("GhostteaTests/known_hosts").path)
  #expect(!FileManager.default.fileExists(atPath: path))

  #expect(throws: GhostteaSSHKnownHostsError.invalidPathComponent("../escape")) {
    try GhostteaSSHKnownHostsFile(applicationDirectoryName: "../escape")
  }
}

@Test func productionFailurePolicyClassifiesWithoutLeakingNativeMessages() {
  let networkFailure = SSHCandidateError.socketConnect("secret.internal:22 refused")
  let authenticationFailure = SSHCandidateError.operationFailed(
    operation: "password authentication",
    status: -18,
    message: "server says secret-token"
  )
  let commandFailure = SSHCandidateError.operationFailed(
    operation: "start command",
    status: -1,
    message: "tmux missing at /private/server/path"
  )

  #expect(GhostteaSSHFailurePolicy.isReconnectable(networkFailure))
  #expect(!GhostteaSSHFailurePolicy.isReconnectable(authenticationFailure))
  #expect(!GhostteaSSHFailurePolicy.isReconnectable(commandFailure))
  #expect(GhostteaSSHFailurePolicy.description(networkFailure) == "Unable to reach SSH host")
  #expect(
    GhostteaSSHFailurePolicy.description(authenticationFailure)
      == "SSH authentication failed"
  )
  #expect(!GhostteaSSHFailurePolicy.description(authenticationFailure).contains("secret-token"))
  #expect(!GhostteaSSHFailurePolicy.description(commandFailure).contains("/private/server/path"))
}

@Test func productionSessionConfigurationInstallsSSHFailurePolicy() {
  let wifiPath = TerminalNetworkPath(
    availability: .satisfied,
    interfaces: [.wifi]
  )
  let configuration = GhostteaSessionConfiguration.ssh(
    inboundChunkBytes: 8_192,
    outboundMaxItems: 32,
    outboundMaxBytes: 65_536,
    initialPath: wifiPath
  )
  let authenticationFailure = SSHCandidateError.authenticationFailed(status: -18)

  #expect(configuration.inboundChunkBytes == 8_192)
  #expect(configuration.outboundMaxItems == 32)
  #expect(configuration.outboundMaxBytes == 65_536)
  #expect(configuration.initialPath == wifiPath)
  #expect(!configuration.errorIsReconnectable(authenticationFailure))
  #expect(configuration.failureDescription(authenticationFailure) == "SSH authentication failed")
}

@Test func connectionObservesCancellationBeforeSocketWork() async throws {
  let configuration = try SSHCandidateConfiguration(
    host: "never-resolve.ghosttea.invalid.",
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

@Test func connectorResolvesHostnameBeforeOpeningSocket() async throws {
  let listener = Darwin.socket(AF_INET, SOCK_STREAM, 0)
  #expect(listener >= 0)
  guard listener >= 0 else { return }
  defer { Darwin.close(listener) }

  var address = sockaddr_in()
  address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
  address.sin_family = sa_family_t(AF_INET)
  address.sin_addr = in_addr(s_addr: inet_addr("127.0.0.1"))
  let addressLength = socklen_t(MemoryLayout<sockaddr_in>.size)
  let bindStatus = withUnsafePointer(to: &address) { pointer in
    pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
      Darwin.bind(listener, $0, addressLength)
    }
  }
  #expect(bindStatus == 0)
  guard bindStatus == 0 else { return }
  #expect(Darwin.listen(listener, 1) == 0)

  var boundAddress = sockaddr_in()
  var boundAddressLength = addressLength
  let nameStatus = withUnsafeMutablePointer(to: &boundAddress) { pointer in
    pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
      Darwin.getsockname(listener, $0, &boundAddressLength)
    }
  }
  #expect(nameStatus == 0)
  guard nameStatus == 0 else { return }

  let connected = try await SSHSocketConnector.connect(
    host: "localhost",
    port: Int(UInt16(bigEndian: boundAddress.sin_port)),
    timeoutMilliseconds: 1_000
  )
  #expect(connected >= 0)
  Darwin.close(connected)
}

@Test func connectorCancelsPendingHostnameResolution() async throws {
  let hostname = "ghosttea-\(UUID().uuidString.lowercased()).local."
  let connection = Task {
    try await SSHSocketConnector.connect(
      host: hostname,
      port: 9,
      timeoutMilliseconds: 10_000
    )
  }
  try await Task.sleep(for: .milliseconds(20))
  let cancelledAt = ContinuousClock.now
  connection.cancel()

  switch await connection.result {
  case .success(let socket):
    Darwin.close(socket)
    Issue.record("a cancelled DNS lookup opened a socket")
  case .failure(let error):
    #expect(error is CancellationError)
  }
  #expect(ContinuousClock.now - cancelledAt < .seconds(1))
}

extension TerminalSize {
  fileprivate init(uncheckedColumns columns: Int, rows: Int) {
    try! self.init(columns: columns, rows: rows)
  }
}
