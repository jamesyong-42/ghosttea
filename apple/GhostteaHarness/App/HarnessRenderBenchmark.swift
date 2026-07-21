import Darwin
import Foundation
import GhostteaCore
import GhostteaPerformance
import GhostteaTerminal
import GhostteaTruffle
import UIKit

struct HarnessRenderBenchmarkConfiguration: Codable, Sendable {
  let schemaVersion: Int
  let warmupIterations: Int
  let measuredIterations: Int
  let cooldownMilliseconds: Int
  let scale: Double
  let cases: [String]
  let encodedGeometryReuseEnabled: Bool?
  let inPlaceRetainedStateCommitEnabled: Bool?
  let instancedSubmissionEnabled: Bool?
  let rowGeometryReuseEnabled: Bool?
  let lazyColorAtlasEnabled: Bool?
  let displayLinkedSchedulingEnabled: Bool?
  let truffleStateCodec: GhostteaStateCodec?
}

struct HarnessRenderBenchmarkDevice: Codable, Sendable {
  let model: String
  let systemVersion: String
  let maximumFramesPerSecond: Int
  let physicalMemoryBytes: UInt64
  let processorCount: Int
  let lowPowerModeEnabled: Bool
}

struct HarnessRenderBenchmarkCounters: Codable, Sendable {
  let acceptedFrames: Int
  let renderedFrames: Int
  let staleFrames: Int
  let fullRefreshRequests: Int
  let vertexUploadBytes: UInt64
  let atlasUploadBytes: UInt64
  let bufferAllocations: UInt64
  let drawCalls: UInt64
  let commandBufferCommits: UInt64
  let fullDamageSubmissions: Int
  let rowDamageSubmissions: Int
  let damagedRowsSubmitted: Int
  let cursorDamageSubmissions: Int
  let selectionDamageSubmissions: Int
  let geometryDamageSubmissions: Int
  let rowCacheHits: Int
  let rowCacheAdmissions: Int
  let rowCacheEvictions: Int
  let residentAtlasBytes: UInt64
  let residentGlyphBytes: UInt64
}

struct HarnessRenderBenchmarkSample: Codable, Sendable {
  let iteration: Int
  let operations: Int
  let surfaceCount: Int
  let sourceBytes: UInt64
  let trf1Bytes: UInt64
  let elapsedNanoseconds: UInt64
  let activeNanoseconds: UInt64
  let operationP50Nanoseconds: UInt64
  let operationP99Nanoseconds: UInt64
  let operationMaximumNanoseconds: UInt64
  let footprintBeforeBytes: UInt64
  let footprintAfterBytes: UInt64
  let thermalStateBefore: String
  let thermalStateAfter: String
  let performance: GhostteaPerformanceSnapshot
  let renderer: HarnessRenderBenchmarkCounters
  let pixelHash: UInt64
  let nonBackgroundPixelCount: Int
  let failures: [String]
}

struct HarnessRenderBenchmarkCaseResult: Codable, Sendable {
  let name: String
  let samples: [HarnessRenderBenchmarkSample]
}

struct HarnessRenderBenchmarkResult: Codable, Sendable {
  let schemaVersion: Int
  let suite: String
  let configuration: HarnessRenderBenchmarkConfiguration
  let device: HarnessRenderBenchmarkDevice
  let framePacingNanoseconds: UInt64
  let cases: [HarnessRenderBenchmarkCaseResult]
  let failures: [String]

  var passed: Bool { failures.isEmpty }
}

private enum HarnessRenderBenchmarkError: Error, CustomStringConvertible {
  case invalidConfiguration(String)
  case unknownCase(String)
  case frameMissing
  case windowUnavailable
  case physicalFootprintFailed(kern_return_t)

  var description: String {
    switch self {
    case .invalidConfiguration(let reason): "invalid configuration: \(reason)"
    case .unknownCase(let name): "unknown benchmark case: \(name)"
    case .frameMissing: "native terminal did not emit a frame"
    case .windowUnavailable: "iOS window was unavailable"
    case .physicalFootprintFailed(let result): "task_info failed with \(result)"
    }
  }
}

private struct HarnessRenderCaseSpec: Sendable {
  enum Kind: Sendable, Equatable {
    case feed
    case repaint
    case resizeJitter
    case truffleDoomFire
  }

  let name: String
  let surfaceCount: Int
  let baseOperations: Int
  let kind: Kind
}

private struct HarnessTruffleDoomPayload: Sendable {
  let json: Data
  let compact: Data
}

private struct HarnessTruffleDoomParity: Sendable {
  let frames: [Data]
  let fullFrame: Data
}

@MainActor
enum HarnessRenderBenchmark {
  static let defaultCases = [
    "repaint-1",
    "cursor-1",
    "typing-1",
    "sparse-1",
    "scroll-1",
    "dense-1",
    "truecolor-1",
    "doom-fire-1",
    "unicode-1",
    "scroll-4",
    "scroll-8",
    "resize-jitter-1",
  ]

  private static let columns: UInt16 = 100
  private static let rows: UInt16 = 30

