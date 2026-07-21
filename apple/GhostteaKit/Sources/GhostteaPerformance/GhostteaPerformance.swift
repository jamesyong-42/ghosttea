import Foundation
import os

/// Coarse pipeline boundaries that may be recorded without observing terminal
/// content, commands, hosts, usernames, or credentials.
public enum GhostteaPerformanceMetric: String, CaseIterable, Codable, Sendable {
  case inputToTransportWrite
  case receivedBytesToFrameDelivery
  case receivedBytesToMetalSubmission
  case truffleStateDecode
  case truffleReplicaPublication
  case nativeFeed
  case textEngineLockWait
  case textEngineLockHold
  case frameDecode
  case accessibilityUpdate
  case glyphVisibility
  case atlasSynchronization
  case meshBuild
  case metalEncoding
  case metalGPUCompletion
  case metalSubmission
  case qualificationWorkload

  fileprivate var signpostName: StaticString {
    switch self {
    case .inputToTransportWrite: "input_to_transport_write"
    case .receivedBytesToFrameDelivery: "received_bytes_to_frame_delivery"
    case .receivedBytesToMetalSubmission: "received_bytes_to_metal_submission"
    case .truffleStateDecode: "truffle_state_decode"
    case .truffleReplicaPublication: "truffle_replica_publication"
    case .nativeFeed: "native_feed"
    case .textEngineLockWait: "text_engine_lock_wait"
    case .textEngineLockHold: "text_engine_lock_hold"
    case .frameDecode: "frame_decode"
    case .accessibilityUpdate: "accessibility_update"
    case .glyphVisibility: "glyph_visibility"
    case .atlasSynchronization: "atlas_synchronization"
    case .meshBuild: "mesh_build"
    case .metalEncoding: "metal_encoding"
    case .metalGPUCompletion: "metal_gpu_completion"
    case .metalSubmission: "metal_submission"
    case .qualificationWorkload: "qualification_workload"
    }
  }
}

public struct GhostteaPerformanceSummary: Codable, Equatable, Sendable {
  public let metric: GhostteaPerformanceMetric
  public let sampleCount: Int
  public let droppedSampleCount: Int
  public let byteCount: UInt64
  public let totalNanoseconds: UInt64
  public let p50Nanoseconds: UInt64
  public let p99Nanoseconds: UInt64
  public let maximumNanoseconds: UInt64
}

public struct GhostteaPerformanceSnapshot: Codable, Equatable, Sendable {
  public let schemaVersion: Int
  public let summaries: [GhostteaPerformanceSummary]

  public init(schemaVersion: Int = 2, summaries: [GhostteaPerformanceSummary]) {
    self.schemaVersion = schemaVersion
    self.summaries = summaries
  }
}

/// Opt-in, process-local performance recorder.
///
/// Recording is disabled by default. When enabled, every measurement emits an
/// Instruments interval signpost and retains a bounded numeric duration sample.
/// The recorder deliberately has no API that accepts arbitrary strings.
public final class GhostteaPerformanceRecorder: @unchecked Sendable {
  public static let shared = GhostteaPerformanceRecorder(
    initiallyEnabled: ProcessInfo.processInfo.environment["GHOSTTEA_PERFORMANCE_RECORDING"] == "1"
  )

  private struct Sample: Sendable {
    let durationNanoseconds: UInt64
    let byteCount: UInt64
  }

  private struct MetricBuffer: Sendable {
    var samples: [Sample] = []
    var nextReplacementIndex = 0
    var droppedSampleCount = 0
  }

  private let lock = NSLock()
  private let maximumSamplesPerMetric: Int
  private let log: OSLog
  private var enabled: Bool
  private var buffers: [GhostteaPerformanceMetric: MetricBuffer] = [:]

  public init(
    maximumSamplesPerMetric: Int = 2_048,
    initiallyEnabled: Bool = false,
    subsystem: String = "com.ghosttea.ios"
  ) {
    precondition(maximumSamplesPerMetric > 0)
    self.maximumSamplesPerMetric = maximumSamplesPerMetric
    enabled = initiallyEnabled
    log = OSLog(subsystem: subsystem, category: "TerminalPerformance")
  }

  public func setEnabled(_ enabled: Bool) {
    lock.withLock {
      self.enabled = enabled
    }
  }

  public var isEnabled: Bool {
    lock.withLock { enabled }
  }

  public func reset() {
    lock.withLock {
      buffers.removeAll(keepingCapacity: true)
    }
  }

