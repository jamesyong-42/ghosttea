import Foundation
import GhostteaSSH
import GhostteaTransport

#if canImport(Darwin)
  import Darwin
#endif

private enum LiveProbeError: Error, CustomStringConvertible {
  case usage
  case invalidPort(String)
  case unexpectedEOF
  case markerBufferExceeded(String)
  case unexpectedTerminalSize(expected: String, output: String)
  case corruptFloodByte(UInt8)
  case floodSize(expected: Int, actual: Int)
  case stalledMemoryExceeded(limitBytes: Int, actualBytes: Int)
  case stalledReadPrefetched(before: UInt64, after: UInt64)
  case stalledSocketRead(before: UInt64, after: UInt64)
  case deliveredMetricTooSmall(expectedMinimum: UInt64, actual: UInt64)
  case socketMetricTooSmall(expectedMinimum: UInt64, actual: UInt64)
  case readCompletedInsteadOfCancelling
  case unexpectedCancellationError(String)
  case cancellationTooSlow(Duration)
  case missingCandidateConnection
  case unexpectedAlgorithms(SSHCandidateNegotiatedAlgorithms)
  case unexpectedChallenge(SSHKeyboardInteractiveChallenge)
  case authenticationDidNotCancel
  case cancellationStressIterationFailed(kind: String, iteration: Int, error: String)
  case unexpectedAuthenticationCancellationError(String)
  case handshakeDidNotTimeOut
  case handshakeDidNotCancel
  case unexpectedHandshakeControlError(String)
  case unexpectedCommandStream(stream: String, expected: Data, actual: Data)
  case unexpectedExitStatus(expected: TerminalExitStatus, actual: TerminalExitStatus)

  var description: String {
    switch self {
    case .usage:
      return "usage: GhostteaSSHLiveProbe MODE HOST PORT KNOWN_HOSTS PUBLIC_KEY PRIVATE_KEY"
    case .invalidPort(let value):
      return "invalid port: \(value)"
    case .unexpectedEOF:
      return "SSH channel reached EOF before the expected marker"
    case .markerBufferExceeded(let marker):
      return "SSH probe buffered more than 1 MiB while waiting for \(marker)"
    case .unexpectedTerminalSize(let expected, let output):
      return "expected terminal size \(expected), received \(String(reflecting: output))"
    case .corruptFloodByte(let byte):
      return "flood payload contained nonzero byte \(byte)"
    case .floodSize(let expected, let actual):
      return "flood payload size mismatch: expected \(expected), received \(actual)"
    case .stalledMemoryExceeded(let limitBytes, let actualBytes):
      return "stalled SSH process exceeded \(limitBytes) bytes RSS: \(actualBytes)"
    case .stalledReadPrefetched(let before, let after):
      return "stalled SSH connection prefetched bytes into Swift: before=\(before) after=\(after)"
    case .stalledSocketRead(let before, let after):
      return "stalled SSH connection consumed socket bytes: before=\(before) after=\(after)"
    case .deliveredMetricTooSmall(let expectedMinimum, let actual):
      return
        "SSH delivered-byte metric is too small: expected at least \(expectedMinimum), received \(actual)"
    case .socketMetricTooSmall(let expectedMinimum, let actual):
      return
        "SSH socket-byte metric is too small: expected at least \(expectedMinimum), received \(actual)"
    case .readCompletedInsteadOfCancelling:
      return "blocked SSH read completed instead of observing task cancellation"
    case .unexpectedCancellationError(let error):
      return "blocked SSH read failed with \(error) instead of CancellationError"
    case .cancellationTooSlow(let duration):
      return "blocked SSH read took \(duration) to observe cancellation"
    case .missingCandidateConnection:
      return "SSH transport did not return its candidate connection type"
    case .unexpectedAlgorithms(let algorithms):
      return "SSH fixture negotiated unexpected algorithms: \(algorithms)"
    case .unexpectedChallenge(let challenge):
      return "SSH fixture produced an unexpected keyboard challenge: \(challenge)"
    case .authenticationDidNotCancel:
      return "keyboard-interactive authentication completed instead of cancelling"
    case .cancellationStressIterationFailed(let kind, let iteration, let error):
      return "\(kind) cancellation stress failed at iteration \(iteration): \(error)"
    case .unexpectedAuthenticationCancellationError(let error):
      return "keyboard-interactive cancellation failed with \(error)"
    case .handshakeDidNotTimeOut:
      return "SSH handshake completed instead of reaching its deadline"
    case .handshakeDidNotCancel:
      return "SSH handshake completed instead of observing task cancellation"
    case .unexpectedHandshakeControlError(let error):
      return "SSH handshake control failed with \(error)"
    case .unexpectedCommandStream(let stream, let expected, let actual):
      return
        "unexpected \(stream): expected \(String(reflecting: expected)), received \(String(reflecting: actual))"
    case .unexpectedExitStatus(let expected, let actual):
      return "unexpected exit status: expected \(expected), received \(actual)"
    }
  }
}

