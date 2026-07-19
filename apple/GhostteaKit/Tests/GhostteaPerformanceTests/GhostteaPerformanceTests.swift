import Foundation
import GhostteaPerformance
import Testing

@Test("Recorder is disabled by default and never retains unrequested work")
func disabledByDefault() throws {
  let recorder = GhostteaPerformanceRecorder(maximumSamplesPerMetric: 4)
  let value = recorder.measure(.nativeFeed, byteCount: 17) { 42 }

  #expect(value == 42)
  #expect(recorder.snapshot().summaries.isEmpty)
}

@Test("Recorder bounds samples and exports numeric summaries")
func boundedNumericSummary() throws {
  let recorder = GhostteaPerformanceRecorder(maximumSamplesPerMetric: 2)
  recorder.setEnabled(true)

  for bytes in 1...3 {
    recorder.measure(.frameDecode, byteCount: bytes) {}
  }

  let snapshot = recorder.snapshot()
  let summary = try #require(snapshot.summaries.first)
  #expect(snapshot.schemaVersion == 1)
  #expect(summary.metric == .frameDecode)
  #expect(summary.sampleCount == 2)
  #expect(summary.droppedSampleCount == 1)
  #expect(summary.byteCount == 5)
  #expect(summary.p50Nanoseconds <= summary.p99Nanoseconds)
  #expect(summary.p99Nanoseconds <= summary.maximumNanoseconds)

  let encoded = try JSONEncoder().encode(snapshot)
  let object = try #require(JSONSerialization.jsonObject(with: encoded) as? [String: Any])
  #expect(Set(object.keys) == ["schemaVersion", "summaries"])
}

@Test("Async measurements are recorded across suspension")
func asyncMeasurement() async throws {
  let recorder = GhostteaPerformanceRecorder(maximumSamplesPerMetric: 4)
  recorder.setEnabled(true)

  let value = await recorder.measure(.inputToTransportWrite, byteCount: 8) {
    await Task.yield()
    return 7
  }

  #expect(value == 7)
  #expect(recorder.snapshot().summaries.first?.sampleCount == 1)
}
