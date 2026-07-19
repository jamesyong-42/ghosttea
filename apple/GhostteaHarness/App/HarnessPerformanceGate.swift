import Foundation
import GhostteaCore
import GhostteaPerformance
import GhostteaSession
import GhostteaTerminal
import GhostteaTransport
import UIKit

struct HarnessPerformanceGateResult: Codable, Sendable {
  let schemaVersion: Int
  let iterations: Int
  let backgroundDrawAttempts: Int
  let backgroundMetalSubmissions: Int
  let deviceModel: String
  let systemVersion: String
  let maximumFramesPerSecond: Int
  let physicalMemoryBytes: UInt64
  let processorCount: Int
  let lowPowerModeEnabled: Bool
  let thermalState: String
  let snapshot: GhostteaPerformanceSnapshot
  let fairnessScenarios: [HarnessPerformanceFairnessScenario]
  let failures: [String]

  var passed: Bool { failures.isEmpty }
}

struct HarnessPerformanceFairnessSession: Codable, Sendable {
  let sessionIndex: Int
  let sampleCount: Int
  let elapsedNanoseconds: UInt64
  let p50Nanoseconds: UInt64
  let p99Nanoseconds: UInt64
  let maximumNanoseconds: UInt64
}

struct HarnessPerformanceFairnessScenario: Codable, Sendable {
  let sessionCount: Int
  let iterationsPerSession: Int
  let snapshot: GhostteaPerformanceSnapshot
  let sessions: [HarnessPerformanceFairnessSession]
  let slowestToFastestP99Permille: UInt64
  let slowestToFastestElapsedPermille: UInt64
  let failures: [String]
}

private enum HarnessPerformanceGateError: Error, CustomStringConvertible {
  case connectionDidNotBecomeReady
  case frameMissing
  case windowUnavailable

  var description: String {
    switch self {
    case .connectionDidNotBecomeReady: "in-memory terminal connection did not become ready"
    case .frameMissing: "production core did not emit a frame"
    case .windowUnavailable: "iOS window was unavailable for the Metal surface"
    }
  }
}

private actor HarnessPerformanceConnection: TerminalConnection {
  private var connected = true
  private var writtenBytes = 0
  private var writeCount = 0

  func read(maxBytes: Int) async throws -> Data? {
    guard maxBytes > 0, connected else { throw TerminalTransportError.disconnected }
    try await Task.sleep(for: .seconds(3_600))
    return nil
  }

  func write(_ bytes: Data) throws {
    guard connected else { throw TerminalTransportError.disconnected }
    writtenBytes += bytes.count
    writeCount += 1
  }

  func finishInput() throws {
    guard connected else { throw TerminalTransportError.disconnected }
  }

  func resize(columns: Int, rows: Int) throws {
    guard connected else { throw TerminalTransportError.disconnected }
    _ = try TerminalSize(columns: columns, rows: rows)
  }

  func interrupt() throws {
    guard connected else { throw TerminalTransportError.disconnected }
  }

  func waitForExit() throws -> TerminalExitStatus {
    guard connected else { throw TerminalTransportError.disconnected }
    return .exited(code: 0)
  }

  func disconnect() {
    connected = false
  }

  func writeSnapshot() -> (count: Int, bytes: Int) {
    (writeCount, writtenBytes)
  }
}

private struct HarnessPerformanceTransport: TerminalTransport {
  let connection: HarnessPerformanceConnection

  func connect() async throws -> any TerminalConnection {
    connection
  }
}

@MainActor
enum HarnessPerformanceGate {
  private static let iterations = 1_000
  private static let backgroundDrawAttempts = 120
  private static let fairnessIterationsPerSession = 256