private struct ProbeReader {
  let connection: any TerminalConnection
  var pending = Data()

  mutating func readThrough(marker: String) async throws -> Data {
    let markerBytes = Data(marker.utf8)
    while true {
      if let range = pending.range(of: markerBytes) {
        let result = Data(pending[..<range.upperBound])
        pending.removeSubrange(..<range.upperBound)
        return result
      }
      guard pending.count <= 1_048_576 else {
        throw LiveProbeError.markerBufferExceeded(marker)
      }
      guard let bytes = try await connection.read(maxBytes: 16_384) else {
        throw LiveProbeError.unexpectedEOF
      }
      pending.append(bytes)
    }
  }

  mutating func countZeroBytes(through marker: String) async throws -> Int {
    let markerBytes = Data(marker.utf8)
    var payloadBytes = 0

    while true {
      if let range = pending.range(of: markerBytes) {
        try validateZeros(pending[..<range.lowerBound])
        payloadBytes += range.lowerBound
        pending.removeSubrange(..<range.upperBound)
        return payloadBytes
      }

      let retainedBytes = min(pending.count, markerBytes.count - 1)
      let consumedBytes = pending.count - retainedBytes
      if consumedBytes > 0 {
        try validateZeros(pending.prefix(consumedBytes))
        payloadBytes += consumedBytes
        pending.removeSubrange(..<consumedBytes)
      }

      guard let bytes = try await connection.read(maxBytes: 32_768) else {
        throw LiveProbeError.unexpectedEOF
      }
      pending.append(bytes)
    }
  }

  private func validateZeros(_ bytes: Data.SubSequence) throws {
    if let byte = bytes.first(where: { $0 != 0 }) {
      throw LiveProbeError.corruptFloodByte(byte)
    }
  }
}

private func authentication(
  mode: String,
  publicKeyPath: String,
  privateKeyPath: String
) throws -> SSHCandidateAuthentication {
  switch mode {
  case "password", "handshake-timeout", "handshake-cancel", "handshake-cancel-stress":
    return .password(username: "ghosttea", password: "ghosttea-password")
  case "publickey", "command", "half-close", "signal", "ecdsa-aesgcm", "rsa-sha2":
    return .publicKey(
      username: "ghosttea",
      publicKeyPath: publicKeyPath,
      privateKeyPath: privateKeyPath,
      passphrase: nil
    )
  case "encrypted-key":
    return .publicKey(
      username: "ghosttea",
      publicKeyPath: publicKeyPath,
      privateKeyPath: privateKeyPath,
      passphrase: "ghosttea-key-passphrase"
    )
  case "encrypted-key-wrong-passphrase":
    return .publicKey(
      username: "ghosttea",
      publicKeyPath: publicKeyPath,
      privateKeyPath: privateKeyPath,
      passphrase: "incorrect-passphrase"
    )
  case "keyboard":
    return .keyboardInteractive(
      username: "ghosttea",
      responder: respondToFixtureChallenge
    )
  case "keyboard-cancel", "keyboard-cancel-stress":
    return .keyboardInteractive(username: "ghosttea") { _ in
      try await Task.sleep(for: .seconds(60))
      return []
    }
  case "partial":
    return .publicKeyThenKeyboardInteractive(
      username: "ghosttea",
      publicKeyPath: publicKeyPath,
      privateKeyPath: privateKeyPath,
      passphrase: nil,
      responder: respondToFixtureChallenge
    )
  default:
    throw LiveProbeError.usage
  }
}

