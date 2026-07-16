import Darwin
import Foundation
import GhosttyVtProof

private struct Configuration: Codable {
  var sessions = 4
  var lines = 5_000
  var columns: UInt16 = 80
  var rows: UInt16 = 24
  var scrollbackBytes = 5_000_000
}

private struct Measurement: Codable {
  let schemaVersion: Int
  let configuration: Configuration
  let processBaseline: MemorySample
  let emptySessions: MemorySample
  let loadedSessions: MemorySample
  let compressedSessions: MemorySample
  let emptySessionsFootprintDeltaBytes: UInt64
  let loadedScrollbackFootprintDeltaBytes: UInt64
  let loadedFootprintDeltaPerSessionBytes: UInt64
  let compressionReclaimedBytes: UInt64
  let compressedScrollbackFootprintDeltaBytes: UInt64
  let compressionSupported: Bool
  let contentPattern: String
  let observedTotalRows: [Int]
  let observedScrollbackRows: [Int]
}

private struct MemorySample: Codable {
  let residentBytes: UInt64
  let physicalFootprintBytes: UInt64
  let compressedBytes: UInt64
}

@main
private enum GhosttyVtMemoryProbe {
  static func main() throws {
    let configuration = try parseArguments(Array(CommandLine.arguments.dropFirst()))
    let processBaseline = try memorySample()

    let sessions = try (0..<configuration.sessions).map { _ in
      try GhosttyVtProofSession(
        columns: configuration.columns,
        rows: configuration.rows,
        maxScrollbackBytes: configuration.scrollbackBytes
      )
    }
    let emptySessions = try memorySample()

    var remainingLines = configuration.lines
    var lineOffset = 0
    while remainingLines > 0 {
      let batchLines = min(64, remainingLines)
      let bytes = makeLines(
        start: lineOffset,
        count: batchLines,
        columns: Int(configuration.columns)
      )
      for session in sessions {
        session.feed(bytes)
      }
      remainingLines -= batchLines
      lineOffset += batchLines
    }

    let states = try sessions.map { try $0.state() }
    let loadedSessions = try withExtendedLifetime(sessions) {
      try memorySample()
    }
    let compressionResults = try sessions.map { try $0.compressScrollbackFull() }
    let compressedSessions = try withExtendedLifetime(sessions) {
      try memorySample()
    }
    let emptyDelta = positiveDifference(
      emptySessions.physicalFootprintBytes,
      processBaseline.physicalFootprintBytes
    )
    let loadedDelta = positiveDifference(
      loadedSessions.physicalFootprintBytes,
      emptySessions.physicalFootprintBytes
    )
    let compressionReclaimed = positiveDifference(
      loadedSessions.physicalFootprintBytes,
      compressedSessions.physicalFootprintBytes
    )
    let compressedDelta = positiveDifference(
      compressedSessions.physicalFootprintBytes,
      emptySessions.physicalFootprintBytes
    )
    let measurement = Measurement(
      schemaVersion: 1,
      configuration: configuration,
      processBaseline: processBaseline,
      emptySessions: emptySessions,
      loadedSessions: loadedSessions,
      compressedSessions: compressedSessions,
      emptySessionsFootprintDeltaBytes: emptyDelta,
      loadedScrollbackFootprintDeltaBytes: loadedDelta,
      loadedFootprintDeltaPerSessionBytes: loadedDelta / UInt64(configuration.sessions),
      compressionReclaimedBytes: compressionReclaimed,
      compressedScrollbackFootprintDeltaBytes: compressedDelta,
      compressionSupported: compressionResults.allSatisfy { $0 },
      contentPattern: "deterministic-printable-v1",
      observedTotalRows: states.map(\.totalRows),
      observedScrollbackRows: states.map(\.scrollbackRows)
    )

    let encoder = JSONEncoder()
    encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
    FileHandle.standardOutput.write(try encoder.encode(measurement))
    FileHandle.standardOutput.write(Data([0x0A]))
  }

  private static func parseArguments(_ arguments: [String]) throws -> Configuration {
    var configuration = Configuration()
    var index = 0
    while index < arguments.count {
      guard index + 1 < arguments.count, let value = Int(arguments[index + 1]), value > 0 else {
        throw GhosttyVtProofError.operationFailed(
          "expected a positive value after \(arguments[index])")
      }
      switch arguments[index] {
      case "--sessions":
        configuration.sessions = value
      case "--lines":
        configuration.lines = value
      case "--columns":
        guard let columns = UInt16(exactly: value) else {
          throw GhosttyVtProofError.operationFailed("columns exceed UInt16")
        }
        configuration.columns = columns
      case "--rows":
        guard let rows = UInt16(exactly: value) else {
          throw GhosttyVtProofError.operationFailed("rows exceed UInt16")
        }
        configuration.rows = rows
      case "--scrollback-bytes":
        configuration.scrollbackBytes = value
      default:
        throw GhosttyVtProofError.operationFailed("unknown argument \(arguments[index])")
      }
      index += 2
    }
    return configuration
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

  private static func positiveDifference(_ end: UInt64, _ start: UInt64) -> UInt64 {
    end > start ? end - start : 0
  }

  private static func memorySample() throws -> MemorySample {
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
    return MemorySample(
      residentBytes: UInt64(info.resident_size),
      physicalFootprintBytes: UInt64(info.phys_footprint),
      compressedBytes: UInt64(info.compressed)
    )
  }
}