  static func run(
    configuration: HarnessRenderBenchmarkConfiguration
  ) async throws -> HarnessRenderBenchmarkResult {
    try validate(configuration)
    let specs = try configuration.cases.map(specification)
    let recorder = GhostteaPerformanceRecorder.shared
    recorder.setEnabled(true)
    defer { recorder.setEnabled(false) }

    let maximumFramesPerSecond = max(1, UIScreen.main.maximumFramesPerSecond)
    let framePacingNanoseconds = UInt64(1_000_000_000 / maximumFramesPerSecond) + 1_000_000
    let window = try await activeWindow()
    var caseResults: [HarnessRenderBenchmarkCaseResult] = []
    var suiteFailures: [String] = []

    for spec in specs {
      for _ in 0..<configuration.warmupIterations {
        _ = try await runSample(
          spec: spec,
          iteration: -1,
          scale: configuration.scale,
          encodedGeometryReuseEnabled: configuration.encodedGeometryReuseEnabled ?? true,
          inPlaceRetainedStateCommitEnabled:
            configuration.inPlaceRetainedStateCommitEnabled ?? true,
          instancedSubmissionEnabled: configuration.instancedSubmissionEnabled ?? true,
          rowGeometryReuseEnabled: configuration.rowGeometryReuseEnabled ?? true,
          lazyColorAtlasEnabled: configuration.lazyColorAtlasEnabled ?? true,
          displayLinkedSchedulingEnabled:
            configuration.displayLinkedSchedulingEnabled ?? false,
          truffleStateCodec: configuration.truffleStateCodec ?? .json,
          pacingNanoseconds: framePacingNanoseconds,
          window: window,
          validatePixels: false
        )
        try await cooldown(configuration.cooldownMilliseconds)
      }

      var samples: [HarnessRenderBenchmarkSample] = []
      for iteration in 0..<configuration.measuredIterations {
        let sample = try await runSample(
          spec: spec,
          iteration: iteration,
          scale: configuration.scale,
          encodedGeometryReuseEnabled: configuration.encodedGeometryReuseEnabled ?? true,
          inPlaceRetainedStateCommitEnabled:
            configuration.inPlaceRetainedStateCommitEnabled ?? true,
          instancedSubmissionEnabled: configuration.instancedSubmissionEnabled ?? true,
          rowGeometryReuseEnabled: configuration.rowGeometryReuseEnabled ?? true,
          lazyColorAtlasEnabled: configuration.lazyColorAtlasEnabled ?? true,
          displayLinkedSchedulingEnabled:
            configuration.displayLinkedSchedulingEnabled ?? false,
          truffleStateCodec: configuration.truffleStateCodec ?? .json,
          pacingNanoseconds: framePacingNanoseconds,
          window: window,
          validatePixels: true
        )
        samples.append(sample)
        suiteFailures.append(
          contentsOf: sample.failures.map { "\(spec.name)[\(iteration)]: \($0)" })
        try await cooldown(configuration.cooldownMilliseconds)
      }
      caseResults.append(HarnessRenderBenchmarkCaseResult(name: spec.name, samples: samples))
    }

    return HarnessRenderBenchmarkResult(
      schemaVersion: 1,
      suite: "ghosttea-ios-render-v1",
      configuration: configuration,
      device: HarnessRenderBenchmarkDevice(
        model: machineIdentifier(),
        systemVersion: UIDevice.current.systemVersion,
        maximumFramesPerSecond: maximumFramesPerSecond,
        physicalMemoryBytes: ProcessInfo.processInfo.physicalMemory,
        processorCount: ProcessInfo.processInfo.processorCount,
        lowPowerModeEnabled: ProcessInfo.processInfo.isLowPowerModeEnabled
      ),
      framePacingNanoseconds: framePacingNanoseconds,
      cases: caseResults,
      failures: suiteFailures
    )
  }

