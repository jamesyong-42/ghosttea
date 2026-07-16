import Foundation

public protocol TerminalTransport: Sendable {
  func connect() async throws -> any TerminalConnection
}

public protocol TerminalConnection: Sendable {
  /// Returns at most `maxBytes`, or `nil` after clean EOF.
  /// Implementations must propagate demand to their transport flow control.
  func read(maxBytes: Int) async throws -> Data?
  func write(_ bytes: Data) async throws
  /// Sends protocol EOF for the input stream while keeping output readable.
  func finishInput() async throws
  func resize(columns: Int, rows: Int) async throws
  func interrupt() async throws
  /// Waits for clean remote termination after output has been drained.
  func waitForExit() async throws -> TerminalExitStatus
  func disconnect() async
}

public enum TerminalTransportError: Error, Equatable, Sendable {
  case invalidReadSize(Int)
  case invalidTerminalSize(columns: Int, rows: Int)
  case disconnected
  case outboundBackpressure(maxItems: Int, maxBytes: Int)
  case writerAlreadyDraining
}

public enum TerminalExitStatus: Equatable, Sendable {
  case exited(code: Int32)
  /// SSH signal names omit the leading `SIG`, for example `TERM`.
  case signaled(name: String)
}

public struct TerminalSize: Equatable, Sendable {
  public let columns: Int
  public let rows: Int

  public init(columns: Int, rows: Int) throws {
    guard columns > 0, rows > 0 else {
      throw TerminalTransportError.invalidTerminalSize(columns: columns, rows: rows)
    }
    self.columns = columns
    self.rows = rows
  }
}