private func respondToFixtureChallenge(
  _ challenge: SSHKeyboardInteractiveChallenge
) async throws -> [String] {
  try await Task.sleep(for: .milliseconds(10))
  guard challenge.name.isEmpty, challenge.instruction.isEmpty else {
    throw LiveProbeError.unexpectedChallenge(challenge)
  }
  switch challenge.prompts {
  case []:
    return []
  case [SSHKeyboardInteractivePrompt(text: "Fixture password: ", echoesResponse: false)]:
    return ["ghosttea-password"]
  case [SSHKeyboardInteractivePrompt(text: "Verification code: ", echoesResponse: true)]:
    return ["123456"]
  default:
    throw LiveProbeError.unexpectedChallenge(challenge)
  }
}

private func runProbe() async throws {
  let arguments = CommandLine.arguments
  guard arguments.count == 7 else { throw LiveProbeError.usage }
  let mode = arguments[1]
  let host = arguments[2]
  guard let port = Int(arguments[3]) else {
    throw LiveProbeError.invalidPort(arguments[3])
  }
  let knownHostsPath = arguments[4]
  let publicKeyPath = arguments[5]
  let privateKeyPath = arguments[6]
  let session: SSHCandidateSession
  switch mode {
  case "command":
    session = .command(
      "printf 'fixture-stdout\\n'; printf 'fixture-stderr\\n' >&2; exit 37",
      allocatePTY: false
    )
  case "half-close":
    session = .command("cat", allocatePTY: false)
  case "signal":
    session = .command("kill -TERM $$", allocatePTY: false)
  default:
    session = .shell
  }

  let configuration = try SSHCandidateConfiguration(
    host: host,
    port: port,
    knownHostsPath: knownHostsPath,
    authentication: try authentication(
      mode: mode,
      publicKeyPath: publicKeyPath,
      privateKeyPath: privateKeyPath
    ),
    session: session,
    columns: 132,
    rows: 41,
    handshakeTimeoutMilliseconds: mode == "handshake-timeout" ? 250 : 10_000
  )
  let transport = SSHCandidateTransport(configuration: configuration)
  if mode == "keyboard-cancel" {
    try await verifyAuthenticationCancellation(transport: transport)
    return
  }
  if mode == "keyboard-cancel-stress" {
    try await verifyAuthenticationCancellationStress(transport: transport)
    return
  }
  if mode == "handshake-timeout" {
    try await verifyHandshakeTimeout(transport: transport)
    return
  }
  if mode == "handshake-cancel" {
    try await verifyHandshakeCancellation(transport: transport)
    return
  }
  if mode == "handshake-cancel-stress" {
    try await verifyHandshakeCancellationStress(transport: transport)
    return
  }
  let connection = try await transport.connect()
  guard let candidateConnection = connection as? SSHCandidateConnection else {
    throw LiveProbeError.missingCandidateConnection
  }
  try verifyAlgorithms(candidateConnection.negotiatedAlgorithms, mode: mode)
  if mode == "command" || mode == "half-close" || mode == "signal" {
    do {
      try await verifyCommandSession(
        mode: mode,
        connection: candidateConnection
      )
      await connection.disconnect()
      print("Swift nonblocking libssh2 \(mode) probe passed")
      return
    } catch {
      await connection.disconnect()
      throw error
    }
  }
  var reader = ProbeReader(connection: connection)

  do {
    try await connection.write(
      Data("stty -echo; printf 'GHOSTTEA_%s\\n' READY\n".utf8)
    )
    _ = try await reader.readThrough(marker: "GHOSTTEA_READY")

    if mode == "publickey" {
      try await verifyTerminalSize(
        expected: "41 132",
        connection: connection,
        reader: &reader
      )
      try await connection.resize(columns: 140, rows: 50)
      try await verifyTerminalSize(
        expected: "50 140",
        connection: connection,
        reader: &reader
      )
      try await verifyStalledFlood(connection: candidateConnection, reader: &reader)
      try await verifyReadCancellation(connection: connection, reader: &reader)
    }

    await connection.disconnect()
    print("Swift nonblocking libssh2 \(mode) probe passed")
  } catch {
    await connection.disconnect()
    throw error
  }
}

private func verifyHandshakeTimeout(
  transport: SSHCandidateTransport
) async throws {
  let clock = ContinuousClock()
  let start = clock.now
  let result = await Task { try await transport.connect() }.result
  let duration = start.duration(to: clock.now)
  switch result {
  case .success(let connection):
    await connection.disconnect()
    throw LiveProbeError.handshakeDidNotTimeOut
  case .failure(let error):
    guard
      error as? SSHCandidateError
        == .operationTimedOut(operation: "SSH handshake", milliseconds: 250)
    else {
      throw LiveProbeError.unexpectedHandshakeControlError(String(describing: error))
    }
  }
  guard duration < .seconds(2) else {
    throw LiveProbeError.cancellationTooSlow(duration)
  }
  print("Swift SSH handshake deadline fired in \(duration)")
}