  private static func runSample(
    spec: HarnessRenderCaseSpec,
    iteration: Int,
    scale: Double,
    encodedGeometryReuseEnabled: Bool,
    inPlaceRetainedStateCommitEnabled: Bool,
    instancedSubmissionEnabled: Bool,
    rowGeometryReuseEnabled: Bool,
    lazyColorAtlasEnabled: Bool,
    displayLinkedSchedulingEnabled: Bool,
    truffleStateCodec: GhostteaStateCodec,
    pacingNanoseconds: UInt64,
    window: UIWindow,
    validatePixels: Bool
  ) async throws -> HarnessRenderBenchmarkSample {
    let operationCount = max(1, Int((Double(spec.baseOperations) * scale).rounded()))
    if case .truffleDoomFire = spec.kind {
      return try await runTruffleDoomSample(
        spec: spec,
        iteration: iteration,
        operationCount: operationCount,
        codec: truffleStateCodec,
        encodedGeometryReuseEnabled: encodedGeometryReuseEnabled,
        inPlaceRetainedStateCommitEnabled: inPlaceRetainedStateCommitEnabled,
        instancedSubmissionEnabled: instancedSubmissionEnabled,
        rowGeometryReuseEnabled: rowGeometryReuseEnabled,
        lazyColorAtlasEnabled: lazyColorAtlasEnabled,
        displayLinkedSchedulingEnabled: displayLinkedSchedulingEnabled,
        pacingNanoseconds: pacingNanoseconds,
        window: window,
        validatePixels: validatePixels
      )
    }
    let runtime = try GhostteaRuntime()
    let terminals = try (0..<spec.surfaceCount).map { index in
      try GhostteaTerminal(
        runtime: runtime,
        configuration: .init(
          sessionHandle: UInt64(40_000 + spec.surfaceCount * 1_000 + index),
          columns: columns,
          rows: rows
        )
      )
    }
    let surfaces = try (0..<spec.surfaceCount).map { _ in
      let surface = try GhostteaTerminalMetalView(
        terminalFrame: .zero,
        encodedGeometryReuseEnabled: encodedGeometryReuseEnabled,
        inPlaceRetainedStateCommitEnabled: inPlaceRetainedStateCommitEnabled,
        instancedSubmissionEnabled: instancedSubmissionEnabled,
        rowGeometryReuseEnabled: rowGeometryReuseEnabled,
        lazyColorAtlasEnabled: lazyColorAtlasEnabled,
        displayLinkedSchedulingEnabled: displayLinkedSchedulingEnabled
      )
      surface.isPaused = true
      surface.enableSetNeedsDisplay = false
      surface.includesSafeAreaInsets = false
      return surface
    }
    layout(surfaces: surfaces, in: window.bounds)
    for surface in surfaces { window.addSubview(surface) }
    defer {
      for surface in surfaces {
        surface.suspendGPU()
        surface.removeFromSuperview()
      }
    }
    for surface in surfaces { surface.layoutIfNeeded() }

    let initialPayload = makeInitialPayload()
    let initialFrames = try await feed(terminals: terminals, payload: initialPayload, render: .full)
    for (surface, frame) in zip(surfaces, initialFrames) {
      guard try surface.apply(frame: frame) else { throw HarnessRenderBenchmarkError.frameMissing }
    }
    if displayLinkedSchedulingEnabled {
      GhostteaTerminalMetalView.flushDisplayLinkedRenders()
    } else {
      for surface in surfaces { surface.draw(in: surface) }
    }
    try await Task.sleep(for: .nanoseconds(Int64(pacingNanoseconds * 2)))

    let payloads = makePayloads(for: spec.name, operations: operationCount)
    let baselineDiagnostics = aggregateDiagnostics(surfaces)
    let footprintBefore = try stablePhysicalFootprintBytes()
    let thermalBefore = thermalStateName(ProcessInfo.processInfo.thermalState)
    let recorder = GhostteaPerformanceRecorder.shared
    recorder.reset()

    var sourceBytes: UInt64 = 0
    var trf1Bytes: UInt64 = 0
    var operationDurations: [UInt64] = []
    operationDurations.reserveCapacity(operationCount)
    let elapsedStarted = DispatchTime.now().uptimeNanoseconds

    for operation in 0..<operationCount {
      try await Task.sleep(for: .nanoseconds(Int64(pacingNanoseconds)))
      let started = DispatchTime.now().uptimeNanoseconds
      switch spec.kind {
      case .feed:
        let payload = payloads[operation]
        let frames = try await feed(terminals: terminals, payload: payload, render: .damage)
        sourceBytes &+= UInt64(payload.count * terminals.count)
        trf1Bytes &+= frames.reduce(0) { $0 &+ UInt64($1.count) }
        for (surface, frame) in zip(surfaces, frames) {
          guard try surface.apply(frame: frame) else {
            throw HarnessRenderBenchmarkError.frameMissing
          }
        }
        if displayLinkedSchedulingEnabled {
          GhostteaTerminalMetalView.flushDisplayLinkedRenders()
        } else {
          for surface in surfaces { surface.draw(in: surface) }
        }
      case .repaint:
        for surface in surfaces { surface.draw(in: surface) }
      case .resizeJitter:
        let jitter: CGFloat = operation.isMultiple(of: 2) ? 0.2 : 0
        layout(surfaces: surfaces, in: window.bounds, jitter: jitter)
        for surface in surfaces { surface.layoutIfNeeded() }
        if displayLinkedSchedulingEnabled {
          GhostteaTerminalMetalView.flushDisplayLinkedRenders()
        } else {
          for surface in surfaces { surface.draw(in: surface) }
        }
      case .truffleDoomFire:
        preconditionFailure("Truffle samples use their dedicated path")
      }
      operationDurations.append(DispatchTime.now().uptimeNanoseconds &- started)
    }
    let elapsed = DispatchTime.now().uptimeNanoseconds &- elapsedStarted
    try await Task.sleep(for: .nanoseconds(Int64(pacingNanoseconds * 3)))
    let performance = recorder.snapshot()
    let footprintAfter = try stablePhysicalFootprintBytes()
    let thermalAfter = thermalStateName(ProcessInfo.processInfo.thermalState)
    let finalDiagnostics = aggregateDiagnostics(surfaces)
    let renderer = diagnosticDelta(from: baselineDiagnostics, to: finalDiagnostics)
    let sortedDurations = operationDurations.sorted()

    recorder.setEnabled(false)
    let proof: GhostteaMetalProofResult?
    if validatePixels {
      let update = try await terminals[0].refresh(.full)
      guard let frame = update.effects.last(where: { $0.kind == .frameReady })?.payload else {
        throw HarnessRenderBenchmarkError.frameMissing
      }
      proof = try GhostteaMetalProof.run(frame: frame)
    } else {
      proof = nil
    }
    recorder.setEnabled(true)

    var failures: [String] = []
    let expectedRendered = operationCount * spec.surfaceCount
    let expectedAccepted = spec.kind == .feed ? expectedRendered : 0
    if renderer.renderedFrames != expectedRendered {
      failures.append("rendered \(renderer.renderedFrames) of \(expectedRendered) expected frames")
    }
    if renderer.acceptedFrames != expectedAccepted {
      failures.append("accepted \(renderer.acceptedFrames) of \(expectedAccepted) expected frames")
    }
    if renderer.staleFrames != 0 || renderer.fullRefreshRequests != 0 {
      failures.append("renderer reported stale frames or requested a full refresh")
    }
    let expectedCommandBufferCommits =
      displayLinkedSchedulingEnabled && spec.kind != .repaint
      ? operationCount : expectedRendered
    if renderer.commandBufferCommits != UInt64(expectedCommandBufferCommits) {
      failures.append("command-buffer commit count does not match rendered frames")
    }
    if let summary = performance.summaries.first(where: { $0.metric == .metalSubmission }) {
      if summary.sampleCount != expectedRendered || summary.droppedSampleCount != 0 {
        failures.append("Metal submission samples are incomplete or dropped")
      }
    } else {
      failures.append("Metal submission samples are missing")
    }
    if spec.kind == .feed,
      performance.summaries.first(where: { $0.metric == .frameDecode })?.sampleCount
        != expectedAccepted
    {
      failures.append("TRF1 apply sample count does not match accepted frames")
    }
    if case .feed = spec.kind {
      for (metric, label) in [
        (GhostteaPerformanceMetric.trf1FrameDecode, "TRF1 envelope decode"),
        (.retainedStatePrepare, "retained-state prepare"),
        (.retainedStateCommit, "retained-state commit"),
      ] {
        if performance.summaries.first(where: { $0.metric == metric })?.sampleCount
          != expectedAccepted
        {
          failures.append("\(label) sample count does not match accepted frames")
        }
      }
    }
    if performance.summaries.contains(where: { $0.droppedSampleCount != 0 }) {
      failures.append("one or more performance metrics dropped samples")
    }
    if proof?.cachedUploadBytes != 0 {
      failures.append("identical correctness render unexpectedly re-uploaded glyphs")
    }
    if ProcessInfo.processInfo.isLowPowerModeEnabled {
      failures.append("Low Power Mode is enabled")
    }
    if [thermalBefore, thermalAfter].contains(where: { $0 != "nominal" }) {
      failures.append("thermal state was not nominal for the complete sample")
    }

    return HarnessRenderBenchmarkSample(
      iteration: iteration,
      operations: operationCount,
      surfaceCount: spec.surfaceCount,
      sourceBytes: sourceBytes,
      trf1Bytes: trf1Bytes,
      elapsedNanoseconds: elapsed,
      activeNanoseconds: operationDurations.reduce(0, &+),
      operationP50Nanoseconds: percentile(sortedDurations, 50),
      operationP99Nanoseconds: percentile(sortedDurations, 99),
      operationMaximumNanoseconds: sortedDurations.last ?? 0,
      footprintBeforeBytes: footprintBefore,
      footprintAfterBytes: footprintAfter,
      thermalStateBefore: thermalBefore,
      thermalStateAfter: thermalAfter,
      performance: performance,
      renderer: renderer,
      pixelHash: proof?.pixelHash ?? 0,
      nonBackgroundPixelCount: proof?.nonBackgroundPixelCount ?? 0,
      failures: failures
    )
  }

