import Darwin
import Foundation
import GhostteaCredentials
import GhostteaSSH
import GhostteaTransport
import GhosttyVtProof

struct HarnessMemoryResult: Identifiable, Sendable {
  let sessions: Int
  let emptyFootprintBytes: UInt64
  let loadedFootprintBytes: UInt64
  let compressedFootprintBytes: UInt64
  let scrollbackRows: [Int]
  let compressionSupported: Bool

  var id: Int { sessions }
}

struct HarnessWholeAppMemoryResult: Sendable {
  let budget: GhostteaMemoryBudget
  let processBaselineFootprintBytes: UInt64
  let emptyTerminalDeltaBytes: UInt64
  let loadedScrollbackDeltaBytes: UInt64
  let peakProcessFootprintBytes: UInt64
  let foregroundAndBackgroundFootprintBytes: UInt64
  let allCompressedFootprintBytes: UInt64
  let retainedScrollbackRows: [Int]
  let failures: [String]

  let transportBufferBytes: UInt64 = 0
  let decodedImageBytes: UInt64? = nil
  let gpuAtlasBytes: UInt64? = nil

  var passed: Bool { failures.isEmpty }
}

struct HarnessActiveSSHMemoryResult: Sendable {
  let budget: GhostteaMemoryBudget
  let expectedOutputBytes: UInt64
  let drainedOutputBytes: UInt64
  let processBaselineFootprintBytes: UInt64
  let connectedFootprintBytes: UInt64
  let stalledFootprintBytes: UInt64
  let drainedFootprintBytes: UInt64
  let deliveredBytesBeforeStall: UInt64
  let deliveredBytesAfterStall: UInt64
  let socketBytesBeforeStall: UInt64
  let socketBytesAfterStall: UInt64
  let receiveWindowBytes: UInt64
  let initialReceiveWindowBytes: UInt64
  let socketWaitCalls: UInt64
  let failures: [String]

  var passed: Bool { failures.isEmpty }
}

private enum HarnessActiveSSHMemoryError: Error, CustomStringConvertible {
  case unexpectedConnectionType
  case standardError(bytes: UInt64)
  case unexpectedTermination(TerminalExitStatus)

  var description: String {
    switch self {
    case .unexpectedConnectionType:
      return "SSH candidate did not return its instrumented connection"
    case .standardError(let bytes):
      return "SSH flood emitted \(bytes) unexpected stderr bytes"
    case .unexpectedTermination(let status):
      return "SSH flood terminated with \(status)"
    }
  }
}

enum HarnessDiagnostics {
  static func runVTProof() throws -> String {
    let result = try GhosttyVtProof.run()
    return
      "\(result.columns)x\(result.rows), cursor \(result.cursorColumn),\(result.cursorRow), key \(result.encodedKey)"
  }

  static func runMemoryMatrix() throws -> [HarnessMemoryResult] {
    try [1, 4, 8].map(runMemoryProbe)
  }

  static func runWholeAppMemoryGate(physicalMemoryBytes: UInt64) throws
    -> HarnessWholeAppMemoryResult
  {
    let budget = GhostteaMemoryBudget.recommended(
      forPhysicalMemoryBytes: physicalMemoryBytes
    )
    let baseline = try stablePhysicalFootprintBytes()
    let sessions = try (0..<budget.maximumResidentSessions).map { _ in
      try GhosttyVtProofSession(
        columns: 80,
        rows: 24,
        maxScrollbackBytes: budget.scrollbackBytesPerSession
      )
    }
    let empty = try stablePhysicalFootprintBytes()

    for offset in stride(from: 0, to: 5_000, by: 64) {
      let lineCount = min(64, 5_000 - offset)
      let bytes = makeLines(start: offset, count: lineCount, columns: 80)
      for session in sessions {
        session.feed(bytes)
      }
    }
    let states = try sessions.map { try $0.state() }
    let loaded = try withExtendedLifetime(sessions) {
      try stablePhysicalFootprintBytes()
    }

    var compressionResults: [Bool] = []
    for session in sessions.dropFirst() {
      compressionResults.append(try session.compressScrollbackFull())
    }
    let foregroundAndBackground = try withExtendedLifetime(sessions) {
      try stablePhysicalFootprintBytes()
    }
    if let foreground = sessions.first {
      compressionResults.append(try foreground.compressScrollbackFull())
    }
    let allCompressed = try withExtendedLifetime(sessions) {
      try stablePhysicalFootprintBytes()
    }
    let compressionSupported = compressionResults.allSatisfy { $0 }
    let retainedScrollbackRows = states.map(\.scrollbackRows)
    var failures = budget.failures(
      peakApplicationFootprintBytes: loaded,
      foregroundAndBackgroundFootprintBytes: foregroundAndBackground,
      compressionSupported: compressionSupported,
      retainedScrollbackRows: retainedScrollbackRows
    )
    if foregroundAndBackground > loaded {
      failures.append("background compression did not reduce process footprint")
    }
    if allCompressed > foregroundAndBackground {
      failures.append("active-session compression did not reduce process footprint")
    }

    return HarnessWholeAppMemoryResult(
      budget: budget,
      processBaselineFootprintBytes: baseline,
      emptyTerminalDeltaBytes: positiveDifference(empty, baseline),
      loadedScrollbackDeltaBytes: positiveDifference(loaded, empty),
      peakProcessFootprintBytes: loaded,
      foregroundAndBackgroundFootprintBytes: foregroundAndBackground,
      allCompressedFootprintBytes: allCompressed,
      retainedScrollbackRows: retainedScrollbackRows,
      failures: failures
    )
  }