  static func run() async throws -> HarnessPerformanceGateResult {
    let recorder = GhostteaPerformanceRecorder.shared
    recorder.setEnabled(true)
    recorder.reset()

    let runtime = try GhostteaRuntime()
    let outputTerminal = try GhostteaTerminal(
      runtime: runtime,
      configuration: .init(sessionHandle: 9_001, columns: 100, rows: 30)
    )
    let inputTerminal = try GhostteaTerminal(
      runtime: runtime,
      configuration: .init(sessionHandle: 9_002, columns: 100, rows: 30)
    )
    let connection = HarnessPerformanceConnection()
    let session = GhostteaSession(
      terminal: inputTerminal,
      transport: HarnessPerformanceTransport(connection: connection),
      configuration: .init(
        initialPath: TerminalNetworkPath(
          availability: .satisfied,
          interfaces: [.loopback]
        )
      )
    )
    await session.requestConnect()
    try await waitUntilConnected(session)

    let surface = try GhostteaTerminalMetalView(terminalFrame: .zero)
    let window = try await activeWindow()
    surface.frame = window.bounds
    surface.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    window.addSubview(surface)
    surface.layoutIfNeeded()

    let warmup = try await outputTerminal.feed(Data("performance-warmup".utf8), render: .full)
    guard let warmupFrame = warmup.effects.last(where: { $0.kind == .frameReady })?.payload else {
      throw HarnessPerformanceGateError.frameMissing
    }
    _ = try surface.apply(frame: warmupFrame)
    surface.draw(in: surface)
    await Task.yield()
    recorder.reset()

    for _ in 0..<iterations {
      try await session.sendKey(
        GhostteaKeyEvent(code: "KeyA", text: "a", unshiftedCodepoint: 97)
      )
    }

    for index in 0..<iterations {
      let bytes = Data("\rline-\(index)-performance\u{1b}[K".utf8)
      try await recorder.measure(.receivedBytesToMetalSubmission, byteCount: bytes.count) {
        let update = try await outputTerminal.feed(bytes, render: .damage)
        guard let frame = update.effects.last(where: { $0.kind == .frameReady })?.payload else {
          throw HarnessPerformanceGateError.frameMissing
        }
        _ = try surface.apply(frame: frame)
        surface.draw(in: surface)
      }
      if index.isMultiple(of: 32) { await Task.yield() }
    }

    let beforeBackground = recorder.snapshot()
    let beforeBackgroundMetal = sampleCount(.metalSubmission, in: beforeBackground)
    surface.suspendGPU()
    for _ in 0..<backgroundDrawAttempts {
      surface.draw(in: surface)
    }
    let afterBackground = recorder.snapshot()
    let afterBackgroundMetal = sampleCount(.metalSubmission, in: afterBackground)
    let backgroundSubmissions = max(0, afterBackgroundMetal - beforeBackgroundMetal)
    let writes = await connection.writeSnapshot()

    var fairnessScenarios: [HarnessPerformanceFairnessScenario] = []
    for sessionCount in [4, 8] {
      fairnessScenarios.append(
        try await runFairnessScenario(runtime: runtime, sessionCount: sessionCount)
      )
    }

    await session.disconnect()
    surface.removeFromSuperview()
    recorder.setEnabled(false)

    var failures: [String] = []
    requireLatency(
      .inputToTransportWrite,
      snapshot: afterBackground,
      p50LimitNanoseconds: 2_000_000,
      p99LimitNanoseconds: 8_000_000,
      failures: &failures
    )
    requireLatency(
      .receivedBytesToMetalSubmission,
      snapshot: afterBackground,
      p50LimitNanoseconds: 8_000_000,
      p99LimitNanoseconds: 16_000_000,
      failures: &failures
    )
    for metric in [
      GhostteaPerformanceMetric.nativeFeed,
      .textEngineLockWait,
      .textEngineLockHold,
      .frameDecode,
      .metalSubmission,
    ] {
      requireSamples(metric, snapshot: afterBackground, failures: &failures)
    }
    if writes.count != iterations || writes.bytes < iterations {
      failures.append("in-memory transport did not observe every input write")
    }
    if backgroundSubmissions != 0 {
      failures.append("GPU submissions occurred while the terminal surface was suspended")
    }
    for scenario in fairnessScenarios {
      failures.append(
        contentsOf: scenario.failures.map { "\(scenario.sessionCount)-session: \($0)" })
    }

    return HarnessPerformanceGateResult(
      schemaVersion: 1,
      iterations: iterations,
      backgroundDrawAttempts: backgroundDrawAttempts,
      backgroundMetalSubmissions: backgroundSubmissions,
      deviceModel: machineIdentifier(),
      systemVersion: UIDevice.current.systemVersion,
      maximumFramesPerSecond: UIScreen.main.maximumFramesPerSecond,
      physicalMemoryBytes: ProcessInfo.processInfo.physicalMemory,
      processorCount: ProcessInfo.processInfo.processorCount,
      lowPowerModeEnabled: ProcessInfo.processInfo.isLowPowerModeEnabled,
      thermalState: thermalStateName(ProcessInfo.processInfo.thermalState),
      snapshot: afterBackground,
      fairnessScenarios: fairnessScenarios,
      failures: failures
    )
  }