  /// Measures the production shared-session receive path independently from
  /// network variability: state bytes -> negotiated decoder -> logical replica
  /// -> TRF1 -> Metal. JSON and compact runs use identical logical fire frames.
  private static func runTruffleDoomSample(
    spec: HarnessRenderCaseSpec,
    iteration: Int,
    operationCount: Int,
    codec: GhostteaStateCodec,
    encodedGeometryReuseEnabled: Bool,
    inPlaceRetainedStateCommitEnabled: Bool,
    instancedSubmissionEnabled: Bool,
    rowGeometryReuseEnabled: Bool,
    lazyColorAtlasEnabled: Bool,
    displayLinkedSchedulingEnabled: Bool,
    pacingNanoseconds: UInt64,
    window: UIWindow,
    validatePixels: Bool
  ) async throws -> HarnessRenderBenchmarkSample {
    let payloads = try makeTruffleDoomPayloads(frames: operationCount)
    let parity = try await validateTruffleDoomParity(payloads)
    let runtime = try GhostteaRuntime()
    let replica = try GhostteaLogicalReplica(runtime: runtime, sessionHandle: 84_001)
    let surface = try GhostteaTerminalMetalView(
      terminalFrame: .zero,
      encodedGeometryReuseEnabled: encodedGeometryReuseEnabled,
      inPlaceRetainedStateCommitEnabled: inPlaceRetainedStateCommitEnabled,
      instancedSubmissionEnabled: instancedSubmissionEnabled,
      rowGeometryReuseEnabled: rowGeometryReuseEnabled,
      lazyColorAtlasEnabled: lazyColorAtlasEnabled,
      displayLinkedSchedulingEnabled: displayLinkedSchedulingEnabled
    )
    surface.isPaused = true
    surface.enableSetNeedsDisplay = false
    surface.includesSafeAreaInsets = false
    layout(surfaces: [surface], in: window.bounds)
    window.addSubview(surface)
    defer {
      surface.suspendGPU()
      surface.removeFromSuperview()
    }
    surface.layoutIfNeeded()

    let baselineDiagnostics = aggregateDiagnostics([surface])
    let footprintBefore = try stablePhysicalFootprintBytes()
    let thermalBefore = thermalStateName(ProcessInfo.processInfo.thermalState)
    let recorder = GhostteaPerformanceRecorder.shared
    recorder.reset()
    let encoder = JSONEncoder()
    var sourceBytes: UInt64 = 0
    var trf1Bytes: UInt64 = 0
    var operationDurations: [UInt64] = []
    operationDurations.reserveCapacity(operationCount)
    let elapsedStarted = DispatchTime.now().uptimeNanoseconds

    for (index, payload) in payloads.enumerated() {
      try await Task.sleep(for: .nanoseconds(Int64(pacingNanoseconds)))
      let started = DispatchTime.now().uptimeNanoseconds
      let encoded = codec == .json ? payload.json : payload.compact
      let message = try recorder.measure(.truffleStateDecode, byteCount: encoded.count) {
        try GhostteaTerminalStateCodec.decode(encoded, codec: codec)
      }
      let update = try await recorder.measure(.truffleReplicaPublication) {
        try await publish(message, to: replica, encoder: encoder)
      }
      guard let frame = update.effects.last(where: { $0.kind == .frameReady })?.payload else {
        throw HarnessRenderBenchmarkError.frameMissing
      }
      guard frame == parity.frames[index] else {
        throw HarnessRenderBenchmarkError.invalidConfiguration(
          "selected Truffle codec produced different TRF1"
        )
      }
      guard try surface.apply(frame: frame) else {
        throw HarnessRenderBenchmarkError.frameMissing
      }
      if displayLinkedSchedulingEnabled {
        GhostteaTerminalMetalView.flushDisplayLinkedRenders()
      } else {
        surface.draw(in: surface)
      }
      sourceBytes &+= UInt64(encoded.count)
      trf1Bytes &+= UInt64(frame.count)
      operationDurations.append(DispatchTime.now().uptimeNanoseconds &- started)
    }
    let elapsed = DispatchTime.now().uptimeNanoseconds &- elapsedStarted
    try await Task.sleep(for: .nanoseconds(Int64(pacingNanoseconds * 3)))
    let performance = recorder.snapshot()
    let footprintAfter = try stablePhysicalFootprintBytes()
    let thermalAfter = thermalStateName(ProcessInfo.processInfo.thermalState)
    let renderer = diagnosticDelta(
      from: baselineDiagnostics,
      to: aggregateDiagnostics([surface])
    )
    let sortedDurations = operationDurations.sorted()

    recorder.setEnabled(false)
    let refresh = try await replica.refresh()
    guard let fullFrame = refresh.effects.last(where: { $0.kind == .frameReady })?.payload,
      fullFrame == parity.fullFrame
    else {
      throw HarnessRenderBenchmarkError.invalidConfiguration(
        "selected Truffle codec produced different full-refresh TRF1"
      )
    }
    let proof = validatePixels ? try GhostteaMetalProof.run(frame: fullFrame) : nil
    recorder.setEnabled(true)

    var failures: [String] = []
    if renderer.renderedFrames != operationCount || renderer.acceptedFrames != operationCount {
      failures.append(
        "Truffle renderer accepted/rendered \(renderer.acceptedFrames)/\(renderer.renderedFrames) of \(operationCount) frames"
      )
    }
    if renderer.staleFrames != 0 || renderer.fullRefreshRequests != 0 {
      failures.append("renderer reported stale frames or requested a full refresh")
    }
    if renderer.commandBufferCommits != UInt64(operationCount) {
      failures.append("command-buffer commit count does not match rendered frames")
    }
    let expectedMetrics: [(GhostteaPerformanceMetric, String)] = [
      (.truffleStateDecode, "Truffle state decode"),
      (.truffleReplicaPublication, "Truffle replica publication"),
      (.trf1FrameDecode, "TRF1 envelope decode"),
      (.retainedStatePrepare, "retained-state prepare"),
      (.retainedStateCommit, "retained-state commit"),
      (.frameDecode, "TRF1 apply"),
      (.metalSubmission, "Metal submission"),
    ]
    for (metric, label) in expectedMetrics {
      guard let summary = performance.summaries.first(where: { $0.metric == metric }) else {
        failures.append("\(label) samples are missing")
        continue
      }
      if summary.sampleCount != operationCount || summary.droppedSampleCount != 0 {
        failures.append("\(label) samples are incomplete or dropped")
      }
    }
    if performance.summaries.contains(where: { $0.droppedSampleCount != 0 }) {
      failures.append("one or more performance metrics dropped samples")
    }
    if proof?.cachedUploadBytes != 0 {
      failures.append("identical correctness render unexpectedly re-uploaded glyphs")
    }
    if ProcessInfo.processInfo.isLowPowerModeEnabled {
      failures.append("Low Power Mode is enabled")
    }
    if [thermalBefore, thermalAfter].contains(where: { $0 != "nominal" }) {
      failures.append("thermal state was not nominal for the complete sample")
    }

    return HarnessRenderBenchmarkSample(
      iteration: iteration,
      operations: operationCount,
      surfaceCount: spec.surfaceCount,
      sourceBytes: sourceBytes,
      trf1Bytes: trf1Bytes,
      elapsedNanoseconds: elapsed,
      activeNanoseconds: operationDurations.reduce(0, &+),
      operationP50Nanoseconds: percentile(sortedDurations, 50),
      operationP99Nanoseconds: percentile(sortedDurations, 99),
      operationMaximumNanoseconds: sortedDurations.last ?? 0,
      footprintBeforeBytes: footprintBefore,
      footprintAfterBytes: footprintAfter,
      thermalStateBefore: thermalBefore,
      thermalStateAfter: thermalAfter,
      performance: performance,
      renderer: renderer,
      pixelHash: proof?.pixelHash ?? 0,
      nonBackgroundPixelCount: proof?.nonBackgroundPixelCount ?? 0,
      failures: failures
    )
  }

  private static func publish(
    _ message: GhostteaTerminalStateMessage,
    to replica: GhostteaLogicalReplica,
    encoder: JSONEncoder
  ) async throws -> GhostteaUpdate {
    switch message {
    case .snapshot(let snapshot):
      return try await replica.publishSnapshotJSON(encoder.encode(snapshot))
    case .patch(let patch):
      return try await replica.publishPatchJSON(encoder.encode(patch))
    case .controlChanged:
      throw HarnessRenderBenchmarkError.invalidConfiguration(
        "control messages cannot produce replica frames"
      )
    }
  }

