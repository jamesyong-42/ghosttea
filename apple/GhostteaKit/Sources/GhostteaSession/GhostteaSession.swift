import Foundation
import GhostteaCore
import GhostteaTransport

public struct GhostteaSessionFailure: Equatable, Sendable {
  public let message: String
  public let reconnectable: Bool

  public init(message: String, reconnectable: Bool) {
    self.message = message
    self.reconnectable = reconnectable
  }
}

public struct GhostteaSessionSnapshot: Equatable, Sendable {
  public let reconnectState: TerminalReconnectState
  public let lastExitStatus: TerminalExitStatus?
  public let lastFailure: GhostteaSessionFailure?

  public init(
    reconnectState: TerminalReconnectState,
    lastExitStatus: TerminalExitStatus? = nil,
    lastFailure: GhostteaSessionFailure? = nil
  ) {
    self.reconnectState = reconnectState
    self.lastExitStatus = lastExitStatus
    self.lastFailure = lastFailure
  }
}

public enum GhostteaSessionEvent: Equatable, Sendable {
  case stateChanged(GhostteaSessionSnapshot)
  case frameReady(Data)
  case metadataChanged(Data)
  case bell
  case clipboardWrite(Data)
  case logicalSnapshot(Data)
}

public enum GhostteaSessionError: Error, Equatable, Sendable {
  case notConnected
  case terminalSizeOutOfRange(columns: Int, rows: Int)
}

public struct GhostteaSessionConfiguration: Sendable {
  public var inboundChunkBytes: Int
  public var outboundMaxItems: Int
  public var outboundMaxBytes: Int
  public var initialPath: TerminalNetworkPath
  public var errorIsReconnectable: @Sendable (any Error) -> Bool
  public var failureDescription: @Sendable (any Error) -> String

  public init(
    inboundChunkBytes: Int = 64 * 1024,
    outboundMaxItems: Int = 256,
    outboundMaxBytes: Int = 2 * 1024 * 1024,
    initialPath: TerminalNetworkPath = .unknown,
    errorIsReconnectable: @escaping @Sendable (any Error) -> Bool = { _ in true },
    failureDescription: @escaping @Sendable (any Error) -> String = { _ in "Connection failed" }
  ) {
    precondition(inboundChunkBytes > 0)
    precondition(outboundMaxItems > 0)
    precondition(outboundMaxBytes > 0)
    self.inboundChunkBytes = inboundChunkBytes
    self.outboundMaxItems = outboundMaxItems
    self.outboundMaxBytes = outboundMaxBytes
    self.initialPath = initialPath
    self.errorIsReconnectable = errorIsReconnectable
    self.failureDescription = failureDescription
  }
}

public typealias GhostteaConnectionFactory =
  @Sendable () async throws -> any TerminalConnection
public typealias GhostteaSessionEventHandler = @Sendable (GhostteaSessionEvent) async -> Void

