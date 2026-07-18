import Foundation
import GhostteaCore
import GhostteaCredentials
import GhostteaSession
import GhostteaTransport

public typealias GhostteaSSHHostKeyChallenge = SSHCandidateHostKeyChallenge
public typealias GhostteaSSHHostKeyDecision = SSHCandidateHostKeyDecision
public typealias GhostteaSSHHostKeyPolicy = SSHCandidateHostKeyPolicy
public typealias GhostteaSSHKeyboardInteractiveChallenge = SSHKeyboardInteractiveChallenge
public typealias GhostteaSSHKeyboardInteractiveResponder = SSHKeyboardInteractiveResponder

/// Product authentication methods. Secret-bearing password and key cases use
/// opaque references and deliberately cannot accept plaintext or file paths.
public enum GhostteaSSHAuthentication: Sendable {
  case password(
    username: String,
    credential: SSHCredentialID,
    store: KeychainSSHCredentialStore
  )
  case privateKey(
    username: String,
    privateKeyCredential: SSHCredentialID,
    passphraseCredential: SSHCredentialID?,
    store: KeychainSSHCredentialStore
  )
  case keyboardInteractive(
    username: String,
    responder: GhostteaSSHKeyboardInteractiveResponder
  )

  fileprivate func candidate() -> SSHCandidateAuthentication {
    switch self {
    case .password(let username, let credential, let store):
      return .passwordCredential(
        username: username,
        credential: credential,
        resolver: { try await store.require($0) }
      )
    case .privateKey(
      let username,
      let privateKeyCredential,
      let passphraseCredential,
      let store
    ):
      return .publicKeyCredential(
        username: username,
        privateKeyCredential: privateKeyCredential,
        passphraseCredential: passphraseCredential,
        resolver: { try await store.require($0) }
      )
    case .keyboardInteractive(let username, let responder):
      return .keyboardInteractive(username: username, responder: responder)
    }
  }
}

/// Product configuration for the Phase 0-selected libssh2 implementation.
///
/// The candidate types remain public for the device harness and compatibility
/// fixtures. Application code should enter the SSH stack through this type so
/// the implementation can change without becoming a workspace contract.
public struct GhostteaSSHConfiguration: Sendable {
  let candidate: SSHCandidateConfiguration

  public var host: String { candidate.host }
  public var port: Int { candidate.port }
  public var knownHostsPath: String { candidate.knownHostsPath }
  public var initialSize: TerminalSize { candidate.initialSize }

  public init(
    host: String,
    port: Int = 22,
    knownHostsPath: String,
    hostKeyPolicy: GhostteaSSHHostKeyPolicy = .strictKnownHosts,
    authentication: GhostteaSSHAuthentication,
    profile: GhostteaSSHAttachProfile = .shell,
    terminalType: String = "xterm-256color",
    columns: Int = 80,
    rows: Int = 24,
    connectTimeoutMilliseconds: Int = 10_000,
    handshakeTimeoutMilliseconds: Int = 10_000
  ) throws {
    candidate = try SSHCandidateConfiguration(
      host: host,
      port: port,
      knownHostsPath: knownHostsPath,
      hostKeyPolicy: hostKeyPolicy,
      authentication: authentication.candidate(),
      session: try profile.session(),
      terminalType: terminalType,
      columns: columns,
      rows: rows,
      connectTimeoutMilliseconds: connectTimeoutMilliseconds,
      handshakeTimeoutMilliseconds: handshakeTimeoutMilliseconds
    )
  }
}

/// Production name for the selected SSH transport.
public struct GhostteaSSHTransport: TerminalTransport {
  public let configuration: GhostteaSSHConfiguration

  public init(configuration: GhostteaSSHConfiguration) {
    self.configuration = configuration
  }

  public func connect() async throws -> any TerminalConnection {
    try await SSHCandidateTransport(configuration: configuration.candidate).connect()
  }
}

public enum GhostteaSSHAttachProfile: Equatable, Sendable {
  case shell
  case tmux(sessionName: String)
  case zellij(sessionName: String)

  func session() throws -> SSHCandidateSession {
    switch self {
    case .shell:
      return .shell
    case .tmux(let sessionName):
      return .command(
        "exec tmux new-session -A -s \(try shellArgument(sessionName))",
        allocatePTY: true
      )
    case .zellij(let sessionName):
      return .command(
        "exec zellij attach --create \(try shellArgument(sessionName))",
        allocatePTY: true
      )
    }
  }
}

public enum GhostteaSSHProfileError: Error, Equatable, Sendable {
  case invalidSessionName
}

public enum GhostteaSSHKnownHostsError: Error, Equatable, Sendable {
  case invalidPathComponent(String)
  case applicationSupportUnavailable
}

/// Prepares an app-private directory for the OpenSSH known-hosts file.
///
/// The native store performs atomic writes and preserves file permissions. On
/// iOS this directory additionally receives complete file protection.
public struct GhostteaSSHKnownHostsFile: Equatable, Sendable {
  public let applicationDirectoryName: String
  public let fileName: String