  private static func validateTruffleDoomParity(
    _ payloads: [HarnessTruffleDoomPayload]
  ) async throws -> HarnessTruffleDoomParity {
    let jsonReplica = try GhostteaLogicalReplica(runtime: GhostteaRuntime(), sessionHandle: 84_001)
    let compactReplica = try GhostteaLogicalReplica(
      runtime: GhostteaRuntime(), sessionHandle: 84_001)
    let encoder = JSONEncoder()
    var frames: [Data] = []
    frames.reserveCapacity(payloads.count)
    for payload in payloads {
      let json = try GhostteaTerminalStateCodec.decode(payload.json, codec: .json)
      let compact = try GhostteaTerminalStateCodec.decode(
        payload.compact, codec: .compactJSONV1)
      guard json == compact else {
        throw HarnessRenderBenchmarkError.invalidConfiguration(
          "JSON and compact Doom state decoded differently"
        )
      }
      let jsonUpdate = try await publish(json, to: jsonReplica, encoder: encoder)
      let compactUpdate = try await publish(compact, to: compactReplica, encoder: encoder)
      guard
        let jsonFrame = jsonUpdate.effects.last(where: { $0.kind == .frameReady })?.payload,
        let compactFrame = compactUpdate.effects.last(where: { $0.kind == .frameReady })?.payload,
        jsonFrame == compactFrame
      else {
        throw HarnessRenderBenchmarkError.invalidConfiguration(
          "JSON and compact Doom state produced different TRF1"
        )
      }
      frames.append(jsonFrame)
    }
    let jsonRefresh = try await jsonReplica.refresh()
    let compactRefresh = try await compactReplica.refresh()
    guard
      let jsonFullFrame = jsonRefresh.effects.last(where: { $0.kind == .frameReady })?.payload,
      let compactFullFrame = compactRefresh.effects.last(where: { $0.kind == .frameReady })?
        .payload,
      jsonFullFrame == compactFullFrame
    else {
      throw HarnessRenderBenchmarkError.invalidConfiguration(
        "JSON and compact Doom state produced different full-refresh TRF1"
      )
    }
    return HarnessTruffleDoomParity(frames: frames, fullFrame: jsonFullFrame)
  }

  private static func feed(
    terminals: [GhostteaTerminal],
    payload: Data,
    render: GhostteaRenderRequest
  ) async throws -> [Data] {
    try await withThrowingTaskGroup(of: (Int, Data).self) { group in
      for (index, terminal) in terminals.enumerated() {
        group.addTask {
          let update = try await terminal.feed(payload, render: render)
          guard let frame = update.effects.last(where: { $0.kind == .frameReady })?.payload else {
            throw HarnessRenderBenchmarkError.frameMissing
          }
          return (index, frame)
        }
      }
      var frames = Array(repeating: Data(), count: terminals.count)
      for try await (index, frame) in group { frames[index] = frame }
      return frames
    }
  }

  private static func specification(_ name: String) throws -> HarnessRenderCaseSpec {
    switch name {
    case "repaint-1": .init(name: name, surfaceCount: 1, baseOperations: 120, kind: .repaint)
    case "cursor-1": .init(name: name, surfaceCount: 1, baseOperations: 120, kind: .feed)
    case "typing-1": .init(name: name, surfaceCount: 1, baseOperations: 120, kind: .feed)
    case "sparse-1": .init(name: name, surfaceCount: 1, baseOperations: 90, kind: .feed)
    case "scroll-1": .init(name: name, surfaceCount: 1, baseOperations: 60, kind: .feed)
    case "dense-1": .init(name: name, surfaceCount: 1, baseOperations: 45, kind: .feed)
    case "truecolor-1": .init(name: name, surfaceCount: 1, baseOperations: 45, kind: .feed)
    case "doom-fire-1": .init(name: name, surfaceCount: 1, baseOperations: 180, kind: .feed)
    case "doom-fire-truffle-1":
      .init(name: name, surfaceCount: 1, baseOperations: 45, kind: .truffleDoomFire)
    case "unicode-1": .init(name: name, surfaceCount: 1, baseOperations: 60, kind: .feed)
    case "scroll-4": .init(name: name, surfaceCount: 4, baseOperations: 60, kind: .feed)
    case "scroll-8": .init(name: name, surfaceCount: 8, baseOperations: 45, kind: .feed)
    case "resize-jitter-1":
      .init(name: name, surfaceCount: 1, baseOperations: 120, kind: .resizeJitter)
    default: throw HarnessRenderBenchmarkError.unknownCase(name)
    }
  }

  private static func validate(_ configuration: HarnessRenderBenchmarkConfiguration) throws {
    guard configuration.schemaVersion == 1 else {
      throw HarnessRenderBenchmarkError.invalidConfiguration("unsupported schema")
    }
    guard (0...10).contains(configuration.warmupIterations) else {
      throw HarnessRenderBenchmarkError.invalidConfiguration("warmup iterations must be 0...10")
    }
    guard (1...30).contains(configuration.measuredIterations) else {
      throw HarnessRenderBenchmarkError.invalidConfiguration("measured iterations must be 1...30")
    }
    guard (0...10_000).contains(configuration.cooldownMilliseconds) else {
      throw HarnessRenderBenchmarkError.invalidConfiguration("cooldown must be 0...10000 ms")
    }
    guard configuration.scale.isFinite, configuration.scale >= 0.05, configuration.scale <= 10
    else {
      throw HarnessRenderBenchmarkError.invalidConfiguration("scale must be 0.05...10")
    }
    guard !configuration.cases.isEmpty,
      configuration.cases.count == Set(configuration.cases).count
    else {
      throw HarnessRenderBenchmarkError.invalidConfiguration("cases must be nonempty and unique")
    }
    let vector = doomFirePayloads(frames: 3, rows: 4, columns: 8, seed: 42)
    guard vector.map(\.count) == [795, 813, 840],
      fnv1a64(vector.reduce(into: Data()) { $0.append($1) }) == 0xbcd2_e921_162c_7b96
    else {
      throw HarnessRenderBenchmarkError.invalidConfiguration(
        "DOOM fire generator differs from the shared desktop vector"
      )
    }
  }

