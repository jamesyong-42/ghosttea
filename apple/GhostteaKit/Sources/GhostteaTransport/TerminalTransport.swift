import Foundation

public protocol TerminalTransport: Sendable {
  func connect() async throws -> any TerminalConnection
}

public protocol TerminalConnection: Sendable {
  /// Returns at most `maxBytes`, or `nil` after clean EOF.
  /// Implementations must propagate demand to their transport flow control.
  func read(maxBytes: Int) async throws -> Data?
  func write(_ bytes: Data) async throws
  func resize(columns: Int, rows: Int) async throws
  func interrupt() async throws
  func disconnect() async
}

public enum TerminalTransportError: Error, Equatable, Sendable {
  case invalidReadSize(Int)
  case invalidTerminalSize(columns: Int, rows: Int)
  case disconnected
  case outboundBackpressure(maxItems: Int, maxBytes: Int)
  case writerAlreadyDraining
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
