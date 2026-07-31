import Foundation
import GhostteaCoreNative

public enum GhostteaConfigDiagnosticSeverity: String, Codable, Sendable {
  case info
  case warning
  case error
}

public enum GhostteaConfigSupport: String, Codable, Sendable {
  case applied
  case parsed
  case unsupported
}

public enum GhostteaConfigSourceKind: String, Codable, Sendable {
  case ghosttyDefault = "ghostty-default"
  case included
  case ghostteaOverlay = "ghosttea-overlay"
}

public enum GhostteaRendererPostProcess: String, Codable, Sendable {
  case none
  case betterCRT = "better-crt"
}

public struct GhostteaConfigCompatibility: Codable, Equatable, Sendable {
  public let ghosttyVersion: String
  public let ghosttyCommit: String
  public let knownKeyCount: Int
}

public struct GhostteaConfigSource: Codable, Equatable, Sendable {
  public let path: String
  public let kind: GhostteaConfigSourceKind
}

public struct GhostteaConfigDiagnostic: Codable, Equatable, Sendable {
  public let severity: GhostteaConfigDiagnosticSeverity
  public let code: String
  public let message: String
  public let source: String?
  public let line: Int?
  public let key: String?
}

public struct GhostteaConfiguredKey: Codable, Equatable, Sendable {
  public let key: String
  public let support: GhostteaConfigSupport
  public let occurrences: Int
}

public struct GhostteaResolvedTerminalConfig: Codable, Equatable, Sendable {
  public let scrollbackBytes: UInt64
  public let foreground: [UInt8]
  public let background: [UInt8]
  public let cursor: [UInt8]

  public var colorTriples:
    (
      foreground: (UInt8, UInt8, UInt8),
      background: (UInt8, UInt8, UInt8),
      cursor: (UInt8, UInt8, UInt8)
    )?
  {
    guard foreground.count == 3, background.count == 3, cursor.count == 3 else { return nil }
    return (
      (foreground[0], foreground[1], foreground[2]),
      (background[0], background[1], background[2]),
      (cursor[0], cursor[1], cursor[2])
    )
  }
}

public struct GhostteaResolvedRendererConfig: Codable, Equatable, Sendable {
  public let foreground: [UInt8]
  public let background: [UInt8]
  public let cursor: [UInt8]
  public let selectionBackground: [UInt8]
  public let selectionForeground: [UInt8]
  public let fontSize: Float
  public let fontFamilies: [String]
  public let paddingX: [Float]
  public let paddingY: [Float]
  public let postProcess: GhostteaRendererPostProcess
  public let customShaderPaths: [String]
}

public struct GhostteaConfigKeybinding: Codable, Equatable, Sendable {
  public let trigger: String
  public let action: String
}

public struct GhostteaResolvedWorkspaceConfig: Codable, Equatable, Sendable {
  public let keybindings: [GhostteaConfigKeybinding]
  public let clearKeybindings: Bool
}

/// Versioned projection produced by the same Rust configuration engine used by
/// ghosttead and the Electron renderer.
public struct GhostteaConfigSnapshot: Codable, Equatable, Sendable {
  public let schemaVersion: UInt32
  public let revision: String
  public let compatibility: GhostteaConfigCompatibility
  public let sources: [GhostteaConfigSource]
  public let diagnostics: [GhostteaConfigDiagnostic]
  public let configuredKeys: [GhostteaConfiguredKey]
  public let terminal: GhostteaResolvedTerminalConfig
  public let renderer: GhostteaResolvedRendererConfig
  public let workspace: GhostteaResolvedWorkspaceConfig

  public var hasErrors: Bool {
    diagnostics.contains { $0.severity == .error }
  }
}

public enum GhostteaConfiguration {
  /// Loads Ghostty's standard files and then an optional app-owned overlay.
  /// Set `loadGhosttyFiles` false for sandboxed documents or deterministic
  /// tests that should read only the supplied URL.
  public static func load(
    overlayURL: URL? = nil,
    loadGhosttyFiles: Bool = true
  ) throws -> GhostteaConfigSnapshot {
    let path = overlayURL?.path ?? ""
    var output = ghosttea_owned_bytes_t(data: nil, len: 0, capacity: 0)
    let status = withUTF8(path) { pathView in
      ghosttea_config_load_json(pathView, loadGhosttyFiles, &output)
    }
    try check(status)
    defer { ghosttea_owned_bytes_free(output) }
    let data = output.data.map { Data(bytes: $0, count: output.len) } ?? Data()
    return try JSONDecoder().decode(GhostteaConfigSnapshot.self, from: data)
  }
}

extension GhostteaTerminalConfiguration {
  /// Builds a terminal using the resolved Ghostty scrollback limit.
  public init(
    sessionHandle: UInt64,
    config: GhostteaConfigSnapshot,
    sessionEpoch: UInt64 = 1,
    layoutEpoch: UInt64 = 1,
    columns: UInt16 = 80,
    rows: UInt16 = 24
  ) {
    self.init(
      sessionHandle: sessionHandle,
      sessionEpoch: sessionEpoch,
      layoutEpoch: layoutEpoch,
      scrollbackBytes: config.terminal.scrollbackBytes,
      columns: columns,
      rows: rows
    )
  }
}

extension GhostteaTerminal {
  /// Applies the config colors to the terminal model so subsequently emitted
  /// TRF1 style definitions match desktop behavior.
  public func apply(
    config: GhostteaConfigSnapshot,
    render: GhostteaRenderRequest = .full
  ) throws -> GhostteaUpdate {
    guard let colors = config.terminal.colorTriples else {
      throw GhostteaCoreError.malformedUpdate(
        "configuration colors must each contain exactly three components")
    }
    return try setColors(
      foreground: colors.foreground,
      background: colors.background,
      cursor: colors.cursor,
      render: render
    )
  }
}