  private static func runFairnessScenario(
    runtime: GhostteaRuntime,
    sessionCount: Int
  ) async throws -> HarnessPerformanceFairnessScenario {
    let terminals = try (0..<sessionCount).map { index in
      try GhostteaTerminal(
        runtime: runtime,
        configuration: .init(
          sessionHandle: UInt64(10_000 + sessionCount * 100 + index),
          columns: 100,
          rows: 30
        )
      )
    }
    for terminal in terminals {
      _ = try await terminal.feed(Data("fairness-warmup".utf8), render: .full)
    }

    let recorder = GhostteaPerformanceRecorder.shared
    recorder.reset()
    let iterationsPerSession = fairnessIterationsPerSession
    let sessions = try await withThrowingTaskGroup(
      of: HarnessPerformanceFairnessSession.self,
      returning: [HarnessPerformanceFairnessSession].self
    ) { group in
      for (sessionIndex, terminal) in terminals.enumerated() {
        group.addTask {
          var durations: [UInt64] = []
          durations.reserveCapacity(iterationsPerSession)
          let scenarioStarted = DispatchTime.now().uptimeNanoseconds
          for iteration in 0..<iterationsPerSession {
            let bytes = Data("\rcontention-\(iteration)\u{1b}[K".utf8)
            let started = DispatchTime.now().uptimeNanoseconds
            _ = try await terminal.feed(bytes, render: .damage)
            durations.append(DispatchTime.now().uptimeNanoseconds &- started)
          }
          let elapsed = DispatchTime.now().uptimeNanoseconds &- scenarioStarted
          let sorted = durations.sorted()
          let p50Index = max(0, (sorted.count * 50 + 99) / 100 - 1)
          let p99Index = max(0, (sorted.count * 99 + 99) / 100 - 1)
          return HarnessPerformanceFairnessSession(
            sessionIndex: sessionIndex,
            sampleCount: sorted.count,
            elapsedNanoseconds: elapsed,
            p50Nanoseconds: sorted[p50Index],
            p99Nanoseconds: sorted[p99Index],
            maximumNanoseconds: sorted.last ?? 0
          )
        }
      }
      var completed: [HarnessPerformanceFairnessSession] = []
      for try await session in group {
        completed.append(session)
      }
      return completed.sorted { $0.sessionIndex < $1.sessionIndex }
    }

    let snapshot = recorder.snapshot()
    let p99s = sessions.map(\.p99Nanoseconds)
    let elapsed = sessions.map(\.elapsedNanoseconds)
    let p99Ratio = ratioPermille(maximum: p99s.max() ?? 0, minimum: p99s.min() ?? 0)
    let elapsedRatio = ratioPermille(maximum: elapsed.max() ?? 0, minimum: elapsed.min() ?? 0)
    let expectedSamples = sessionCount * fairnessIterationsPerSession
    var failures: [String] = []

    for session in sessions where session.sampleCount != fairnessIterationsPerSession {
      failures.append("session did not complete every feed")
    }
    for metric in [
      GhostteaPerformanceMetric.nativeFeed,
      .textEngineLockWait,
      .textEngineLockHold,
    ] {
      guard let summary = snapshot.summaries.first(where: { $0.metric == metric }) else {
        failures.append("\(metric.rawValue) has no samples")
        continue
      }
      if summary.sampleCount != expectedSamples {
        failures.append(
          "\(metric.rawValue) has \(summary.sampleCount) of \(expectedSamples) samples")
      }
      if summary.droppedSampleCount != 0 {
        failures.append("\(metric.rawValue) dropped samples")
      }
    }
    if let lockWait = snapshot.summaries.first(where: { $0.metric == .textEngineLockWait }),
      lockWait.p99Nanoseconds >= 8_000_000
    {
      failures.append("text-engine lock-wait p99 exceeds 8 ms")
    }
    if sessions.contains(where: { $0.p99Nanoseconds >= 16_000_000 }) {
      failures.append("one or more session feed p99 values exceed 16 ms")
    }
    if p99Ratio > 4_000 {
      failures.append("slowest session feed p99 exceeds 4x the fastest")
    }
    if elapsedRatio > 2_000 {
      failures.append("slowest session completion exceeds 2x the fastest")
    }

    return HarnessPerformanceFairnessScenario(
      sessionCount: sessionCount,
      iterationsPerSession: fairnessIterationsPerSession,
      snapshot: snapshot,
      sessions: sessions,
      slowestToFastestP99Permille: p99Ratio,
      slowestToFastestElapsedPermille: elapsedRatio,
      failures: failures
    )
  }