private func verifyHandshakeCancellation(
  transport: SSHCandidateTransport,
  cancellationDelay: Duration = .milliseconds(500),
  shouldPrint: Bool = true
) async throws {
  let connectionTask = Task { try await transport.connect() }
  try await Task.sleep(for: cancellationDelay)
  let clock = ContinuousClock()
  let start = clock.now
  connectionTask.cancel()
  let result = await connectionTask.result
  switch result {
  case .success(let connection):
    await connection.disconnect()
    throw LiveProbeError.handshakeDidNotCancel
  case .failure(let error):
    guard error is CancellationError else {
      throw LiveProbeError.unexpectedHandshakeControlError(String(describing: error))
    }
  }
  let duration = start.duration(to: clock.now)
  guard duration < .seconds(1) else {
    throw LiveProbeError.cancellationTooSlow(duration)
  }
  if shouldPrint {
    print("Swift SSH handshake observed cancellation in \(duration)")
  }
}

private func verifyHandshakeCancellationStress(
  transport: SSHCandidateTransport
) async throws {
  let iterations = 32
  for iteration in 1...iterations {
    do {
      try await verifyHandshakeCancellation(
        transport: transport,
        cancellationDelay: .milliseconds(25),
        shouldPrint: false
      )
    } catch {
      throw LiveProbeError.cancellationStressIterationFailed(
        kind: "handshake",
        iteration: iteration,
        error: String(describing: error)
      )
    }
  }
  print("Swift SSH handshake cancellation stress passed \(iterations) iterations")
}

private func verifyCommandSession(
  mode: String,
  connection: SSHCandidateConnection
) async throws {
  let expectedStandardOutput: Data
  let expectedExitStatus: TerminalExitStatus
  if mode == "signal" {
    expectedStandardOutput = Data()
    expectedExitStatus = .signaled(name: "TERM")
  } else if mode == "half-close" {
    expectedStandardOutput = Data("half-close-payload\n".utf8)
    expectedExitStatus = .exited(code: 0)
    try await connection.write(expectedStandardOutput)
    try await connection.finishInput()
  } else {
    expectedStandardOutput = Data("fixture-stdout\n".utf8)
    expectedExitStatus = .exited(code: 37)
  }

  var standardOutput = Data()
  var standardError = Data()
  while let chunk = try await connection.readCommandOutput(maxBytes: 4_096) {
    switch chunk {
    case .standardOutput(let bytes):
      standardOutput.append(bytes)
    case .standardError(let bytes):
      standardError.append(bytes)
    }
  }
  let status = try await connection.waitForExit()
  guard standardOutput == expectedStandardOutput else {
    throw LiveProbeError.unexpectedCommandStream(
      stream: "stdout",
      expected: expectedStandardOutput,
      actual: standardOutput
    )
  }
  let expectedStandardError = mode == "command" ? Data("fixture-stderr\n".utf8) : Data()
  guard standardError == expectedStandardError else {
    throw LiveProbeError.unexpectedCommandStream(
      stream: "stderr",
      expected: expectedStandardError,
      actual: standardError
    )
  }
  guard status == expectedExitStatus else {
    throw LiveProbeError.unexpectedExitStatus(
      expected: expectedExitStatus,
      actual: status
    )
  }
  print(
    "Swift command streams and termination passed: stdout=\(standardOutput.count) stderr=\(standardError.count) termination=\(status)"
  )
}

private func verifyAuthenticationCancellation(
  transport: SSHCandidateTransport,
  cancellationDelay: Duration = .milliseconds(500),
  shouldPrint: Bool = true
) async throws {
  let connectionTask = Task {
    try await transport.connect()
  }
  try await Task.sleep(for: cancellationDelay)
  let clock = ContinuousClock()
  let start = clock.now
  connectionTask.cancel()
  let result = await connectionTask.result
  switch result {
  case .success(let connection):
    await connection.disconnect()
    throw LiveProbeError.authenticationDidNotCancel
  case .failure(let error):
    guard error is CancellationError else {
      throw LiveProbeError.unexpectedAuthenticationCancellationError(
        String(describing: error)
      )
    }
  }
  let duration = start.duration(to: clock.now)
  guard duration < .seconds(1) else {
    throw LiveProbeError.cancellationTooSlow(duration)
  }
  if shouldPrint {
    print("Swift keyboard-interactive responder cancelled in \(duration)")
  }
}

