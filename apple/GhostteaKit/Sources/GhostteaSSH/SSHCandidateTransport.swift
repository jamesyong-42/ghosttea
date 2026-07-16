import CGhostteaSSH
import Foundation
import GhostteaTransport

public struct SSHCandidateTransport: TerminalTransport {
  public let configuration: SSHCandidateConfiguration

  public init(configuration: SSHCandidateConfiguration) {
    self.configuration = configuration
  }

  public func connect() async throws -> any TerminalConnection {
    let socket = try await SSHDriver.connectSocket(
      host: configuration.host,
      port: configuration.port
    )
    guard let driver = SSHDriver(socket: socket) else {
      ghosttea_ssh_socket_close(socket)
      throw SSHCandidateError.sessionAllocationFailed
    }

    do {
      try await driver.run(operation: "handshake") {
        ghosttea_ssh_session_handshake($0)
      }

      let knownHostStatus = configuration.host.withCString { host in
        configuration.knownHostsPath.withCString { path in
          ghosttea_ssh_session_verify_known_host(
            driver.requiredHandle,
            host,
            Int32(configuration.port),
            path
          )
        }
      }
      guard knownHostStatus == GHOSTTEA_SSH_KNOWN_HOST_MATCH else {
        throw SSHCandidateError.hostKeyRejected(status: knownHostStatus)
      }
      let negotiatedAlgorithms = driver.negotiatedAlgorithms()

      try await authenticate(driver: driver, method: configuration.authentication)
      guard ghosttea_ssh_session_is_authenticated(driver.requiredHandle) == 1 else {
        throw SSHCandidateError.authenticationFailed(
          status: ghosttea_ssh_session_last_error(driver.requiredHandle, nil, 0)
        )
      }

      try await driver.run(operation: "open channel") {
        ghosttea_ssh_session_open_channel($0)
      }
      try await driver.run(operation: "request PTY") { handle in
        configuration.terminalType.withCString { terminalType in
          ghosttea_ssh_session_request_pty(
            handle,
            terminalType,
            Int32(configuration.initialSize.columns),
            Int32(configuration.initialSize.rows)
          )
        }
      }
      try await driver.run(operation: "start shell") {
        ghosttea_ssh_session_start_shell($0)
      }

      return SSHCandidateConnection(
        driver: driver,
        negotiatedAlgorithms: negotiatedAlgorithms
      )
    } catch {
      driver.destroy()
      throw error
    }
  }

  private func authenticate(
    driver: SSHDriver,
    method: SSHCandidateAuthentication
  ) async throws {
    switch method {
    case .password(let username, let password):
      try await driver.run(operation: "password authentication") { handle in
        username.withCString { username in
          password.withCString { password in
            ghosttea_ssh_session_auth_password(handle, username, password)
          }
        }
      }

    case .publicKey(let username, let publicKeyPath, let privateKeyPath, let passphrase):
      try await authenticatePublicKey(
        driver: driver,
        username: username,
        publicKeyPath: publicKeyPath,
        privateKeyPath: privateKeyPath,
        passphrase: passphrase
      )

    case .keyboardInteractive(let username, let answers):
      try await authenticateKeyboardInteractive(
        driver: driver,
        username: username,
        answers: answers
      )

    case .publicKeyThenKeyboardInteractive(
      let
        username,
      let
        publicKeyPath,
      let
        privateKeyPath,
      let
        passphrase,
      let
        answers
    ):
      let publicKeyStatus = await driver.runAllowingStatus(
        operation: "partial public-key authentication",
        allowedStatus: GHOSTTEA_SSH_PUBLICKEY_UNVERIFIED
      ) { handle in
        username.withCString { username in
          publicKeyPath.withCString { publicKeyPath in
            privateKeyPath.withCString { privateKeyPath in
              withOptionalCString(passphrase) { passphrase in
                ghosttea_ssh_session_auth_public_key(
                  handle,
                  username,
                  publicKeyPath,
                  privateKeyPath,
                  passphrase
                )
              }
            }
          }
        }
      }
      guard publicKeyStatus == 0 || publicKeyStatus == GHOSTTEA_SSH_PUBLICKEY_UNVERIFIED else {
        throw driver.error(
          operation: "partial public-key authentication",
          status: publicKeyStatus
        )
      }
      if ghosttea_ssh_session_is_authenticated(driver.requiredHandle) == 0 {
        try await authenticateKeyboardInteractive(
          driver: driver,
          username: username,
          answers: answers
        )
      }
    }
  }

  private func authenticatePublicKey(
    driver: SSHDriver,
    username: String,
    publicKeyPath: String,
    privateKeyPath: String,
    passphrase: String?
  ) async throws {
    try await driver.run(operation: "public-key authentication") { handle in
      username.withCString { username in
        publicKeyPath.withCString { publicKeyPath in
          privateKeyPath.withCString { privateKeyPath in
            withOptionalCString(passphrase) { passphrase in
              ghosttea_ssh_session_auth_public_key(
                handle,
                username,
                publicKeyPath,
                privateKeyPath,
                passphrase
              )
            }
          }
        }
      }
    }
  }