  private static func waitUntilConnected(_ session: GhostteaSession) async throws {
    for _ in 0..<200 {
      if case .connected = await session.snapshot().reconnectState { return }
      try await Task.sleep(for: .milliseconds(10))
    }
    throw HarnessPerformanceGateError.connectionDidNotBecomeReady
  }

  private static func activeWindow() async throws -> UIWindow {
    for _ in 0..<200 {
      if let window = UIApplication.shared.connectedScenes
        .compactMap({ $0 as? UIWindowScene })
        .flatMap(\.windows)
        .first(where: \.isKeyWindow)
      {
        return window
      }
      try await Task.sleep(for: .milliseconds(10))
    }
    throw HarnessPerformanceGateError.windowUnavailable
  }

  private static func sampleCount(
    _ metric: GhostteaPerformanceMetric,
    in snapshot: GhostteaPerformanceSnapshot
  ) -> Int {
    snapshot.summaries.first(where: { $0.metric == metric })?.sampleCount ?? 0
  }

  private static func requireSamples(
    _ metric: GhostteaPerformanceMetric,
    snapshot: GhostteaPerformanceSnapshot,
    failures: inout [String]
  ) {
    guard let summary = snapshot.summaries.first(where: { $0.metric == metric }) else {
      failures.append("\(metric.rawValue) has no samples")
      return
    }
    if summary.sampleCount != iterations {
      failures.append("\(metric.rawValue) has \(summary.sampleCount) of \(iterations) samples")
    }
    if summary.droppedSampleCount != 0 {
      failures.append("\(metric.rawValue) dropped samples")
    }
  }

  private static func requireLatency(
    _ metric: GhostteaPerformanceMetric,
    snapshot: GhostteaPerformanceSnapshot,
    p50LimitNanoseconds: UInt64,
    p99LimitNanoseconds: UInt64,
    failures: inout [String]
  ) {
    requireSamples(metric, snapshot: snapshot, failures: &failures)
    guard let summary = snapshot.summaries.first(where: { $0.metric == metric }) else { return }
    if summary.p50Nanoseconds >= p50LimitNanoseconds {
      failures.append("\(metric.rawValue) p50 exceeds its strict latency target")
    }
    if summary.p99Nanoseconds >= p99LimitNanoseconds {
      failures.append("\(metric.rawValue) p99 exceeds its strict latency target")
    }
  }

  private static func machineIdentifier() -> String {
    var system = utsname()
    uname(&system)
    return withUnsafePointer(to: &system.machine) { pointer in
      pointer.withMemoryRebound(to: CChar.self, capacity: 1) {
        String(cString: $0)
      }
    }
  }

  private static func thermalStateName(_ state: ProcessInfo.ThermalState) -> String {
    switch state {
    case .nominal: "nominal"
    case .fair: "fair"
    case .serious: "serious"
    case .critical: "critical"
    @unknown default: "unknown"
    }
  }

  private static func ratioPermille(maximum: UInt64, minimum: UInt64) -> UInt64 {
    guard minimum > 0 else { return maximum == 0 ? 1_000 : UInt64.max }
    return maximum.multipliedReportingOverflow(by: 1_000).overflow
      ? UInt64.max
      : maximum * 1_000 / minimum
  }
}