  private static func makePayloads(for name: String, operations: Int) -> [Data] {
    switch name {
    case "cursor-1":
      return (0..<operations).map { index in
        Data("\u{1b}[\((index % Int(rows)) + 1);\((index * 7 % Int(columns)) + 1)H".utf8)
      }
    case "typing-1":
      return (0..<operations).map { index in
        Data(String(UnicodeScalar(97 + index % 26)!).utf8)
      }
    case "sparse-1":
      return (0..<operations).map { index in
        Data("\r\u{1b}[3\(index % 8)mstatus-\(fixed(index, width: 5))\u{1b}[0m\u{1b}[K".utf8)
      }
    case "scroll-1", "scroll-4", "scroll-8":
      return (0..<operations).map { index in
        var output = ""
        for row in 0..<4 {
          output += deterministicASCII(seed: index * 4 + row, count: 96) + "\r\n"
        }
        return Data(output.utf8)
      }
    case "dense-1":
      return (0..<operations).map { index in
        var output = "\u{1b}[H"
        for row in 0..<Int(rows) {
          output += "\u{1b}[3\((row + index) % 8)m"
          output += deterministicASCII(seed: index * Int(rows) + row, count: 98)
          output += "\u{1b}[0m"
          if row + 1 < Int(rows) { output += "\r\n" }
        }
        return Data(output.utf8)
      }
    case "truecolor-1":
      return (0..<operations).map { frame in
        var output = "\u{1b}[H"
        for row in 0..<Int(rows) {
          for column in 0..<25 {
            let red = (frame * 7 + row * 11 + column * 13) & 255
            let green = (frame * 5 + row * 17 + column * 3) & 255
            let blue = (frame * 19 + row * 2 + column * 9) & 255
            output += "\u{1b}[48;2;\(red);\(green);\(blue)m    "
          }
          output += "\u{1b}[0m"
          if row + 1 < Int(rows) { output += "\r\n" }
        }
        return Data(output.utf8)
      }
    case "doom-fire-1":
      return doomFirePayloads(
        frames: operations,
        rows: Int(rows) - 1,
        columns: Int(columns),
        seed: 0x0d00_f1ee
      )
    case "unicode-1":
      let fragments = ["e\u{301}", "界", "🙂", "λ", "क", "مرحبا", "─│┌┐└┘"]
      return (0..<operations).map { frame in
        var output = "\u{1b}[H"
        for row in 0..<Int(rows) {
          let fragment = fragments[(frame + row) % fragments.count]
          output += String(repeating: "\(fragment) ", count: 12)
          output += fixed(frame * Int(rows) + row, width: 6)
          output += "\u{1b}[K"
          if row + 1 < Int(rows) { output += "\r\n" }
        }
        return Data(output.utf8)
      }
    default:
      return Array(repeating: Data(), count: operations)
    }
  }

  private static func makeInitialPayload() -> Data {
    var output = "\u{1b}[2J\u{1b}[H"
    for row in 0..<Int(rows) {
      output += "initial-\(fixed(row, width: 2)) "
      output += deterministicASCII(seed: row, count: 80)
      if row + 1 < Int(rows) { output += "\r\n" }
    }
    return Data(output.utf8)
  }

  private static func deterministicASCII(seed: Int, count: Int) -> String {
    var state = UInt64(seed + 1) &* 0x9E37_79B9_7F4A_7C15
    var bytes: [UInt8] = []
    bytes.reserveCapacity(count)
    for _ in 0..<count {
      state ^= state >> 12
      state ^= state << 25
      state ^= state >> 27
      bytes.append(UInt8(33 + state % 94))
    }
    return String(decoding: bytes, as: UTF8.self)
  }

  private static func fixed(_ value: Int, width: Int) -> String {
    let raw = String(value)
    return String(repeating: "0", count: max(0, width - raw.count)) + raw
  }

  /// Exact Swift port of `bench/lib/payloads.mjs::doomFirePayload`. The iOS
  /// case uses the same seed and simulation, adapted to its 100x30 benchmark
  /// terminal (29 packed fire rows plus one row of headroom).
  private static func doomFirePayloads(
    frames: Int,
    rows: Int,
    columns: Int,
    seed: UInt32
  ) -> [Data] {
    let levels = 32
    let pixelRows = rows * 2
    var pixels = [UInt8](repeating: 0, count: pixelRows * columns)
    pixels.replaceSubrange(
      (pixelRows - 1) * columns..<pixelRows * columns,
      with: repeatElement(UInt8(levels - 1), count: columns)
    )
    var random = HarnessDoomFireRandom(state: seed)
    let paletteStops = [
      (0.0, 0.0, 0.0),
      (176.0, 0.0, 0.0),
      (255.0, 80.0, 0.0),
      (255.0, 224.0, 0.0),
      (255.0, 255.0, 255.0),
    ]
    let palette: [(Int, Int, Int)] = (0..<levels).map { level in
      let position = Double(level) / Double(levels - 1) * Double(paletteStops.count - 1)
      let lower = min(paletteStops.count - 2, Int(floor(position)))
      let fraction = position - Double(lower)
      let start = paletteStops[lower]
      let end = paletteStops[lower + 1]
      return (
        Int((start.0 + (end.0 - start.0) * fraction).rounded()),
        Int((start.1 + (end.1 - start.1) * fraction).rounded()),
        Int((start.2 + (end.2 - start.2) * fraction).rounded())
      )
    }

    func color(_ prefix: Int, _ value: (Int, Int, Int)) -> String {
      "\u{1b}[\(prefix);2;\(value.0);\(value.1);\(value.2)m"
    }
    let foreground = palette.map { color(38, $0) }
    let background = palette.map { color(48, $0) }
    func spread() {
      for y in 1..<pixelRows {
        for x in 0..<columns {
          let source = pixels[y * columns + x]
          let drift = Int(random.next() & 3)
          let destinationX = (x + 1 - drift + columns) % columns
          pixels[(y - 1) * columns + destinationX] = source &- min(source, UInt8(drift & 1))
        }
      }
    }
    for _ in 0..<pixelRows { spread() }

    var encoded: [Data] = []
    encoded.reserveCapacity(frames)
    var previousForeground = -1
    var previousBackground = -1
    for frame in 0..<frames {
      spread()
      var output = frame == 0 ? "\u{1b}[2J\u{1b}[?25l\u{1b}[0m" : ""
      output += "\u{1b}[H"
      for row in 0..<rows {
        let upper = row * 2 * columns
        let lower = upper + columns
        for column in 0..<columns {
          let foregroundLevel = Int(pixels[upper + column])
          let backgroundLevel = Int(pixels[lower + column])
          if backgroundLevel != previousBackground { output += background[backgroundLevel] }
          if foregroundLevel != previousForeground { output += foreground[foregroundLevel] }
          output += "▀"
          previousForeground = foregroundLevel
          previousBackground = backgroundLevel
        }
        if row + 1 < rows { output += "\r\n" }
      }
      if frame + 1 == frames { output += "\u{1b}[0m\u{1b}[?25h" }
      encoded.append(Data(output.utf8))
    }
    return encoded
  }

