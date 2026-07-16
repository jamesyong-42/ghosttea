import Foundation

public struct ReplayTransport: TerminalTransport {
  private let bytes: Data
  private let exitStatus: TerminalExitStatus

  public init(bytes: Data, exitStatus: TerminalExitStatus = .exited(code: 0)) {
    self.bytes = bytes
    self.exitStatus = exitStatus
  }

  public func connect() async throws -> any TerminalConnection {
    makeConnection()
  }

  public func makeConnection() -> ReplayTerminalConnection {
    ReplayTerminalConnection(bytes: bytes, exitStatus: exitStatus)
  }
}

public struct ReplayConnectionSnapshot: Equatable, Sendable {
  public let readCalls: Int
  public let deliveredBytes: Int
  public let writes: [Data]
  public let resizes: [TerminalSize]
  public let interruptCount: Int
  public let didFinishInput: Bool
  public let didObserveExit: Bool
  public let isConnected: Bool
}

public actor ReplayTerminalConnection: TerminalConnection {
  private let bytes: Data
  private let exitStatus: TerminalExitStatus
  private var readOffset = 0
  private var readCalls = 0
  private var writes: [Data] = []
  private var resizes: [TerminalSize] = []
  private var interruptCount = 0
  private var didFinishInput = false
  private var didObserveExit = false
  private var isConnected = true

  init(bytes: Data, exitStatus: TerminalExitStatus) {
    self.bytes = bytes
    self.exitStatus = exitStatus
  }

  public func read(maxBytes: Int) throws -> Data? {
    guard maxBytes > 0 else {
      throw TerminalTransportError.invalidReadSize(maxBytes)
    }
    guard isConnected else {
      throw TerminalTransportError.disconnected
    }
    readCalls += 1
    guard readOffset < bytes.count else { return nil }
    let end = min(readOffset + maxBytes, bytes.count)
    defer { readOffset = end }
    return bytes.subdata(in: readOffset..<end)
  }

  public func write(_ bytes: Data) throws {
    guard isConnected else {
      throw TerminalTransportError.disconnected
    }
    writes.append(bytes)
  }

  public func finishInput() throws {
    guard isConnected else {
      throw TerminalTransportError.disconnected
    }
    didFinishInput = true
  }

  public func resize(columns: Int, rows: Int) throws {
    guard isConnected else {
      throw TerminalTransportError.disconnected
    }
    resizes.append(try TerminalSize(columns: columns, rows: rows))
  }

  public func interrupt() throws {
    guard isConnected else {
      throw TerminalTransportError.disconnected
    }
    interruptCount += 1
  }

  public func waitForExit() throws -> TerminalExitStatus {
    guard isConnected else {
      throw TerminalTransportError.disconnected
    }
    didObserveExit = true
    return exitStatus
  }

  public func disconnect() {
    isConnected = false
  }

  public func snapshot() -> ReplayConnectionSnapshot {
    ReplayConnectionSnapshot(
      readCalls: readCalls,
      deliveredBytes: readOffset,
      writes: writes,
      resizes: resizes,
      interruptCount: interruptCount,
      didFinishInput: didFinishInput,
      didObserveExit: didObserveExit,
      isConnected: isConnected
    )
  }
}
