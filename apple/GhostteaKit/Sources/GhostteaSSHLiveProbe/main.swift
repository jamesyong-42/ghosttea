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
  case readCompletedInsteadOfCancelling
  case unexpectedCancellationError(String)
  case cancellationTooSlow(Duration)

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
    case .readCompletedInsteadOfCancelling:
      return "blocked SSH read completed instead of observing task cancellation"
    case .unexpectedCancellationError(let error):
      return "blocked SSH read failed with \(error) instead of CancellationError"
    case .cancellationTooSlow(let duration):
      return "blocked SSH read took \(duration) to observe cancellation"
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
  case "password":
    return .password(username: "ghosttea", password: "ghosttea-password")
  case "publickey":
    return .publicKey(
      username: "ghosttea",
      publicKeyPath: publicKeyPath,
      privateKeyPath: privateKeyPath,
      passphrase: nil
    )
  case "keyboard":
    return .keyboardInteractive(
      username: "ghosttea",
      answers: ["ghosttea-password", "123456"]
    )
  case "partial":
    return .publicKeyThenKeyboardInteractive(
      username: "ghosttea",
      publicKeyPath: publicKeyPath,
      privateKeyPath: privateKeyPath,
      passphrase: nil,
      answers: ["ghosttea-password", "123456"]
    )
  default:
    throw LiveProbeError.usage
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

  let configuration = try SSHCandidateConfiguration(
    host: host,
    port: port,
    knownHostsPath: knownHostsPath,
    authentication: try authentication(
      mode: mode,
      publicKeyPath: publicKeyPath,
      privateKeyPath: privateKeyPath
    ),
    columns: 132,
    rows: 41
  )
  let connection = try await SSHCandidateTransport(configuration: configuration).connect()
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
      try await verifyStalledFlood(connection: connection, reader: &reader)
      try await verifyReadCancellation(connection: connection, reader: &reader)
    }

    await connection.disconnect()
    print("Swift nonblocking libssh2 \(mode) probe passed")
  } catch {
    await connection.disconnect()
    throw error
  }
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
  connection: any TerminalConnection,
  reader: inout ProbeReader
) async throws {
  let expectedBytes = 32 * 1_024 * 1_024
  let beginMarker = "GHOSTTEA_FLOOD_BEGIN"
  let endMarker = "GHOSTTEA_FLOOD_END"
  try await connection.write(
    Data(
      "printf 'GHOSTTEA_FLOOD_%s' BEGIN; head -c \(expectedBytes) /dev/zero; printf 'GHOSTTEA_FLOOD_%s' END\n"
        .utf8
    )
  )

  try await Task.sleep(for: .milliseconds(750))
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
  let memoryDescription = stalledResidentBytes.map { ", stalled RSS \($0) bytes" } ?? ""
  print(
    "Swift stalled-reader flood resumed losslessly: \(receivedBytes) bytes\(memoryDescription)"
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