  private func authenticateKeyboardInteractive(
    driver: SSHDriver,
    username: String,
    answers: [String]
  ) async throws {
    ghosttea_ssh_session_reset_keyboard_answers(driver.requiredHandle)
    for answer in answers {
      let status = answer.withCString {
        ghosttea_ssh_session_add_keyboard_answer(driver.requiredHandle, $0)
      }
      guard status == 0 else {
        throw driver.error(operation: "store keyboard-interactive answer", status: status)
      }
    }
    try await driver.run(operation: "keyboard-interactive authentication") { handle in
      username.withCString { username in
        ghosttea_ssh_session_auth_keyboard_interactive(handle, username)
      }
    }
    let promptCount = Int(
      ghosttea_ssh_session_keyboard_prompt_count(driver.requiredHandle)
    )
    guard promptCount == answers.count else {
      throw SSHCandidateError.keyboardPromptMismatch(
        expected: answers.count,
        actual: promptCount
      )
    }
  }
}

public final class SSHCandidateConnection: TerminalConnection, @unchecked Sendable {
  public let negotiatedAlgorithms: SSHCandidateNegotiatedAlgorithms

  private let driver: SSHDriver
  private let gate = AsyncOperationGate()
  private var isConnected = true

  fileprivate init(
    driver: SSHDriver,
    negotiatedAlgorithms: SSHCandidateNegotiatedAlgorithms
  ) {
    self.driver = driver
    self.negotiatedAlgorithms = negotiatedAlgorithms
  }

  public func read(maxBytes: Int) async throws -> Data? {
    guard maxBytes > 0 else {
      throw TerminalTransportError.invalidReadSize(maxBytes)
    }
    await gate.acquire()
    do {
      let result = try await readLocked(maxBytes: maxBytes)
      await gate.release()
      return result
    } catch {
      await gate.release()
      throw error
    }
  }

  public func write(_ bytes: Data) async throws {
    await gate.acquire()
    do {
      try requireConnected()
      var offset = 0
      while offset < bytes.count {
        try Task.checkCancellation()
        let status = bytes.withUnsafeBytes { rawBuffer -> Int in
          let start = rawBuffer.baseAddress!.advanced(by: offset)
          return ghosttea_ssh_session_write(
            driver.requiredHandle,
            start.assumingMemoryBound(to: UInt8.self),
            bytes.count - offset
          )
        }
        if status > 0 {
          offset += status
        } else if status == Int(GHOSTTEA_SSH_EAGAIN) {
          try await driver.waitUntilReady()
        } else {
          throw driver.error(
            operation: "write channel",
            status: Int32(clamping: status)
          )
        }
      }
      await gate.release()
    } catch {
      await gate.release()
      throw error
    }
  }

  public func resize(columns: Int, rows: Int) async throws {
    _ = try TerminalSize(columns: columns, rows: rows)
    guard columns <= Int(Int32.max), rows <= Int(Int32.max) else {
      throw SSHCandidateError.terminalSizeOutOfRange(columns: columns, rows: rows)
    }
    await gate.acquire()
    do {
      try requireConnected()
      try await driver.run(operation: "resize PTY") {
        ghosttea_ssh_session_resize($0, Int32(columns), Int32(rows))
      }
      await gate.release()
    } catch {
      await gate.release()
      throw error
    }
  }

  public func interrupt() async throws {
    await gate.acquire()
    do {
      try requireConnected()
      try await driver.run(operation: "send interrupt") {
        ghosttea_ssh_session_signal_interrupt($0)
      }
      await gate.release()
    } catch {
      await gate.release()
      throw error
    }
  }

  public func disconnect() async {
    driver.requestShutdown()
    await gate.acquire()
    isConnected = false
    driver.destroy()
    await gate.release()
  }

  private func readLocked(maxBytes: Int) async throws -> Data? {
    try requireConnected()
    var data = Data(count: maxBytes)
    while true {
      try Task.checkCancellation()
      let status = data.withUnsafeMutableBytes { rawBuffer in
        ghosttea_ssh_session_read(
          driver.requiredHandle,
          rawBuffer.baseAddress!.assumingMemoryBound(to: UInt8.self),
          maxBytes
        )
      }
      if status > 0 {
        data.removeSubrange(Int(status)..<data.count)
        return data
      }
      if status == 0,
        ghosttea_ssh_session_is_eof(driver.requiredHandle) == 1
      {
        return nil
      }
      if status == 0 || status == GHOSTTEA_SSH_EAGAIN {
        try await driver.waitUntilReady()
        continue
      }
      throw driver.error(
        operation: "read channel",
        status: Int32(clamping: status)
      )
    }
  }

  private func requireConnected() throws {
    guard isConnected else {
      throw TerminalTransportError.disconnected
    }
  }
}

