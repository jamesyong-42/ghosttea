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
      port: configuration.port,
      timeoutMilliseconds: configuration.connectTimeoutMilliseconds
    )
    guard let driver = SSHDriver(socket: socket) else {
      ghosttea_ssh_socket_close(socket)
      throw SSHCandidateError.sessionAllocationFailed
    }

    do {
      try await driver.run(
        operation: "SSH handshake",
        timeoutMilliseconds: configuration.handshakeTimeoutMilliseconds
      ) {
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
      switch configuration.session {
      case .shell:
        try await requestPTY(driver: driver)
        try await driver.run(operation: "start shell") {
          ghosttea_ssh_session_start_shell($0)
        }
      case .command(let command, let allocatePTY):
        if allocatePTY {
          try await requestPTY(driver: driver)
        }
        try await driver.run(operation: "start command") { handle in
          command.withCString {
            ghosttea_ssh_session_start_command(handle, $0)
          }
        }
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

  private func requestPTY(driver: SSHDriver) async throws {
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

    case .keyboardInteractive(let username, let responder):
      try await authenticateKeyboardInteractive(
        driver: driver,
        username: username,
        responder: responder
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
        responder
    ):
      let publicKeyStatus = try await driver.runAllowingStatus(
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
          responder: responder
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
    responder: @escaping SSHKeyboardInteractiveResponder
  ) async throws {
    ghosttea_ssh_session_keyboard_broker_begin(driver.requiredHandle)
    do {
      try await withTaskCancellationHandler {
        while true {
          try Task.checkCancellation()
          let status = try await performKeyboardInteractiveCall(
            driver: driver,
            username: username,
            responder: responder
          )
          if status == 0 {
            return
          }
          guard status == GHOSTTEA_SSH_EAGAIN else {
            throw driver.error(
              operation: "keyboard-interactive authentication",
              status: status
            )
          }
          try await driver.waitUntilReady()
        }
      } onCancel: {
        driver.cancelKeyboardBroker()
      }
    } catch {
      driver.cancelKeyboardBroker()
      throw error
    }
  }

  private func performKeyboardInteractiveCall(
    driver: SSHDriver,
    username: String,
    responder: @escaping SSHKeyboardInteractiveResponder
  ) async throws -> Int32 {
    let resultLatch = KeyboardAuthenticationResultLatch()
    let authentication = Task {
      let status = await driver.invokeKeyboardAuthentication(username: username)
      await resultLatch.store(status)
      return status
    }
    do {
      while true {
        try Task.checkCancellation()
        if let status = await resultLatch.value() {
          return status
        }
        let promptStatus = await driver.waitForKeyboardPrompt()
        if let status = await resultLatch.value() {
          return status
        }
        if promptStatus < 0 {
          throw SSHCandidateError.keyboardBrokerFailed("prompt wait was cancelled")
        }
        guard promptStatus > 0 else { continue }
        let challenge = try driver.keyboardChallenge()
        let answers = try await responder(challenge)
        guard answers.count == challenge.prompts.count else {
          throw SSHCandidateError.keyboardPromptMismatch(
            expected: challenge.prompts.count,
            actual: answers.count
          )
        }
        try driver.submitKeyboardAnswers(answers)
      }
    } catch {
      driver.cancelKeyboardBroker()
      _ = await authentication.value
      throw error
    }
  }
}

private actor KeyboardAuthenticationResultLatch {
  private var result: Int32?

  func store(_ result: Int32) {
    self.result = result
  }

  func value() -> Int32? {
    result
  }
}

public final class SSHCandidateConnection: TerminalConnection, @unchecked Sendable {
  public let negotiatedAlgorithms: SSHCandidateNegotiatedAlgorithms

  private let driver: SSHDriver
  private let gate = AsyncOperationGate()
  private var isConnected = true
  private var exitStatus: TerminalExitStatus?
  private var standardOutputBytesDelivered: UInt64 = 0
  private var standardErrorBytesDelivered: UInt64 = 0
  private var bytesWritten: UInt64 = 0

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
          bytesWritten &+= UInt64(status)
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

  public func finishInput() async throws {
    await gate.acquire()
    do {
      try requireConnected()
      try await driver.run(operation: "send channel EOF") {
        ghosttea_ssh_session_send_eof($0)
      }
      await gate.release()
    } catch {
      await gate.release()
      throw error
    }
  }

  public func readStandardError(maxBytes: Int) async throws -> Data? {
    guard maxBytes > 0 else {
      throw TerminalTransportError.invalidReadSize(maxBytes)
    }
    await gate.acquire()
    do {
      let result = try await readLocked(maxBytes: maxBytes, stream: .standardError)
      await gate.release()
      return result
    } catch {
      await gate.release()
      throw error
    }
  }

  public func readCommandOutput(maxBytes: Int) async throws -> SSHCandidateOutputChunk? {
    guard maxBytes > 0 else {
      throw TerminalTransportError.invalidReadSize(maxBytes)
    }
    await gate.acquire()
    do {
      try requireConnected()
      while true {
        try Task.checkCancellation()
        if let bytes = try readAvailableLocked(
          maxBytes: maxBytes,
          stream: .standardOutput
        ) {
          await gate.release()
          return .standardOutput(bytes)
        }
        if let bytes = try readAvailableLocked(
          maxBytes: maxBytes,
          stream: .standardError
        ) {
          await gate.release()
          return .standardError(bytes)
        }
        if ghosttea_ssh_session_is_eof(driver.requiredHandle) == 1 {
          await gate.release()
          return nil
        }
        try await driver.waitUntilReady()
      }
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

  public func waitForExit() async throws -> TerminalExitStatus {
    await gate.acquire()
    do {
      try requireConnected()
      if let exitStatus {
        await gate.release()
        return exitStatus
      }
      try await driver.run(operation: "wait for channel EOF") {
        ghosttea_ssh_session_wait_eof($0)
      }
      try await driver.run(operation: "close channel") {
        ghosttea_ssh_session_close_channel($0)
      }
      try await driver.run(operation: "wait for channel close") {
        ghosttea_ssh_session_wait_closed($0)
      }
      let result: TerminalExitStatus
      if let signalName = try driver.exitSignal() {
        result = .signaled(name: signalName)
      } else {
        result = .exited(
          code: ghosttea_ssh_session_exit_status(driver.requiredHandle)
        )
      }
      exitStatus = result
      await gate.release()
      return result
    } catch {
      await gate.release()
      throw error
    }
  }

  public func flowControlMetrics() async throws -> SSHCandidateFlowControlMetrics {
    await gate.acquire()
    do {
      try requireConnected()
      var channelBytesAvailable: UInt = 0
      var initialReceiveWindowBytes: UInt = 0
      let receiveWindowBytes = ghosttea_ssh_session_receive_window(
        driver.requiredHandle,
        &channelBytesAvailable,
        &initialReceiveWindowBytes
      )
      let result = SSHCandidateFlowControlMetrics(
        standardOutputBytesDelivered: standardOutputBytesDelivered,
        standardErrorBytesDelivered: standardErrorBytesDelivered,
        bytesWritten: bytesWritten,
        socketWaitCalls: driver.socketWaitCalls,
        receiveWindowBytes: UInt64(receiveWindowBytes),
        channelBytesAvailable: UInt64(channelBytesAvailable),
        initialReceiveWindowBytes: UInt64(initialReceiveWindowBytes)
      )
      await gate.release()
      return result
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

  private func readLocked(
    maxBytes: Int,
    stream: SSHReadStream = .standardOutput
  ) async throws -> Data? {
    try requireConnected()
    var data = Data(count: maxBytes)
    while true {
      try Task.checkCancellation()
      let status = data.withUnsafeMutableBytes { rawBuffer in
        let buffer = rawBuffer.baseAddress!.assumingMemoryBound(to: UInt8.self)
        switch stream {
        case .standardOutput:
          return ghosttea_ssh_session_read(
            driver.requiredHandle,
            buffer,
            maxBytes
          )
        case .standardError:
          return ghosttea_ssh_session_read_stderr(
            driver.requiredHandle,
            buffer,
            maxBytes
          )
        }
      }
      if status > 0 {
        data.removeSubrange(Int(status)..<data.count)
        recordDeliveredBytes(Int(status), stream: stream)
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

  private func readAvailableLocked(
    maxBytes: Int,
    stream: SSHReadStream
  ) throws -> Data? {
    var data = Data(count: maxBytes)
    let status = data.withUnsafeMutableBytes { rawBuffer in
      let buffer = rawBuffer.baseAddress!.assumingMemoryBound(to: UInt8.self)
      switch stream {
      case .standardOutput:
        return ghosttea_ssh_session_read(driver.requiredHandle, buffer, maxBytes)
      case .standardError:
        return ghosttea_ssh_session_read_stderr(driver.requiredHandle, buffer, maxBytes)
      }
    }
    if status > 0 {
      data.removeSubrange(Int(status)..<data.count)
      recordDeliveredBytes(Int(status), stream: stream)
      return data
    }
    if status == 0 || status == GHOSTTEA_SSH_EAGAIN {
      return nil
    }
    throw driver.error(
      operation: "read command stream",
      status: Int32(clamping: status)
    )
  }

  private func requireConnected() throws {
    guard isConnected else {
      throw TerminalTransportError.disconnected
    }
  }

  private func recordDeliveredBytes(_ count: Int, stream: SSHReadStream) {
    switch stream {
    case .standardOutput:
      standardOutputBytesDelivered &+= UInt64(count)
    case .standardError:
      standardErrorBytesDelivered &+= UInt64(count)
    }
  }
}

private enum SSHReadStream {
  case standardOutput
  case standardError
}

private struct SSHConnectResult: Sendable {
  let status: Int32
  let message: String
}

private final class SSHConnector: @unchecked Sendable {
  private let handle: OpaquePointer

  init?() {
    guard let handle = ghosttea_ssh_connector_create() else {
      return nil
    }
    self.handle = handle
  }

  deinit {
    ghosttea_ssh_connector_destroy(handle)
  }

  func cancel() {
    ghosttea_ssh_connector_cancel(handle)
  }

  func connect(
    host: String,
    port: Int,
    timeoutMilliseconds: Int
  ) -> SSHConnectResult {
    var errorBuffer = [CChar](repeating: 0, count: 512)
    let status = host.withCString { host in
      String(port).withCString { port in
        ghosttea_ssh_connector_run(
          handle,
          host,
          port,
          Int32(timeoutMilliseconds),
          &errorBuffer,
          errorBuffer.count
        )
      }
    }
    return SSHConnectResult(status: status, message: decodeCString(errorBuffer))
  }
}

private final class SSHDriver: @unchecked Sendable {
  private static let socketQueue = DispatchQueue(
    label: "com.project100.ghosttea.ssh.socket",
    qos: .userInitiated,
    attributes: .concurrent
  )
  private static let keyboardQueue = DispatchQueue(
    label: "com.project100.ghosttea.ssh.keyboard",
    qos: .userInitiated,
    attributes: .concurrent
  )

  private let stateLock = NSLock()
  private var handle: OpaquePointer?
  private var _socketWaitCalls: UInt64 = 0

  var socketWaitCalls: UInt64 {
    stateLock.withLock { _socketWaitCalls }
  }

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

  static func connectSocket(
    host: String,
    port: Int,
    timeoutMilliseconds: Int
  ) async throws -> Int32 {
    guard let connector = SSHConnector() else {
      throw SSHCandidateError.connectorAllocationFailed
    }
    let result = await withTaskCancellationHandler {
      await withCheckedContinuation { continuation in
        socketQueue.async {
          continuation.resume(
            returning: connector.connect(
              host: host,
              port: port,
              timeoutMilliseconds: timeoutMilliseconds
            )
          )
        }
      }
    } onCancel: {
      connector.cancel()
    }
    if result.status >= 0 {
      if Task.isCancelled {
        ghosttea_ssh_socket_close(result.status)
        throw CancellationError()
      }
      return result.status
    }
    if result.status == GHOSTTEA_SSH_CONNECT_CANCELLED || Task.isCancelled {
      throw CancellationError()
    }
    if result.status == GHOSTTEA_SSH_CONNECT_TIMEOUT {
      throw SSHCandidateError.operationTimedOut(
        operation: "TCP connect",
        milliseconds: timeoutMilliseconds
      )
    }
    throw SSHCandidateError.socketConnect(result.message)
  }

  func run(
    operation: String,
    timeoutMilliseconds: Int? = nil,
    _ body: (OpaquePointer) -> Int32
  ) async throws {
    let deadline = timeoutMilliseconds.map {
      ContinuousClock.now.advanced(by: .milliseconds($0))
    }
    while true {
      try Task.checkCancellation()
      let status = body(requiredHandle)
      if status == 0 {
        return
      }
      if status != GHOSTTEA_SSH_EAGAIN {
        throw error(operation: operation, status: status)
      }
      if let deadline,
        let timeoutMilliseconds,
        ContinuousClock.now >= deadline
      {
        throw SSHCandidateError.operationTimedOut(
          operation: operation,
          milliseconds: timeoutMilliseconds
        )
      }
      _ = try await waitOnce()
    }
  }

  func runAllowingStatus(
    operation: String,
    allowedStatus: Int32,
    _ body: (OpaquePointer) -> Int32
  ) async throws -> Int32 {
    while true {
      try Task.checkCancellation()
      let status = body(requiredHandle)
      if status == 0 || status == allowedStatus {
        return status
      }
      if status != GHOSTTEA_SSH_EAGAIN {
        return status
      }
      try await waitUntilReady()
    }
  }

  func waitUntilReady() async throws {
    while true {
      if try await waitOnce() {
        return
      }
    }
  }

  private func waitOnce() async throws -> Bool {
    try Task.checkCancellation()
    stateLock.withLock {
      _socketWaitCalls &+= 1
    }
    let status = await withCheckedContinuation { continuation in
      Self.socketQueue.async { [self] in
        continuation.resume(
          returning: ghosttea_ssh_session_wait(requiredHandle, 100)
        )
      }
    }
    try Task.checkCancellation()
    if status < 0 {
      throw error(operation: "wait for socket readiness", status: status)
    }
    return status > 0
  }

  func requestShutdown() {
    stateLock.withLock {
      if let handle {
        ghosttea_ssh_session_shutdown_socket(handle)
      }
    }
  }

  func invokeKeyboardAuthentication(username: String) async -> Int32 {
    await withCheckedContinuation { continuation in
      Self.keyboardQueue.async { [self] in
        let status = username.withCString {
          ghosttea_ssh_session_auth_keyboard_interactive(requiredHandle, $0)
        }
        continuation.resume(returning: status)
      }
    }
  }

  func waitForKeyboardPrompt() async -> Int32 {
    await withCheckedContinuation { continuation in
      Self.keyboardQueue.async { [self] in
        continuation.resume(
          returning: ghosttea_ssh_session_keyboard_broker_wait(requiredHandle, 50)
        )
      }
    }
  }

  func keyboardChallenge() throws -> SSHKeyboardInteractiveChallenge {
    let name = try keyboardBrokerString(ghosttea_ssh_session_keyboard_broker_name)
    let instruction = try keyboardBrokerString(
      ghosttea_ssh_session_keyboard_broker_instruction
    )
    let promptCount = ghosttea_ssh_session_keyboard_broker_prompt_count(requiredHandle)
    guard promptCount >= 0 else {
      throw SSHCandidateError.keyboardBrokerFailed("invalid prompt count")
    }
    var prompts: [SSHKeyboardInteractivePrompt] = []
    prompts.reserveCapacity(Int(promptCount))
    for index in 0..<promptCount {
      var echo: Int32 = 0
      let text = try keyboardBrokerString { handle, buffer, length in
        ghosttea_ssh_session_keyboard_broker_prompt(
          handle,
          index,
          buffer,
          length,
          &echo
        )
      }
      prompts.append(
        SSHKeyboardInteractivePrompt(text: text, echoesResponse: echo != 0)
      )
    }
    return SSHKeyboardInteractiveChallenge(
      name: name,
      instruction: instruction,
      prompts: prompts
    )
  }

  func submitKeyboardAnswers(_ answers: [String]) throws {
    for answer in answers {
      let status = answer.withCString {
        ghosttea_ssh_session_keyboard_broker_add_answer(requiredHandle, $0)
      }
      guard status == 0 else {
        throw SSHCandidateError.keyboardBrokerFailed("could not store an answer")
      }
    }
    guard ghosttea_ssh_session_keyboard_broker_complete(requiredHandle) == 0 else {
      throw SSHCandidateError.keyboardBrokerFailed("answer count changed")
    }
  }

  func cancelKeyboardBroker() {
    stateLock.withLock {
      if let handle {
        ghosttea_ssh_session_keyboard_broker_cancel(handle)
      }
    }
  }

  private func keyboardBrokerString(
    _ copy: (OpaquePointer, UnsafeMutablePointer<CChar>?, Int) -> Int32
  ) throws -> String {
    let length = copy(requiredHandle, nil, 0)
    guard length >= 0 else {
      throw SSHCandidateError.keyboardBrokerFailed("prompt text was unavailable")
    }
    var buffer = [CChar](repeating: 0, count: Int(length) + 1)
    guard copy(requiredHandle, &buffer, buffer.count) == length else {
      throw SSHCandidateError.keyboardBrokerFailed("prompt text changed while copying")
    }
    return decodeCString(buffer)
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

  func exitSignal() throws -> String? {
    let length = ghosttea_ssh_session_exit_signal(requiredHandle, nil, 0)
    guard length >= 0 else {
      throw error(operation: "read channel exit signal", status: length)
    }
    guard length > 0 else {
      return nil
    }
    var buffer = [CChar](repeating: 0, count: Int(length) + 1)
    let copiedLength = ghosttea_ssh_session_exit_signal(
      requiredHandle,
      &buffer,
      buffer.count
    )
    guard copiedLength == length else {
      throw error(operation: "copy channel exit signal", status: copiedLength)
    }
    return decodeCString(buffer)
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