  private static func makeTruffleDoomPayloads(
    frames: Int
  ) throws -> [HarnessTruffleDoomPayload] {
    let fireRows = Int(rows) - 1
    let fireColumns = Int(columns)
    let levels = 32
    let pixelRows = fireRows * 2
    var pixels = [UInt8](repeating: 0, count: pixelRows * fireColumns)
    pixels.replaceSubrange(
      (pixelRows - 1) * fireColumns..<pixelRows * fireColumns,
      with: repeatElement(UInt8(levels - 1), count: fireColumns)
    )
    var random = HarnessDoomFireRandom(state: 0x0d00_f1ee)
    let paletteStops = [
      (0.0, 0.0, 0.0),
      (176.0, 0.0, 0.0),
      (255.0, 80.0, 0.0),
      (255.0, 224.0, 0.0),
      (255.0, 255.0, 255.0),
    ]
    let palette: [[UInt8]] = (0..<levels).map { level in
      let position = Double(level) / Double(levels - 1) * Double(paletteStops.count - 1)
      let lower = min(paletteStops.count - 2, Int(floor(position)))
      let fraction = position - Double(lower)
      let start = paletteStops[lower]
      let end = paletteStops[lower + 1]
      return [
        UInt8((start.0 + (end.0 - start.0) * fraction).rounded()),
        UInt8((start.1 + (end.1 - start.1) * fraction).rounded()),
        UInt8((start.2 + (end.2 - start.2) * fraction).rounded()),
      ]
    }
    func spread() {
      for y in 1..<pixelRows {
        for x in 0..<fireColumns {
          let source = pixels[y * fireColumns + x]
          let drift = Int(random.next() & 3)
          let destinationX = (x + 1 - drift + fireColumns) % fireColumns
          pixels[(y - 1) * fireColumns + destinationX] =
            source &- min(source, UInt8(drift & 1))
        }
      }
    }
    for _ in 0..<pixelRows { spread() }

    let encoder = JSONEncoder()
    var payloads: [HarnessTruffleDoomPayload] = []
    payloads.reserveCapacity(frames)
    for frameIndex in 0..<frames {
      spread()
      let logicalRows = (0..<fireRows).map { rowIndex in
        let upper = rowIndex * 2 * fireColumns
        let lower = upper + fireColumns
        let cells = (0..<fireColumns).map { columnIndex in
          GhostteaLogicalCell(
            column: UInt16(columnIndex),
            span: 1,
            text: "▀",
            style: GhostteaLogicalCellStyle(
              bold: false,
              italic: false,
              faint: false,
              inverse: false,
              invisible: false,
              strikethrough: false,
              underline: false,
              foreground: palette[Int(pixels[upper + columnIndex])],
              background: palette[Int(pixels[lower + columnIndex])]
            )
          )
        }
        return GhostteaLogicalRow(text: String(repeating: "▀", count: fireColumns), cells: cells)
      }
      let revision = UInt64(frameIndex + 1)
      let message: GhostteaTerminalStateMessage
      if frameIndex == 0 {
        message = .snapshot(
          GhostteaLogicalSnapshot(
            sessionEpoch: 1,
            layoutEpoch: 1,
            terminalRevision: revision,
            cols: columns,
            rows: logicalRows,
            cursor: GhostteaLogicalCursor(
              x: 0, y: UInt16(fireRows - 1), visible: false, style: 0, blinking: false),
            mouseTracking: false,
            scrollbar: GhostteaLogicalScrollbar(
              total: UInt64(fireRows), offset: 0, len: UInt64(fireRows)),
            title: "DOOM Fire",
            cwd: nil
          )
        )
      } else {
        message = .patch(
          GhostteaLogicalPatch(
            sessionEpoch: 1,
            layoutEpoch: 1,
            patchSequence: UInt64(frameIndex),
            terminalRevision: revision,
            rowReplacements: logicalRows.enumerated().map { rowIndex, row in
              GhostteaRowReplacement(
                rowIndex: UInt16(rowIndex), rowRevision: revision, row: row)
            },
            cursor: nil,
            mouseTracking: nil,
            scrollbar: nil
          )
        )
      }
      payloads.append(
        HarnessTruffleDoomPayload(
          json: try encoder.encode(message),
          compact: try JSONSerialization.data(withJSONObject: compactStateObject(message))
        )
      )
    }
    return payloads
  }

  private static func compactStateObject(_ message: GhostteaTerminalStateMessage) -> [String: Any] {
    switch message {
    case .snapshot(let snapshot):
      return [
        "s": [
          snapshot.sessionEpoch,
          snapshot.layoutEpoch,
          snapshot.terminalRevision,
          snapshot.cols,
          snapshot.rows.map(compactRow),
          compactCursor(snapshot.cursor),
          snapshot.mouseTracking,
          compactScrollbar(snapshot.scrollbar),
          snapshot.title.map { $0 as Any } ?? NSNull(),
          snapshot.cwd.map { $0 as Any } ?? NSNull(),
        ]
      ]
    case .patch(let patch):
      return [
        "p": [
          patch.sessionEpoch,
          patch.layoutEpoch,
          patch.patchSequence,
          patch.terminalRevision,
          patch.rowReplacements.map { replacement in
            [replacement.rowIndex, replacement.rowRevision, compactRow(replacement.row)]
          },
          patch.cursor.map { compactCursor($0) as Any } ?? NSNull(),
          patch.mouseTracking.map { $0 as Any } ?? NSNull(),
          patch.scrollbar.map { compactScrollbar($0) as Any } ?? NSNull(),
          0,
        ]
      ]
    case .controlChanged(let viewID, let epoch, let cols, let rows, let layout):
      return ["c": [viewID, epoch, cols, rows, layout]]
    }
  }

  private static func compactRow(_ row: GhostteaLogicalRow) -> [Any] {
    [
      row.text,
      row.cells.map { cell in
        [cell.column, cell.span, cell.text, compactStyle(cell.style)] as [Any]
      },
    ]
  }

  private static func compactStyle(_ style: GhostteaLogicalCellStyle) -> [Any] {
    var flags: UInt8 = 0
    if style.bold { flags |= 1 }
    if style.italic { flags |= 2 }
    if style.faint { flags |= 4 }
    if style.inverse { flags |= 8 }
    if style.invisible { flags |= 16 }
    if style.strikethrough { flags |= 32 }
    if style.underline { flags |= 64 }
    return [flags, style.foreground ?? NSNull(), style.background ?? NSNull()]
  }

  private static func compactCursor(_ cursor: GhostteaLogicalCursor) -> [Any] {
    [cursor.x, cursor.y, cursor.visible, cursor.style, cursor.blinking]
  }

  private static func compactScrollbar(_ scrollbar: GhostteaLogicalScrollbar) -> [UInt64] {
    [scrollbar.total, scrollbar.offset, scrollbar.len]
  }

  private static func fnv1a64(_ data: Data) -> UInt64 {
    data.reduce(UInt64(0xcbf2_9ce4_8422_2325)) { hash, byte in
      (hash ^ UInt64(byte)) &* 0x0000_0100_0000_01b3
    }
  }

  private static func layout(
    surfaces: [GhostteaTerminalMetalView],
    in bounds: CGRect,
    jitter: CGFloat = 0
  ) {
    let columns = surfaces.count == 1 ? 1 : 2
    let rows = Int(ceil(Double(surfaces.count) / Double(columns)))
    let width = bounds.width / CGFloat(columns)
    let height = bounds.height / CGFloat(rows)
    for (index, surface) in surfaces.enumerated() {
      let column = index % columns
      let row = index / columns
      surface.frame = CGRect(
        x: CGFloat(column) * width,
        y: CGFloat(row) * height,
        width: max(1, width - jitter),
        height: max(1, height)
      )
    }
  }

