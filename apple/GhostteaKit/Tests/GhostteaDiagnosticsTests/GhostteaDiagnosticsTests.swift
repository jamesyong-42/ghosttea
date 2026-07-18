import Foundation
import GhostteaDiagnostics
import Testing

@Test("Diagnostic records are bounded and contain only audited fields")
func boundedRecord() async throws {
  let fixture = try Fixture()
  let recorder = GhostteaDiagnosticRecorder(
    fileURL: fixture.file,
    limits: GhostteaDiagnosticLimits(maximumEvents: 3, maximumBytes: 1_024)
  )

  try await recorder.beginLaunch(at: Date(timeIntervalSince1970: 1))
  try await recorder.record(
    .truffleStartFailed, severity: .error, at: Date(timeIntervalSince1970: 2))
  try await recorder.record(.sshConnectFailed, severity: .error, at: Date(timeIntervalSince1970: 3))
  try await recorder.record(
    .rendererStartFailed, severity: .error, at: Date(timeIntervalSince1970: 4))

  let snapshot = try await recorder.snapshot()
  #expect(
    snapshot.events.map(\.code) == [.truffleStartFailed, .sshConnectFailed, .rendererStartFailed])
  #expect(try Data(contentsOf: fixture.file).count <= 1_024)

  let exported = try await recorder.exportData()
  let keys = try #require(JSONSerialization.jsonObject(with: exported) as? [String: Any])
  #expect(Set(keys.keys) == ["events", "launchActive", "schemaVersion"])
}

@Test("Abrupt and recorded termination remain distinguishable")
func launchTerminationState() async throws {
  let fixture = try Fixture()
  let first = GhostteaDiagnosticRecorder(fileURL: fixture.file)
  try await first.beginLaunch(at: Date(timeIntervalSince1970: 1))

  let afterAbruptTermination = GhostteaDiagnosticRecorder(fileURL: fixture.file)
  try await afterAbruptTermination.beginLaunch(at: Date(timeIntervalSince1970: 2))
  #expect(
    try await afterAbruptTermination.snapshot().events.map(\.code).contains(
      .previousTerminationUnrecorded))
  try await afterAbruptTermination.markTerminationRecorded(at: Date(timeIntervalSince1970: 3))

  let afterRecordedTermination = GhostteaDiagnosticRecorder(fileURL: fixture.file)
  try await afterRecordedTermination.beginLaunch(at: Date(timeIntervalSince1970: 4))
  let finalCodes = try await afterRecordedTermination.snapshot().events.map(\.code)
  #expect(finalCodes.filter { $0 == .previousTerminationUnrecorded }.count == 1)
}

@Test("Corrupt or secret-bearing bytes are replaced without being exported")
func corruptStoreRecovery() async throws {
  let fixture = try Fixture()
  let secret = "password=hunter2\n-----BEGIN OPENSSH PRIVATE KEY-----\nterminal output"
  try Data(secret.utf8).write(to: fixture.file)

  let recorder = GhostteaDiagnosticRecorder(fileURL: fixture.file)
  try await recorder.beginLaunch(at: Date(timeIntervalSince1970: 1))
  let exported = try await recorder.exportData()
  let text = String(decoding: exported, as: UTF8.self)

  #expect(!text.contains("hunter2"))
  #expect(!text.contains("PRIVATE KEY"))
  #expect(!text.contains("terminal output"))
  #expect(try await recorder.snapshot().events.first?.code == .diagnosticStoreRecovered)
}

private struct Fixture {
  let root: URL
  let file: URL

  init() throws {
    root = FileManager.default.temporaryDirectory
      .appendingPathComponent("ghosttea-diagnostics-\(UUID().uuidString)", isDirectory: true)
    file = root.appendingPathComponent("diagnostics.json", isDirectory: false)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
  }
}
