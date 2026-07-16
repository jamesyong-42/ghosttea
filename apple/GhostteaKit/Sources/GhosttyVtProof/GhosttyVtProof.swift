public struct GhosttyVtProofSnapshot: Equatable, Sendable {
  public let columns: UInt16
  public let rows: UInt16
  public let cursorColumn: UInt16
  public let cursorRow: UInt16
  public let encodedKey: [UInt8]

  public init(
    columns: UInt16,
    rows: UInt16,
    cursorColumn: UInt16,
    cursorRow: UInt16,
    encodedKey: [UInt8]
  ) {
    self.columns = columns
    self.rows = rows
    self.cursorColumn = cursorColumn
    self.cursorRow = cursorRow
    self.encodedKey = encodedKey
  }
}

public enum GhosttyVtProofError: Error, Equatable {
  case operationFailed(String)
}

/// A deliberately small integration seam that proves Swift can create, feed,
/// resize, inspect, and encode input against the pinned Ghostty VT artifact.
/// It is a Phase 0 proof, not the stable GhostteaCoreFFI API.
public enum GhosttyVtProof {
  public static func run() throws -> GhosttyVtProofSnapshot {
    let session = try GhosttyVtProofSession(
      columns: 80,
      rows: 24,
      maxScrollbackBytes: 1_000_000
    )
    session.feed(Array("hello".utf8))
    try session.resize(columns: 100, rows: 30)
    let state = try session.state()

    return GhosttyVtProofSnapshot(
      columns: state.columns,
      rows: state.rows,
      cursorColumn: state.cursorColumn,
      cursorRow: state.cursorRow,
      encodedKey: try session.encodeKeyA()
    )
  }
}
