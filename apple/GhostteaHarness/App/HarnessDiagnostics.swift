import Darwin
import Foundation
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

enum HarnessDiagnostics {
  static func runVTProof() throws -> String {
    let result = try GhosttyVtProof.run()
    return
      "\(result.columns)x\(result.rows), cursor \(result.cursorColumn),\(result.cursorRow), key \(result.encodedKey)"
  }

  static func runMemoryMatrix() throws -> [HarnessMemoryResult] {
    try [1, 4, 8].map(runMemoryProbe)
  }

  private static func runMemoryProbe(sessions sessionCount: Int) throws -> HarnessMemoryResult {
    let baseline = try physicalFootprintBytes()
    let sessions = try (0..<sessionCount).map { _ in
      try GhosttyVtProofSession(
        columns: 80,
        rows: 24,
        maxScrollbackBytes: 5_000_000
      )
    }
    let empty = try physicalFootprintBytes()

    for offset in stride(from: 0, to: 5_000, by: 64) {
      let lineCount = min(64, 5_000 - offset)
      let bytes = makeLines(start: offset, count: lineCount, columns: 80)
      for session in sessions {
        session.feed(bytes)
      }
    }
    let states = try sessions.map { try $0.state() }
    let loaded = try withExtendedLifetime(sessions) { try physicalFootprintBytes() }
    let compressed = try sessions.map { try $0.compressScrollbackFull() }
    let compressedFootprint = try withExtendedLifetime(sessions) {
      try physicalFootprintBytes()
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

  private static func positiveDifference(_ end: UInt64, _ start: UInt64) -> UInt64 {
    end > start ? end - start : 0
  }
}
