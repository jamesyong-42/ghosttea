import Foundation

/// Audited diagnostic events. Associated strings are intentionally forbidden:
/// errors, hosts, usernames, paths, commands, and terminal content must never
/// enter the persisted support record.
public enum GhostteaDiagnosticCode: String, CaseIterable, Codable, Sendable {
  case applicationLaunched
  case applicationBecameActive
  case applicationEnteredBackground
  case applicationTerminationRecorded
  case previousTerminationUnrecorded
  case diagnosticStoreRecovered
  case rendererStartFailed
  case truffleStartFailed
  case truffleRefreshFailed
  case truffleSessionListFailed
  case truffleAttachFailed
  case truffleStreamFailed
  case truffleSelectionFailed
  case truffleInputFailed
  case sshRepositoryLoadFailed
  case sshConnectFailed
  case sshTabCreateFailed
  case sshSplitFailed
  case sshWorkspaceUpdateFailed
  case sshProfileSaveFailed
  case sshProfileDeleteFailed
  case sshSessionOperationFailed
  case terminalMemoryCompressionFailed
}

public enum GhostteaDiagnosticSeverity: String, Codable, Sendable {
  case info
  case warning
  case error
}

public struct GhostteaDiagnosticEvent: Codable, Equatable, Sendable {
  public let sequence: UInt64
  public let timestamp: Date
  public let code: GhostteaDiagnosticCode
  public let severity: GhostteaDiagnosticSeverity
}

public struct GhostteaDiagnosticSnapshot: Codable, Equatable, Sendable {
  public let schemaVersion: Int
  public let launchActive: Bool
  public let events: [GhostteaDiagnosticEvent]
}

public struct GhostteaDiagnosticLimits: Equatable, Sendable {
  public let maximumEvents: Int
  public let maximumBytes: Int

  public init(maximumEvents: Int = 128, maximumBytes: Int = 64 * 1024) {
    precondition(maximumEvents > 0)
    precondition(maximumBytes >= 512)
    self.maximumEvents = maximumEvents
    self.maximumBytes = maximumBytes
  }
}

public enum GhostteaDiagnosticError: Error, Equatable, Sendable {
  case applicationSupportUnavailable
  case snapshotExceedsByteLimit
}