private func verifyAuthenticationCancellationStress(
  transport: SSHCandidateTransport
) async throws {
  let iterations = 16
  for iteration in 1...iterations {
    do {
      try await verifyAuthenticationCancellation(
        transport: transport,
        cancellationDelay: .milliseconds(100),
        shouldPrint: false
      )
    } catch {
      throw LiveProbeError.cancellationStressIterationFailed(
        kind: "keyboard-interactive",
        iteration: iteration,
        error: String(describing: error)
      )
    }
  }
  print("Swift keyboard-interactive cancellation stress passed \(iterations) iterations")
}

private func verifyAlgorithms(
  _ algorithms: SSHCandidateNegotiatedAlgorithms,
  mode: String
) throws {
  if mode == "ecdsa-aesgcm" {
    guard
      algorithms.keyExchange == "curve25519-sha256",
      algorithms.hostKey == "ecdsa-sha2-nistp256",
      algorithms.clientToServerCipher == "aes256-gcm@openssh.com",
      algorithms.serverToClientCipher == "aes256-gcm@openssh.com",
      algorithms.clientToServerMAC == "INTEGRATED-AES-GCM",
      algorithms.serverToClientMAC == "INTEGRATED-AES-GCM"
    else {
      throw LiveProbeError.unexpectedAlgorithms(algorithms)
    }
    print("Swift negotiated ECDSA/AES-GCM SSH algorithms: \(algorithms)")
    return
  }
  if mode == "rsa-sha2" {
    guard
      algorithms.keyExchange == "curve25519-sha256",
      algorithms.hostKey == "rsa-sha2-512",
      algorithms.clientToServerCipher == "chacha20-poly1305@openssh.com",
      algorithms.serverToClientCipher == "chacha20-poly1305@openssh.com",
      algorithms.clientToServerMAC == "hmac-sha2-256",
      algorithms.serverToClientMAC == "hmac-sha2-256"
    else {
      throw LiveProbeError.unexpectedAlgorithms(algorithms)
    }
    print("Swift negotiated RSA/SHA-2 SSH algorithms: \(algorithms)")
    return
  }
  guard
    algorithms.keyExchange == "curve25519-sha256",
    algorithms.hostKey == "ssh-ed25519",
    algorithms.clientToServerCipher == "chacha20-poly1305@openssh.com",
    algorithms.serverToClientCipher == "chacha20-poly1305@openssh.com",
    algorithms.clientToServerMAC == "hmac-sha2-256",
    algorithms.serverToClientMAC == "hmac-sha2-256"
  else {
    throw LiveProbeError.unexpectedAlgorithms(algorithms)
  }
  print("Swift negotiated SSH algorithms: \(algorithms)")
}

private func verifyTerminalSize(
  expected: String,
  connection: any TerminalConnection,
  reader: inout ProbeReader
) async throws {
  let marker = "GHOSTTEA_SIZE_END"
  try await connection.write(
    Data(
      "printf 'GHOSTTEA_SIZE:%s\\nGHOSTTEA_SIZE_%s\\n' \"$(stty size)\" END\n".utf8
    )
  )
  let output = try await reader.readThrough(marker: marker)
  let outputString = String(decoding: output, as: UTF8.self)
  guard outputString.contains("GHOSTTEA_SIZE:\(expected)") else {
    throw LiveProbeError.unexpectedTerminalSize(
      expected: expected,
      output: outputString
    )
  }
}