  static func runActiveSSHMemoryGate(
    host: String,
    port: Int,
    username: String,
    password: Data,
    knownHostsPath: String,
    physicalMemoryBytes: UInt64
  ) async throws -> HarnessActiveSSHMemoryResult {
    let expectedOutputBytes = UInt64(32 * 1_024 * 1_024)
    let budget = GhostteaMemoryBudget.recommended(
      forPhysicalMemoryBytes: physicalMemoryBytes
    )
    let baseline = try stablePhysicalFootprintBytes()
    let credentialStore = try KeychainSSHCredentialStore()
    let credential = SSHCredentialID(connectionID: UUID(), kind: .password)
    try await credentialStore.store(password, for: credential)

    var activeConnection: SSHCandidateConnection?
    do {
      let configuration = try SSHCandidateConfiguration(
        host: host,
        port: port,
        knownHostsPath: knownHostsPath,
        hostKeyPolicy: .ask { _ in .acceptOnce },
        authentication: .passwordCredential(
          username: username,
          credential: credential,
          resolver: { requestedCredential in
            try await credentialStore.require(requestedCredential)
          }
        ),
        session: .command("head -c \(expectedOutputBytes) /dev/zero", allocatePTY: false),
        connectTimeoutMilliseconds: 15_000,
        handshakeTimeoutMilliseconds: 15_000
      )
      let genericConnection = try await SSHCandidateTransport(
        configuration: configuration
      ).connect()
      guard let connection = genericConnection as? SSHCandidateConnection else {
        await genericConnection.disconnect()
        throw HarnessActiveSSHMemoryError.unexpectedConnectionType
      }
      activeConnection = connection
      try await credentialStore.remove(credential)

      let beforeStall = try await connection.flowControlMetrics()
      let connected = try stablePhysicalFootprintBytes()
      try await Task.sleep(for: .milliseconds(750))
      let stalled = try await connection.flowControlMetrics()
      let stalledFootprint = try stablePhysicalFootprintBytes()

      var drainedOutputBytes: UInt64 = 0
      var standardErrorBytes: UInt64 = 0
      while let chunk = try await connection.readCommandOutput(maxBytes: 64 * 1_024) {
        switch chunk {
        case .standardOutput(let bytes):
          drainedOutputBytes += UInt64(bytes.count)
        case .standardError(let bytes):
          standardErrorBytes += UInt64(bytes.count)
        }
      }
      let drainedMetrics = try await connection.flowControlMetrics()
      let termination = try await connection.waitForExit()
      let drainedFootprint = try stablePhysicalFootprintBytes()
      await connection.disconnect()
      activeConnection = nil

      guard standardErrorBytes == 0 else {
        throw HarnessActiveSSHMemoryError.standardError(bytes: standardErrorBytes)
      }
      guard termination == .exited(code: 0) else {
        throw HarnessActiveSSHMemoryError.unexpectedTermination(termination)
      }

      let deliveredBefore =
        beforeStall.standardOutputBytesDelivered
        + beforeStall.standardErrorBytesDelivered
      let deliveredAfter =
        stalled.standardOutputBytesDelivered
        + stalled.standardErrorBytesDelivered
      let deliveredAfterDrain =
        drainedMetrics.standardOutputBytesDelivered
        + drainedMetrics.standardErrorBytesDelivered
      var failures: [String] = []
      if deliveredAfter != deliveredBefore {
        failures.append("paused demand delivered bytes into the app")
      }
      if stalled.socketBytesReceived != beforeStall.socketBytesReceived {
        failures.append("paused demand continued reading from the socket")
      }
      if drainedOutputBytes != expectedOutputBytes {
        failures.append("SSH flood did not drain byte-for-byte")
      }
      if positiveDifference(deliveredAfterDrain, deliveredBefore) < expectedOutputBytes {
        failures.append("delivered-byte metrics did not cover the flood")
      }
      if positiveDifference(
        drainedMetrics.socketBytesReceived,
        beforeStall.socketBytesReceived
      )
        < expectedOutputBytes
      {
        failures.append("socket-byte metrics did not cover the flood")
      }
      if stalledFootprint > budget.softApplicationFootprintBytes {
        failures.append("stalled SSH process footprint exceeds the soft budget")
      }
      let stallGrowth = positiveDifference(stalledFootprint, connected)
      if stallGrowth > 8 * 1_024 * 1_024 {
        failures.append("stalled SSH process grew by more than 8 MiB")
      }

      return HarnessActiveSSHMemoryResult(
        budget: budget,
        expectedOutputBytes: expectedOutputBytes,
        drainedOutputBytes: drainedOutputBytes,
        processBaselineFootprintBytes: baseline,
        connectedFootprintBytes: connected,
        stalledFootprintBytes: stalledFootprint,
        drainedFootprintBytes: drainedFootprint,
        deliveredBytesBeforeStall: deliveredBefore,
        deliveredBytesAfterStall: deliveredAfter,
        socketBytesBeforeStall: beforeStall.socketBytesReceived,
        socketBytesAfterStall: stalled.socketBytesReceived,
        receiveWindowBytes: stalled.receiveWindowBytes,
        initialReceiveWindowBytes: stalled.initialReceiveWindowBytes,
        socketWaitCalls: drainedMetrics.socketWaitCalls,
        failures: failures
      )
    } catch {
      if let activeConnection {
        await activeConnection.disconnect()
      }
      try? await credentialStore.remove(credential)
      throw error
    }
  }

