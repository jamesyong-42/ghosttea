import Darwin
import Foundation

public enum GhostteaWorkspaceMemoryDeviceTier: String, Codable, Sendable {
  case compact
  case standard
}

/// Production whole-process bounds shared with the Phase 0 measurement proof.
public struct GhostteaWorkspaceMemoryBudget: Codable, Equatable, Sendable {
  public let tier: GhostteaWorkspaceMemoryDeviceTier
  public let maximumResidentSessions: Int
  public let scrollbackBytesPerSession: Int
  public let softApplicationFootprintBytes: UInt64
  public let hardApplicationFootprintBytes: UInt64

  public static func recommended(forPhysicalMemoryBytes physicalMemoryBytes: UInt64) -> Self {
    let mebibyte = UInt64(1_048_576)
    if physicalMemoryBytes <= 4 * 1_073_741_824 {
      return Self(
        tier: .compact,
        maximumResidentSessions: 4,
        scrollbackBytesPerSession: 3_000_000,
        softApplicationFootprintBytes: 96 * mebibyte,
        hardApplicationFootprintBytes: 128 * mebibyte)
    }
    return Self(
      tier: .standard,
      maximumResidentSessions: 8,
      scrollbackBytesPerSession: 5_000_000,
      softApplicationFootprintBytes: 160 * mebibyte,
      hardApplicationFootprintBytes: 224 * mebibyte)
  }
}

/// Reads Darwin's physical-footprint counter without retaining a sampling task.
public enum GhostteaProcessMemoryFootprint {
  public static func currentBytes() -> UInt64? {
    var info = task_vm_info_data_t()
    var count = mach_msg_type_number_t(
      MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<natural_t>.size)
    let result = withUnsafeMutablePointer(to: &info) { pointer in
      pointer.withMemoryRebound(to: integer_t.self, capacity: Int(count)) { rebound in
        task_info(
          mach_task_self_,
          task_flavor_t(TASK_VM_INFO),
          rebound,
          &count)
      }
    }
    guard result == KERN_SUCCESS else { return nil }
    return UInt64(info.phys_footprint)
  }
}