private final class SSHDriver: @unchecked Sendable {
  private static let socketQueue = DispatchQueue(
    label: "com.project100.ghosttea.ssh.socket",
    qos: .userInitiated,
    attributes: .concurrent
  )

  private let stateLock = NSLock()
  private var handle: OpaquePointer?

  var requiredHandle: OpaquePointer {
    stateLock.withLock {
      precondition(handle != nil, "SSH driver used after destruction")
      return handle!
    }
  }

  init?(socket: Int32) {
    guard let handle = ghosttea_ssh_session_create(socket) else {
      return nil
    }
    self.handle = handle
  }

  deinit {
    destroy()
  }

  static func connectSocket(host: String, port: Int) async throws -> Int32 {
    let result = await withCheckedContinuation { continuation in
      socketQueue.async {
        var errorBuffer = [CChar](repeating: 0, count: 512)
        let socket = host.withCString { host in
          String(port).withCString { port in
            ghosttea_ssh_tcp_connect(
              host,
              port,
              &errorBuffer,
              errorBuffer.count
            )
          }
        }
        if socket >= 0 {
          continuation.resume(returning: Result<Int32, SSHCandidateError>.success(socket))
        } else {
          continuation.resume(
            returning: .failure(.socketConnect(decodeCString(errorBuffer)))
          )
        }
      }
    }
    return try result.get()
  }

  func run(
    operation: String,
    _ body: (OpaquePointer) -> Int32
  ) async throws {
    let status = await runAllowingStatus(
      operation: operation,
      allowedStatus: 0,
      body
    )
    guard status == 0 else {
      throw error(operation: operation, status: status)
    }
  }

  func runAllowingStatus(
    operation: String,
    allowedStatus: Int32,
    _ body: (OpaquePointer) -> Int32
  ) async -> Int32 {
    while true {
      if Task.isCancelled {
        return Int32(GHOSTTEA_SSH_EAGAIN)
      }
      let status = body(requiredHandle)
      if status == 0 || status == allowedStatus {
        return status
      }
      if status != GHOSTTEA_SSH_EAGAIN {
        return status
      }
      do {
        try await waitUntilReady()
      } catch {
        return ghosttea_ssh_session_last_error(requiredHandle, nil, 0)
      }
    }
  }

  func waitUntilReady() async throws {
    while true {
      try Task.checkCancellation()
      let status = await withCheckedContinuation { continuation in
        Self.socketQueue.async { [self] in
          continuation.resume(
            returning: ghosttea_ssh_session_wait(requiredHandle, 100)
          )
        }
      }
      if status > 0 {
        return
      }
      if status < 0 {
        throw error(operation: "wait for socket readiness", status: status)
      }
    }
  }

  func requestShutdown() {
    stateLock.withLock {
      if let handle {
        ghosttea_ssh_session_shutdown_socket(handle)
      }
    }
  }

  func negotiatedAlgorithms() -> SSHCandidateNegotiatedAlgorithms {
    SSHCandidateNegotiatedAlgorithms(
      keyExchange: decodeCString(ghosttea_ssh_session_negotiated_kex(requiredHandle)),
      hostKey: decodeCString(ghosttea_ssh_session_negotiated_host_key(requiredHandle)),
      clientToServerCipher: decodeCString(
        ghosttea_ssh_session_negotiated_cipher_client_to_server(requiredHandle)
      ),
      serverToClientCipher: decodeCString(
        ghosttea_ssh_session_negotiated_cipher_server_to_client(requiredHandle)
      ),
      clientToServerMAC: decodeCString(
        ghosttea_ssh_session_negotiated_mac_client_to_server(requiredHandle)
      ),
      serverToClientMAC: decodeCString(
        ghosttea_ssh_session_negotiated_mac_server_to_client(requiredHandle)
      )
    )
  }

  func destroy() {
    let oldHandle = stateLock.withLock {
      let oldHandle = handle
      handle = nil
      return oldHandle
    }
    if let oldHandle {
      ghosttea_ssh_session_destroy(oldHandle)
    }
  }

  func error(operation: String, status: Int32) -> SSHCandidateError {
    var buffer = [CChar](repeating: 0, count: 512)
    _ = ghosttea_ssh_session_last_error(
      requiredHandle,
      &buffer,
      buffer.count
    )
    return .operationFailed(
      operation: operation,
      status: status,
      message: decodeCString(buffer)
    )
  }
}

private func withOptionalCString<Result>(
  _ string: String?,
  _ body: (UnsafePointer<CChar>?) throws -> Result
) rethrows -> Result {
  guard let string else { return try body(nil) }
  return try string.withCString(body)
}

private func decodeCString(_ buffer: [CChar]) -> String {
  String(
    decoding: buffer.prefix { $0 != 0 }.map { UInt8(bitPattern: $0) },
    as: UTF8.self
  )
}

private func decodeCString(_ string: UnsafePointer<CChar>?) -> String {
  guard let string else { return "" }
  return String(cString: string)
}
