import Foundation

public enum GhostteaMemoryDeviceTier: String, Codable, Sendable {
  case compact
  case standard
}

public struct GhostteaMemoryBudget: Codable, Equatable, Sendable {
  public let tier: GhostteaMemoryDeviceTier
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
        hardApplicationFootprintBytes: 128 * mebibyte
      )
    }
    return Self(
      tier: .standard,
      maximumResidentSessions: 8,
      scrollbackBytesPerSession: 5_000_000,
      softApplicationFootprintBytes: 160 * mebibyte,
      hardApplicationFootprintBytes: 224 * mebibyte
    )
  }

  public func failures(
    peakApplicationFootprintBytes: UInt64,
    foregroundAndBackgroundFootprintBytes: UInt64,
    compressionSupported: Bool,
    retainedScrollbackRows: [Int]
  ) -> [String] {
    var failures: [String] = []
    if peakApplicationFootprintBytes > hardApplicationFootprintBytes {
      failures.append("loaded process footprint exceeds the hard bound")
    }
    if foregroundAndBackgroundFootprintBytes > softApplicationFootprintBytes {
      failures.append("foreground/background process footprint exceeds the soft budget")
    }
    if !compressionSupported {
      failures.append("scrollback compression is unavailable")
    }
    if retainedScrollbackRows.count != maximumResidentSessions
      || retainedScrollbackRows.contains(where: { $0 <= 0 })
    {
      failures.append("resident sessions did not retain scrollback")
    }
    return failures
  }
}
