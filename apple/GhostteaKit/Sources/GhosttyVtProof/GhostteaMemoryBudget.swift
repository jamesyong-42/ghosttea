import Foundation
import GhostteaWorkspace

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
    let production = GhostteaWorkspaceMemoryBudget.recommended(
      forPhysicalMemoryBytes: physicalMemoryBytes)
    return Self(
      tier: production.tier == .compact ? .compact : .standard,
      maximumResidentSessions: production.maximumResidentSessions,
      scrollbackBytesPerSession: production.scrollbackBytesPerSession,
      softApplicationFootprintBytes: production.softApplicationFootprintBytes,
      hardApplicationFootprintBytes: production.hardApplicationFootprintBytes)
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