private func verifyStalledFlood(
  connection: SSHCandidateConnection,
  reader: inout ProbeReader
) async throws {
  let expectedBytes = 32 * 1_024 * 1_024
  let beginMarker = "GHOSTTEA_FLOOD_BEGIN"
  let endMarker = "GHOSTTEA_FLOOD_END"
  let before = try await connection.flowControlMetrics()
  try await connection.write(
    Data(
      "printf 'GHOSTTEA_FLOOD_%s' BEGIN; head -c \(expectedBytes) /dev/zero; printf 'GHOSTTEA_FLOOD_%s' END\n"
        .utf8
    )
  )
  let afterCommand = try await connection.flowControlMetrics()

  try await Task.sleep(for: .milliseconds(750))
  let stalled = try await connection.flowControlMetrics()
  guard
    stalled.standardOutputBytesDelivered == before.standardOutputBytesDelivered,
    stalled.standardErrorBytesDelivered == before.standardErrorBytesDelivered
  else {
    throw LiveProbeError.stalledReadPrefetched(
      before: before.standardOutputBytesDelivered + before.standardErrorBytesDelivered,
      after: stalled.standardOutputBytesDelivered + stalled.standardErrorBytesDelivered
    )
  }
  guard stalled.socketBytesReceived == afterCommand.socketBytesReceived else {
    throw LiveProbeError.stalledSocketRead(
      before: afterCommand.socketBytesReceived,
      after: stalled.socketBytesReceived
    )
  }
  let memoryLimitBytes = 64 * 1_024 * 1_024
  let stalledResidentBytes = maximumResidentBytes()
  if let stalledResidentBytes, stalledResidentBytes > memoryLimitBytes {
    throw LiveProbeError.stalledMemoryExceeded(
      limitBytes: memoryLimitBytes,
      actualBytes: stalledResidentBytes
    )
  }
  _ = try await reader.readThrough(marker: beginMarker)
  let receivedBytes = try await reader.countZeroBytes(through: endMarker)
  guard receivedBytes == expectedBytes else {
    throw LiveProbeError.floodSize(expected: expectedBytes, actual: receivedBytes)
  }
  let drained = try await connection.flowControlMetrics()
  let deliveredDuringFlood =
    drained.standardOutputBytesDelivered
    - before.standardOutputBytesDelivered
  guard deliveredDuringFlood >= UInt64(expectedBytes) else {
    throw LiveProbeError.deliveredMetricTooSmall(
      expectedMinimum: UInt64(expectedBytes),
      actual: deliveredDuringFlood
    )
  }
  let socketBytesReceivedDuringDrain =
    drained.socketBytesReceived
    - afterCommand.socketBytesReceived
  guard socketBytesReceivedDuringDrain >= UInt64(expectedBytes) else {
    throw LiveProbeError.socketMetricTooSmall(
      expectedMinimum: UInt64(expectedBytes),
      actual: socketBytesReceivedDuringDrain
    )
  }
  let memoryDescription = stalledResidentBytes.map { ", stalled RSS \($0) bytes" } ?? ""
  print(
    "Swift stalled-reader flood resumed losslessly: \(receivedBytes) bytes\(memoryDescription), window \(stalled.receiveWindowBytes)/\(stalled.initialReceiveWindowBytes), socket rx \(socketBytesReceivedDuringDrain), socket waits \(drained.socketWaitCalls)"
  )
}

private func verifyReadCancellation(
  connection: any TerminalConnection,
  reader: inout ProbeReader
) async throws {
  let marker = "GHOSTTEA_CANCEL_READY"
  try await connection.write(
    Data("printf 'GHOSTTEA_CANCEL_%s' READY; exec cat >/dev/null\n".utf8)
  )
  _ = try await reader.readThrough(marker: marker)

  let readTask = Task {
    try await connection.read(maxBytes: 1_024)
  }
  try await Task.sleep(for: .milliseconds(150))
  let clock = ContinuousClock()
  let start = clock.now
  readTask.cancel()
  let result = await readTask.result
  let duration = start.duration(to: clock.now)

  switch result {
  case .success:
    throw LiveProbeError.readCompletedInsteadOfCancelling
  case .failure(let error):
    guard error is CancellationError else {
      throw LiveProbeError.unexpectedCancellationError(String(describing: error))
    }
  }
  guard duration < .seconds(1) else {
    throw LiveProbeError.cancellationTooSlow(duration)
  }
  print("Swift blocked read observed cancellation in \(duration)")
}

private func maximumResidentBytes() -> Int? {
  #if canImport(Darwin)
    var usage = rusage()
    guard getrusage(RUSAGE_SELF, &usage) == 0 else { return nil }
    return Int(usage.ru_maxrss)
  #else
    return nil
  #endif
}

do {
  try await runProbe()
} catch {
  FileHandle.standardError.write(Data("GhostteaSSHLiveProbe: \(error)\n".utf8))
  exit(1)
}
