import GhostteaTransport

public struct SSHKeyboardInteractivePrompt: Equatable, Sendable {
  public let text: String
  public let echoesResponse: Bool

  public init(text: String, echoesResponse: Bool) {
    self.text = text
    self.echoesResponse = echoesResponse
  }
}

public struct SSHKeyboardInteractiveChallenge: Equatable, Sendable {
  public let name: String
  public let instruction: String
  public let prompts: [SSHKeyboardInteractivePrompt]

  public init(
    name: String,
    instruction: String,
    prompts: [SSHKeyboardInteractivePrompt]
  ) {
    self.name = name
    self.instruction = instruction
    self.prompts = prompts
  }
}

public typealias SSHKeyboardInteractiveResponder =
  @Sendable (SSHKeyboardInteractiveChallenge) async throws -> [String]

public enum SSHCandidateAuthentication: Sendable {
  case password(username: String, password: String)
  case publicKey(
    username: String,
    publicKeyPath: String,
    privateKeyPath: String,
    passphrase: String?
  )
  case keyboardInteractive(
    username: String,
    responder: SSHKeyboardInteractiveResponder
  )
  case publicKeyThenKeyboardInteractive(
    username: String,
    publicKeyPath: String,
    privateKeyPath: String,
    passphrase: String?,
    responder: SSHKeyboardInteractiveResponder
  )
}

/// Phase 0 configuration for the libssh2 transport candidate.
///
/// Keyboard-interactive prompts cross an asynchronous responder boundary. The
/// synchronous libssh2 callback waits on a dedicated worker thread, so an app
/// may present UI without blocking a Swift cooperative executor.
public struct SSHCandidateConfiguration: Sendable {
  public let host: String
  public let port: Int
  public let knownHostsPath: String
  public let authentication: SSHCandidateAuthentication
  public let terminalType: String
  public let initialSize: TerminalSize

  public init(
    host: String,
    port: Int = 22,
    knownHostsPath: String,
    authentication: SSHCandidateAuthentication,
    terminalType: String = "xterm-256color",
    columns: Int = 80,
    rows: Int = 24
  ) throws {
    guard (1...65_535).contains(port) else {
      throw SSHCandidateError.invalidPort(port)
    }
    guard columns <= Int(Int32.max), rows <= Int(Int32.max) else {
      throw SSHCandidateError.terminalSizeOutOfRange(columns: columns, rows: rows)
    }
    self.host = host
    self.port = port
    self.knownHostsPath = knownHostsPath
    self.authentication = authentication
    self.terminalType = terminalType
    self.initialSize = try TerminalSize(columns: columns, rows: rows)
  }
}

public enum SSHCandidateError: Error, Equatable, Sendable {
  case invalidPort(Int)
  case terminalSizeOutOfRange(columns: Int, rows: Int)
  case socketConnect(String)
  case sessionAllocationFailed
  case operationFailed(operation: String, status: Int32, message: String)
  case hostKeyRejected(status: Int32)
  case authenticationFailed(status: Int32)
  case keyboardPromptMismatch(expected: Int, actual: Int)
  case keyboardBrokerFailed(String)
}

public struct SSHCandidateNegotiatedAlgorithms: Equatable, Sendable {
  public let keyExchange: String
  public let hostKey: String
  public let clientToServerCipher: String
  public let serverToClientCipher: String
  public let clientToServerMAC: String
  public let serverToClientMAC: String
}