/// A small, durable event recorder designed to remain useful after abrupt
/// process termination without installing unsafe signal or exception hooks.
/// Every mutation atomically replaces and synchronizes the previous snapshot.
public actor GhostteaDiagnosticRecorder {
  public let fileURL: URL

  private let limits: GhostteaDiagnosticLimits
  private var loaded = false
  private var launchStarted = false
  private var nextSequence: UInt64 = 1
  private var launchActive = false
  private var events: [GhostteaDiagnosticEvent] = []

  public init(
    fileURL: URL,
    limits: GhostteaDiagnosticLimits = .init()
  ) {
    self.fileURL = fileURL
    self.limits = limits
  }

  public static func applicationSupport(
    directoryName: String = "Ghosttea",
    diagnosticsDirectoryName: String = "Diagnostics",
    fileName: String = "redacted-diagnostics.json",
    limits: GhostteaDiagnosticLimits = .init()
  ) throws -> GhostteaDiagnosticRecorder {
    guard
      let root = FileManager.default.urls(
        for: .applicationSupportDirectory,
        in: .userDomainMask
      ).first
    else {
      throw GhostteaDiagnosticError.applicationSupportUnavailable
    }
    return GhostteaDiagnosticRecorder(
      fileURL:
        root
        .appendingPathComponent(directoryName, isDirectory: true)
        .appendingPathComponent(diagnosticsDirectoryName, isDirectory: true)
        .appendingPathComponent(fileName, isDirectory: false),
      limits: limits
    )
  }

  /// Starts one launch record. If the previous process did not reach the
  /// termination notification, the record says only that termination was not
  /// observed; it does not mislabel a force-quit or jetsam event as a crash.
  public func beginLaunch(at timestamp: Date = Date()) throws {
    guard try beginLaunchIfNeeded(at: timestamp) else { return }
    try persist()
  }

  public func record(
    _ code: GhostteaDiagnosticCode,
    severity: GhostteaDiagnosticSeverity,
    at timestamp: Date = Date()
  ) throws {
    _ = try beginLaunchIfNeeded(at: timestamp)
    append(code, severity: severity, at: timestamp)
    try persist()
  }

  public func markTerminationRecorded(at timestamp: Date = Date()) throws {
    _ = try beginLaunchIfNeeded(at: timestamp)
    guard launchActive else { return }
    launchActive = false
    append(.applicationTerminationRecorded, severity: .info, at: timestamp)
    try persist()
  }

  public func snapshot() throws -> GhostteaDiagnosticSnapshot {
    try loadIfNeeded(at: Date())
    return currentSnapshot
  }

  public func exportData() throws -> Data {
    try loadIfNeeded(at: Date())
    return try encoder.encode(currentSnapshot)
  }

  private var currentSnapshot: GhostteaDiagnosticSnapshot {
    GhostteaDiagnosticSnapshot(
      schemaVersion: 1,
      launchActive: launchActive,
      events: events
    )
  }

  private func loadIfNeeded(at timestamp: Date) throws {
    guard !loaded else { return }
    loaded = true
    guard FileManager.default.fileExists(atPath: fileURL.path) else { return }
    do {
      let decoded = try decoder.decode(
        GhostteaDiagnosticSnapshot.self,
        from: Data(contentsOf: fileURL)
      )
      guard decoded.schemaVersion == 1 else { throw CocoaError(.coderReadCorrupt) }
      launchActive = decoded.launchActive
      events = Array(decoded.events.suffix(limits.maximumEvents))
      let previousSequence = events.last?.sequence ?? 0
      nextSequence = previousSequence == UInt64.max ? 1 : previousSequence + 1
      try enforceByteLimit()
    } catch {
      launchActive = false
      events = []
      nextSequence = 1
      append(.diagnosticStoreRecovered, severity: .warning, at: timestamp)
      try persist()
    }
  }

  private func append(
    _ code: GhostteaDiagnosticCode,
    severity: GhostteaDiagnosticSeverity,
    at timestamp: Date
  ) {
    events.append(
      GhostteaDiagnosticEvent(
        sequence: nextSequence,
        timestamp: timestamp,
        code: code,
        severity: severity
      ))
    nextSequence = nextSequence == UInt64.max ? 1 : nextSequence + 1
    if events.count > limits.maximumEvents {
      events.removeFirst(events.count - limits.maximumEvents)
    }
  }

  private func persist() throws {
    try enforceByteLimit()
    let data = try encoder.encode(currentSnapshot)
    let directory = fileURL.deletingLastPathComponent()
    try FileManager.default.createDirectory(
      at: directory,
      withIntermediateDirectories: true,
      attributes: protectionAttributes
    )
    try excludeFromBackup(directory)
    #if os(iOS)
      try FileManager.default.setAttributes(protectionAttributes, ofItemAtPath: directory.path)
    #endif
    try data.write(to: fileURL, options: .atomic)
    #if os(iOS)
      try FileManager.default.setAttributes(protectionAttributes, ofItemAtPath: fileURL.path)
    #endif
    try excludeFromBackup(fileURL)
    let handle = try FileHandle(forWritingTo: fileURL)
    defer { try? handle.close() }
    try handle.synchronize()
  }

  @discardableResult
  private func beginLaunchIfNeeded(at timestamp: Date) throws -> Bool {
    guard !launchStarted else { return false }
    try loadIfNeeded(at: timestamp)
    launchStarted = true
    if launchActive {
      append(.previousTerminationUnrecorded, severity: .warning, at: timestamp)
    }
    launchActive = true
    append(.applicationLaunched, severity: .info, at: timestamp)
    return true
  }

  private func enforceByteLimit() throws {
    while try encoder.encode(currentSnapshot).count > limits.maximumBytes {
      guard !events.isEmpty else {
        throw GhostteaDiagnosticError.snapshotExceedsByteLimit
      }
      events.removeFirst()
    }
  }

  private var encoder: JSONEncoder {
    let value = JSONEncoder()
    value.dateEncodingStrategy = .millisecondsSince1970
    value.outputFormatting = [.prettyPrinted, .sortedKeys]
    return value
  }

  private var decoder: JSONDecoder {
    let value = JSONDecoder()
    value.dateDecodingStrategy = .millisecondsSince1970
    return value
  }
}

private var protectionAttributes: [FileAttributeKey: Any] {
  #if os(iOS)
    [.protectionKey: FileProtectionType.complete]
  #else
    [:]
  #endif
}

private func excludeFromBackup(_ url: URL) throws {
  var values = URLResourceValues()
  values.isExcludedFromBackup = true
  var mutableURL = url
  try mutableURL.setResourceValues(values)
}