  public init(
    applicationDirectoryName: String = "Ghosttea",
    fileName: String = "known_hosts"
  ) throws {
    try validatePathComponent(applicationDirectoryName)
    try validatePathComponent(fileName)
    self.applicationDirectoryName = applicationDirectoryName
    self.fileName = fileName
  }

  public func prepare() throws -> String {
    guard
      let root = FileManager.default.urls(
        for: .applicationSupportDirectory,
        in: .userDomainMask
      ).first
    else {
      throw GhostteaSSHKnownHostsError.applicationSupportUnavailable
    }
    return try prepare(in: root)
  }

  /// Root-injectable variant used by package tests and app migrations.
  public func prepare(in applicationSupportRoot: URL) throws -> String {
    let directory =
      applicationSupportRoot
      .appendingPathComponent(applicationDirectoryName, isDirectory: true)
    let fileManager = FileManager.default
    try fileManager.createDirectory(
      at: directory,
      withIntermediateDirectories: true,
      attributes: protectionAttributes
    )
    #if os(iOS)
      try fileManager.setAttributes(protectionAttributes, ofItemAtPath: directory.path)
    #endif
    return directory.appendingPathComponent(fileName, isDirectory: false).path
  }
}

public enum GhostteaSSHFailurePolicy {
  public static func isReconnectable(_ error: any Error) -> Bool {
    if error is CancellationError { return false }
    if error is SSHCredentialStoreError { return false }
    guard let error = error as? SSHCandidateError else { return false }

    switch error {
    case .socketConnect, .operationTimedOut:
      return true
    case .operationFailed(let operation, _, _):
      let operation = operation.lowercased()
      return operation == "read channel"
        || operation == "write channel"
        || operation == "wait for socket readiness"
    case .invalidPort,
      .invalidTimeout,
      .terminalSizeOutOfRange,
      .connectorAllocationFailed,
      .sessionAllocationFailed,
      .hostKeyRejected,
      .hostKeyFingerprintUnavailable,
      .knownHostPersistenceFailed,
      .authenticationFailed,
      .keyboardPromptMismatch,
      .keyboardBrokerFailed,
      .credentialTooLarge,
      .credentialContainsNUL,
      .credentialKindMismatch:
      return false
    }
  }

  /// Returns a deliberately low-detail UI message. Native/library messages
  /// can include host or server-controlled content and must remain diagnostic.
  public static func description(_ error: any Error) -> String {
    if error is SSHCredentialStoreError { return "SSH credential unavailable" }
    guard let error = error as? SSHCandidateError else { return "SSH connection failed" }

    switch error {
    case .socketConnect:
      return "Unable to reach SSH host"
    case .operationTimedOut:
      return "SSH connection timed out"
    case .hostKeyRejected, .hostKeyFingerprintUnavailable, .knownHostPersistenceFailed:
      return "SSH host key verification failed"
    case .authenticationFailed,
      .keyboardPromptMismatch,
      .keyboardBrokerFailed,
      .credentialTooLarge,
      .credentialContainsNUL,
      .credentialKindMismatch:
      return "SSH authentication failed"
    case .operationFailed(let operation, _, _)
    where operation.lowercased().contains("authentication"):
      return "SSH authentication failed"
    default:
      return "SSH connection failed"
    }
  }
}

extension GhostteaSessionConfiguration {
  public static func ssh(
    inboundChunkBytes: Int = 64 * 1024,
    outboundMaxItems: Int = 256,
    outboundMaxBytes: Int = 2 * 1024 * 1024,
    initialPath: TerminalNetworkPath = .unknown
  ) -> Self {
    .init(
      inboundChunkBytes: inboundChunkBytes,
      outboundMaxItems: outboundMaxItems,
      outboundMaxBytes: outboundMaxBytes,
      initialPath: initialPath,
      errorIsReconnectable: GhostteaSSHFailurePolicy.isReconnectable,
      failureDescription: GhostteaSSHFailurePolicy.description
    )
  }
}

public enum GhostteaSSHSessionFactory {
  public static func make(
    terminal: GhostteaTerminal,
    ssh: GhostteaSSHConfiguration,
    session: GhostteaSessionConfiguration = .ssh(),
    eventHandler: @escaping GhostteaSessionEventHandler = { _ in }
  ) -> GhostteaSession {
    GhostteaSession(
      terminal: terminal,
      transport: GhostteaSSHTransport(configuration: ssh),
      configuration: session,
      eventHandler: eventHandler
    )
  }
}

private var protectionAttributes: [FileAttributeKey: Any] {
  #if os(iOS)
    [.protectionKey: FileProtectionType.complete]
  #else
    [:]
  #endif
}

private func validatePathComponent(_ component: String) throws {
  guard
    !component.isEmpty,
    component != ".",
    component != "..",
    !component.contains("/"),
    !component.contains("\0")
  else {
    throw GhostteaSSHKnownHostsError.invalidPathComponent(component)
  }
}

private func shellArgument(_ value: String) throws -> String {
  guard !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
    !value.contains("\0")
  else {
    throw GhostteaSSHProfileError.invalidSessionName
  }
  return "'" + value.replacingOccurrences(of: "'", with: "'\\''") + "'"
}