  /// Records a duration measured by a native coarse boundary and emits a
  /// numeric event signpost. Arbitrary labels are intentionally unsupported.
  public func record(
    _ metric: GhostteaPerformanceMetric,
    durationNanoseconds: UInt64,
    byteCount: Int = 0
  ) {
    guard isEnabled else { return }
    let boundedBytes = UInt64(max(0, byteCount))
    os_signpost(
      .event,
      log: log,
      name: metric.signpostName,
      "duration_ns=%{public}llu bytes=%{public}llu",
      durationNanoseconds,
      boundedBytes
    )
    record(metric, durationNanoseconds: durationNanoseconds, byteCount: boundedBytes)
  }

  @discardableResult
  public func measure<T>(
    _ metric: GhostteaPerformanceMetric,
    byteCount: Int = 0,
    operation: () throws -> T
  ) rethrows -> T {
    guard isEnabled else { return try operation() }
    let signpostID = OSSignpostID(log: log)
    let boundedBytes = UInt64(max(0, byteCount))
    let started = DispatchTime.now().uptimeNanoseconds
    os_signpost(
      .begin,
      log: log,
      name: metric.signpostName,
      signpostID: signpostID,
      "bytes=%{public}llu",
      boundedBytes
    )
    defer {
      let duration = DispatchTime.now().uptimeNanoseconds &- started
      os_signpost(
        .end,
        log: log,
        name: metric.signpostName,
        signpostID: signpostID,
        "duration_ns=%{public}llu",
        duration
      )
      record(metric, durationNanoseconds: duration, byteCount: boundedBytes)
    }
    return try operation()
  }

  @discardableResult
  public func measure<T>(
    _ metric: GhostteaPerformanceMetric,
    byteCount: Int = 0,
    isolation: isolated (any Actor)? = #isolation,
    operation: () async throws -> T
  ) async rethrows -> T {
    guard isEnabled else { return try await operation() }
    let signpostID = OSSignpostID(log: log)
    let boundedBytes = UInt64(max(0, byteCount))
    let started = DispatchTime.now().uptimeNanoseconds
    os_signpost(
      .begin,
      log: log,
      name: metric.signpostName,
      signpostID: signpostID,
      "bytes=%{public}llu",
      boundedBytes
    )
    defer {
      let duration = DispatchTime.now().uptimeNanoseconds &- started
      os_signpost(
        .end,
        log: log,
        name: metric.signpostName,
        signpostID: signpostID,
        "duration_ns=%{public}llu",
        duration
      )
      record(metric, durationNanoseconds: duration, byteCount: boundedBytes)
    }
    return try await operation()
  }

  public func snapshot() -> GhostteaPerformanceSnapshot {
    lock.withLock {
      GhostteaPerformanceSnapshot(
        summaries: GhostteaPerformanceMetric.allCases.compactMap { metric in
          guard let buffer = buffers[metric], !buffer.samples.isEmpty else { return nil }
          let metricSamples = buffer.samples
          let durations = metricSamples.map(\.durationNanoseconds).sorted()
          return GhostteaPerformanceSummary(
            metric: metric,
            sampleCount: durations.count,
            droppedSampleCount: buffer.droppedSampleCount,
            byteCount: metricSamples.reduce(0) { $0 &+ $1.byteCount },
            totalNanoseconds: durations.reduce(0, &+),
            p50Nanoseconds: percentile(durations, numerator: 50, denominator: 100),
            p99Nanoseconds: percentile(durations, numerator: 99, denominator: 100),
            maximumNanoseconds: durations[durations.count - 1]
          )
        }
      )
    }
  }

  private func record(
    _ metric: GhostteaPerformanceMetric,
    durationNanoseconds: UInt64,
    byteCount: UInt64
  ) {
    lock.withLock {
      var buffer = buffers[metric, default: MetricBuffer()]
      let sample = Sample(durationNanoseconds: durationNanoseconds, byteCount: byteCount)
      if buffer.samples.count < maximumSamplesPerMetric {
        buffer.samples.append(sample)
      } else {
        buffer.samples[buffer.nextReplacementIndex] = sample
        buffer.nextReplacementIndex = (buffer.nextReplacementIndex + 1) % maximumSamplesPerMetric
        buffer.droppedSampleCount += 1
      }
      buffers[metric] = buffer
    }
  }
}

private func percentile(
  _ sortedValues: [UInt64],
  numerator: Int,
  denominator: Int
) -> UInt64 {
  precondition(!sortedValues.isEmpty)
  let rank = max(1, (sortedValues.count * numerator + denominator - 1) / denominator)
  return sortedValues[min(sortedValues.count - 1, rank - 1)]
}