  private static func runMemoryProbe(sessions sessionCount: Int) throws -> HarnessMemoryResult {
    let baseline = try stablePhysicalFootprintBytes()
    let sessions = try (0..<sessionCount).map { _ in
      try GhosttyVtProofSession(
        columns: 80,
        rows: 24,
        maxScrollbackBytes: 5_000_000
      )
    }
    let empty = try stablePhysicalFootprintBytes()

    for offset in stride(from: 0, to: 5_000, by: 64) {
      let lineCount = min(64, 5_000 - offset)
      let bytes = makeLines(start: offset, count: lineCount, columns: 80)
      for session in sessions {
        session.feed(bytes)
      }
    }
    let states = try sessions.map { try $0.state() }
    let loaded = try withExtendedLifetime(sessions) { try stablePhysicalFootprintBytes() }
    let compressed = try sessions.map { try $0.compressScrollbackFull() }
    let compressedFootprint = try withExtendedLifetime(sessions) {
      try stablePhysicalFootprintBytes()
    }

    return HarnessMemoryResult(
      sessions: sessionCount,
      emptyFootprintBytes: positiveDifference(empty, baseline),
      loadedFootprintBytes: positiveDifference(loaded, baseline),
      compressedFootprintBytes: positiveDifference(compressedFootprint, baseline),
      scrollbackRows: states.map(\.scrollbackRows),
      compressionSupported: compressed.allSatisfy { $0 }
    )
  }

  private static func makeLines(start: Int, count: Int, columns: Int) -> [UInt8] {
    let contentWidth = max(1, columns - 2)
    var bytes: [UInt8] = []
    bytes.reserveCapacity(count * columns)
    for lineIndex in start..<(start + count) {
      var state = UInt64(lineIndex + 1) &* 0x9E37_79B9_7F4A_7C15
      for _ in 0..<contentWidth {
        state ^= state >> 12
        state ^= state << 25
        state ^= state >> 27
        bytes.append(UInt8(33 + (state % 94)))
      }
      bytes.append(contentsOf: [0x0D, 0x0A])
    }
    return bytes
  }

  private static func physicalFootprintBytes() throws -> UInt64 {
    var info = task_vm_info_data_t()
    var count = mach_msg_type_number_t(
      MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<natural_t>.size
    )
    let result = withUnsafeMutablePointer(to: &info) { pointer in
      pointer.withMemoryRebound(to: integer_t.self, capacity: Int(count)) { rebound in
        task_info(
          mach_task_self_,
          task_flavor_t(TASK_VM_INFO),
          rebound,
          &count
        )
      }
    }
    guard result == KERN_SUCCESS else {
      throw GhosttyVtProofError.operationFailed("task_info failed with \(result)")
    }
    return UInt64(info.phys_footprint)
  }

  private static func stablePhysicalFootprintBytes() throws -> UInt64 {
    var minimum = UInt64.max
    for sample in 0..<3 {
      minimum = min(minimum, try physicalFootprintBytes())
      if sample < 2 {
        usleep(20_000)
      }
    }
    return minimum
  }

  private static func positiveDifference(_ end: UInt64, _ start: UInt64) -> UInt64 {
    end > start ? end - start : 0
  }
}