  private static func aggregateDiagnostics(
    _ surfaces: [GhostteaTerminalMetalView]
  ) -> HarnessRenderBenchmarkCounters {
    HarnessRenderBenchmarkCounters(
      acceptedFrames: surfaces.reduce(0) { $0 + $1.diagnostics.acceptedFrames },
      renderedFrames: surfaces.reduce(0) { $0 + $1.diagnostics.renderedFrames },
      staleFrames: surfaces.reduce(0) { $0 + $1.diagnostics.staleFrames },
      fullRefreshRequests: surfaces.reduce(0) { $0 + $1.diagnostics.fullRefreshRequests },
      vertexUploadBytes: surfaces.reduce(0) { $0 &+ $1.diagnostics.vertexUploadBytes },
      atlasUploadBytes: surfaces.reduce(0) { $0 &+ $1.diagnostics.atlasUploadBytes },
      bufferAllocations: surfaces.reduce(0) { $0 &+ $1.diagnostics.bufferAllocations },
      drawCalls: surfaces.reduce(0) { $0 &+ $1.diagnostics.drawCalls },
      commandBufferCommits: surfaces.reduce(0) { $0 &+ $1.diagnostics.commandBufferCommits },
      fullDamageSubmissions: surfaces.reduce(0) { $0 + $1.diagnostics.fullDamageSubmissions },
      rowDamageSubmissions: surfaces.reduce(0) { $0 + $1.diagnostics.rowDamageSubmissions },
      damagedRowsSubmitted: surfaces.reduce(0) { $0 + $1.diagnostics.damagedRowsSubmitted },
      cursorDamageSubmissions: surfaces.reduce(0) { $0 + $1.diagnostics.cursorDamageSubmissions },
      selectionDamageSubmissions: surfaces.reduce(0) {
        $0 + $1.diagnostics.selectionDamageSubmissions
      },
      geometryDamageSubmissions: surfaces.reduce(0) {
        $0 + $1.diagnostics.geometryDamageSubmissions
      },
      rowCacheHits: surfaces.reduce(0) { $0 + $1.diagnostics.rowCacheHits },
      rowCacheAdmissions: surfaces.reduce(0) { $0 + $1.diagnostics.rowCacheAdmissions },
      rowCacheEvictions: surfaces.reduce(0) { $0 + $1.diagnostics.rowCacheEvictions },
      residentAtlasBytes: surfaces.reduce(0) {
        $0 &+ UInt64(max(0, $1.diagnostics.residentAtlasBytes))
      },
      residentGlyphBytes: surfaces.reduce(0) {
        $0 &+ UInt64(max(0, $1.diagnostics.residentGlyphBytes))
      }
    )
  }

  private static func diagnosticDelta(
    from before: HarnessRenderBenchmarkCounters,
    to after: HarnessRenderBenchmarkCounters
  ) -> HarnessRenderBenchmarkCounters {
    HarnessRenderBenchmarkCounters(
      acceptedFrames: max(0, after.acceptedFrames - before.acceptedFrames),
      renderedFrames: max(0, after.renderedFrames - before.renderedFrames),
      staleFrames: max(0, after.staleFrames - before.staleFrames),
      fullRefreshRequests: max(0, after.fullRefreshRequests - before.fullRefreshRequests),
      vertexUploadBytes: after.vertexUploadBytes &- before.vertexUploadBytes,
      atlasUploadBytes: after.atlasUploadBytes &- before.atlasUploadBytes,
      bufferAllocations: after.bufferAllocations &- before.bufferAllocations,
      drawCalls: after.drawCalls &- before.drawCalls,
      commandBufferCommits: after.commandBufferCommits &- before.commandBufferCommits,
      fullDamageSubmissions: max(
        0, after.fullDamageSubmissions - before.fullDamageSubmissions),
      rowDamageSubmissions: max(0, after.rowDamageSubmissions - before.rowDamageSubmissions),
      damagedRowsSubmitted: max(0, after.damagedRowsSubmitted - before.damagedRowsSubmitted),
      cursorDamageSubmissions: max(
        0, after.cursorDamageSubmissions - before.cursorDamageSubmissions),
      selectionDamageSubmissions: max(
        0, after.selectionDamageSubmissions - before.selectionDamageSubmissions),
      geometryDamageSubmissions: max(
        0, after.geometryDamageSubmissions - before.geometryDamageSubmissions),
      rowCacheHits: max(0, after.rowCacheHits - before.rowCacheHits),
      rowCacheAdmissions: max(0, after.rowCacheAdmissions - before.rowCacheAdmissions),
      rowCacheEvictions: max(0, after.rowCacheEvictions - before.rowCacheEvictions),
      residentAtlasBytes: after.residentAtlasBytes,
      residentGlyphBytes: after.residentGlyphBytes
    )
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
    throw HarnessRenderBenchmarkError.windowUnavailable
  }

  private static func cooldown(_ milliseconds: Int) async throws {
    guard milliseconds > 0 else { return }
    try await Task.sleep(for: .milliseconds(milliseconds))
  }

  private static func stablePhysicalFootprintBytes() throws -> UInt64 {
    var minimum = UInt64.max
    for sample in 0..<3 {
      minimum = min(minimum, try physicalFootprintBytes())
      if sample < 2 { usleep(20_000) }
    }
    return minimum
  }

  private static func physicalFootprintBytes() throws -> UInt64 {
    var info = task_vm_info_data_t()
    var count = mach_msg_type_number_t(
      MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<natural_t>.size
    )
    let result = withUnsafeMutablePointer(to: &info) { pointer in
      pointer.withMemoryRebound(to: integer_t.self, capacity: Int(count)) { rebound in
        task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), rebound, &count)
      }
    }
    guard result == KERN_SUCCESS else {
      throw HarnessRenderBenchmarkError.physicalFootprintFailed(result)
    }
    return UInt64(info.phys_footprint)
  }

  private static func percentile(_ sorted: [UInt64], _ value: Int) -> UInt64 {
    guard !sorted.isEmpty else { return 0 }
    let rank = max(1, (sorted.count * value + 99) / 100)
    return sorted[min(sorted.count - 1, rank - 1)]
  }

  private static func machineIdentifier() -> String {
    var system = utsname()
    uname(&system)
    return withUnsafePointer(to: &system.machine) { pointer in
      pointer.withMemoryRebound(to: CChar.self, capacity: 1) { String(cString: $0) }
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
}

private struct HarnessDoomFireRandom {
  var state: UInt32

  mutating func next() -> UInt32 {
    state ^= state << 13
    state ^= state >> 17
    state ^= state << 5
    return state
  }
}