/// Owns one terminal model and the lifecycle of its current transport.
///
/// Event handlers are awaited to preserve effect order and inbound flow
/// control. They must not synchronously wait for another operation on this
/// session; schedule reentrant work in a separate task instead.
public actor GhostteaSession {
  private let terminal: GhostteaTerminal
  private let connectionFactory: GhostteaConnectionFactory
  private let configuration: GhostteaSessionConfiguration
  private let eventHandler: GhostteaSessionEventHandler
  private let operationGate = GhostteaSessionOperationGate()

  private var reconnectModel: TerminalReconnectModel
  private var connection: (generation: UInt64, value: any TerminalConnection)?
  private var connectionTask: Task<Void, Never>?
  private var readTask: Task<Void, Never>?
  private var writer: OrderedTerminalWriter?
  private var outboundSequence: UInt64 = 0
  private var lastExitStatus: TerminalExitStatus?
  private var lastFailure: GhostteaSessionFailure?

  public init(
    terminal: GhostteaTerminal,
    configuration: GhostteaSessionConfiguration = .init(),
    connectionFactory: @escaping GhostteaConnectionFactory,
    eventHandler: @escaping GhostteaSessionEventHandler = { _ in }
  ) {
    self.terminal = terminal
    self.configuration = configuration
    self.connectionFactory = connectionFactory
    self.eventHandler = eventHandler
    reconnectModel = TerminalReconnectModel(initialPath: configuration.initialPath)
  }

  public init<T: TerminalTransport>(
    terminal: GhostteaTerminal,
    transport: T,
    configuration: GhostteaSessionConfiguration = .init(),
    eventHandler: @escaping GhostteaSessionEventHandler = { _ in }
  ) {
    self.init(
      terminal: terminal,
      configuration: configuration,
      connectionFactory: { try await transport.connect() },
      eventHandler: eventHandler
    )
  }

  public func snapshot() -> GhostteaSessionSnapshot {
    currentSnapshot
  }

  public func requestConnect() async {
    lastExitStatus = nil
    lastFailure = nil
    await applyReconnectEvent(.connectRequested)
  }

  public func updateNetworkPath(_ path: TerminalNetworkPath) async {
    await applyReconnectEvent(.pathChanged(path))
  }

  public func enteredBackground() async {
    await applyReconnectEvent(.enteredBackground)
  }

  public func becameActive() async {
    await applyReconnectEvent(.becameActive)
  }

  public func disconnect() async {
    await applyReconnectEvent(.disconnectRequested)
  }

  public func send(_ bytes: Data) async throws {
    guard !bytes.isEmpty else { return }
    try await withConnectedOperation { connection in
      try await write(bytes, to: connection)
    }
  }

  public func sendKey(_ event: GhostteaKeyEvent) async throws {
    try await withConnectedOperation { connection in
      try await write(try await terminal.encodeKey(event), to: connection)
    }
  }

  public func sendPaste(_ text: String) async throws {
    try await withConnectedOperation { connection in
      try await write(try await terminal.encodePaste(text), to: connection)
    }
  }

  public func sendFocus(_ focused: Bool) async throws {
    try await withConnectedOperation { connection in
      try await write(try await terminal.encodeFocus(focused), to: connection)
    }
  }

  public func sendMouse(_ event: GhostteaMouseEvent) async throws {
    try await withConnectedOperation { connection in
      try await write(try await terminal.encodeMouse(event), to: connection)
    }
  }

  public func resize(columns: Int, rows: Int, layoutEpoch: UInt64) async throws {
    guard
      let columns16 = UInt16(exactly: columns),
      let rows16 = UInt16(exactly: rows),
      columns > 0,
      rows > 0
    else {
      throw GhostteaSessionError.terminalSizeOutOfRange(columns: columns, rows: rows)
    }
    try await withConnectedOperation { connection in
      try await connection.resize(columns: columns, rows: rows)
      let update = try await terminal.resize(
        columns: columns16,
        rows: rows16,
        layoutEpoch: layoutEpoch,
        render: .full
      )
      try await execute(update, on: connection)
    }
  }

  public func refresh() async throws {
    try await withConnectedOperation { connection in
      try await execute(try await terminal.refresh(.full), on: connection)
    }
  }

  public func scroll(rows: Int64) async throws {
    try await withConnectedOperation { connection in
      try await execute(try await terminal.scroll(rows: rows, render: .damage), on: connection)
    }
  }

  private var currentSnapshot: GhostteaSessionSnapshot {
    GhostteaSessionSnapshot(
      reconnectState: reconnectModel.state,
      lastExitStatus: lastExitStatus,
      lastFailure: lastFailure
    )
  }

  private func applyReconnectEvent(_ event: TerminalReconnectEvent) async {
    let previous = currentSnapshot
    let effects = reconnectModel.update(event)
    for effect in effects {
      switch effect {
      case .startFreshConnection(let generation):
        startConnection(generation: generation)
      case .tearDownConnection(let generation):
        await tearDown(generation: generation)
      case .reconnectBecameAvailable:
        break
      }
    }
    if currentSnapshot != previous {
      await eventHandler(.stateChanged(currentSnapshot))
    }
  }

  private func startConnection(generation: UInt64) {
    connectionTask?.cancel()
    let connectionFactory = self.connectionFactory
    connectionTask = Task { [weak self] in
      do {
        let connected = try await connectionFactory()
        guard !Task.isCancelled else {
          await connected.disconnect()
          return
        }
        await self?.connectionEstablished(connected, generation: generation)
      } catch is CancellationError {
        return
      } catch {
        await self?.connectionFailed(error, generation: generation)
      }
    }
  }

  private func connectionEstablished(
    _ connected: any TerminalConnection,
    generation: UInt64
  ) async {
    guard reconnectModel.state == .connecting(generation: generation) else {
      await connected.disconnect()
      return
    }
    connectionTask = nil
    connection = (generation, connected)
    writer = OrderedTerminalWriter(
      maxItems: configuration.outboundMaxItems,
      maxBytes: configuration.outboundMaxBytes
    )
    outboundSequence = 0
    await applyReconnectEvent(.connectionEstablished(generation: generation))
    readTask = Task { [weak self] in
      await self?.runReadLoop(connection: connected, generation: generation)
    }
  }

  private func runReadLoop(
    connection: any TerminalConnection,
    generation: UInt64
  ) async {
    do {
      while let bytes = try await connection.read(maxBytes: configuration.inboundChunkBytes) {
        try Task.checkCancellation()
        try await processInbound(bytes, connection: connection, generation: generation)
      }
      let exitStatus = try await connection.waitForExit()
      await connectionCompleted(exitStatus: exitStatus, generation: generation)
    } catch is CancellationError {
      return
    } catch {
      await connectionFailed(error, generation: generation)
    }
  }

  private func processInbound(
    _ bytes: Data,
    connection: any TerminalConnection,
    generation: UInt64
  ) async throws {
    try await withOperation {
      guard self.connection?.generation == generation else {
        throw CancellationError()
      }
      try await execute(try await terminal.feed(bytes, render: .damage), on: connection)
    }
  }

  private func connectionCompleted(
    exitStatus: TerminalExitStatus,
    generation: UInt64
  ) async {
    guard connection?.generation == generation else { return }
    lastExitStatus = exitStatus
    await clearConnection(generation: generation)
    await applyReconnectEvent(.connectionCompleted(generation: generation))
  }

  private func connectionFailed(_ error: any Error, generation: UInt64) async {
    guard
      reconnectModel.state == .connecting(generation: generation)
        || connection?.generation == generation
    else { return }
    let reconnectable = configuration.errorIsReconnectable(error)
    lastFailure = GhostteaSessionFailure(
      message: configuration.failureDescription(error),
      reconnectable: reconnectable
    )
    await clearConnection(generation: generation)
    await applyReconnectEvent(
      .connectionFailed(generation: generation, reconnectable: reconnectable)
    )
  }

  private func tearDown(generation: UInt64) async {
    connectionTask?.cancel()
    connectionTask = nil
    await clearConnection(generation: generation)
  }

  private func clearConnection(generation: UInt64) async {
    readTask?.cancel()
    readTask = nil
    writer = nil
    guard connection?.generation == generation else { return }
    let current = connection?.value
    connection = nil
    await current?.disconnect()
  }

  private func requireConnection() throws -> (generation: UInt64, value: any TerminalConnection) {
    guard let connection,
      reconnectModel.state == .connected(generation: connection.generation)
    else {
      throw GhostteaSessionError.notConnected
    }
    return connection
  }

  private func write(_ bytes: Data, to connection: any TerminalConnection) async throws {
    guard !bytes.isEmpty else { return }
    guard let writer else { throw GhostteaSessionError.notConnected }
    outboundSequence &+= 1
    try await writer.enqueue(
      SequencedTerminalBytes(sequence: outboundSequence, bytes: bytes)
    )
    try await writer.drain(to: connection)
  }

  private func execute(
    _ update: GhostteaUpdate,
    on connection: any TerminalConnection
  ) async throws {
    for effect in update.effects {
      switch effect.kind {
      case .writeToTransport:
        try await write(effect.payload, to: connection)
      case .metadataChangedJSON:
        await eventHandler(.metadataChanged(effect.payload))
      case .bell:
        await eventHandler(.bell)
      case .clipboardWrite:
        await eventHandler(.clipboardWrite(effect.payload))
      case .frameReady:
        await eventHandler(.frameReady(effect.payload))
      case .logicalSnapshotJSON:
        await eventHandler(.logicalSnapshot(effect.payload))
      }
    }
  }

  private func withOperation<T: Sendable>(
    _ operation: () async throws -> T
  ) async throws -> T {
    await operationGate.acquire()
    do {
      let result = try await operation()
      await operationGate.release()
      return result
    } catch {
      await operationGate.release()
      throw error
    }
  }

  private func withConnectedOperation<T: Sendable>(
    _ operation: (any TerminalConnection) async throws -> T
  ) async throws -> T {
    let attemptedGeneration = connection?.generation
    do {
      return try await withOperation {
        let current = try requireConnection()
        return try await operation(current.value)
      }
    } catch {
      if let attemptedGeneration, connection?.generation == attemptedGeneration {
        await connectionFailed(error, generation: attemptedGeneration)
      }
      throw error
    }
  }
}

private actor GhostteaSessionOperationGate {
  private var locked = false
  private var waiters: [CheckedContinuation<Void, Never>] = []

  func acquire() async {
    guard locked else {
      locked = true
      return
    }
    await withCheckedContinuation { continuation in
      waiters.append(continuation)
    }
  }

  func release() {
    guard !waiters.isEmpty else {
      locked = false
      return
    }
    waiters.removeFirst().resume()
  }
}
