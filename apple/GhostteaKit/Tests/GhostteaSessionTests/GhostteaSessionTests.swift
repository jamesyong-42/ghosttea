import Foundation
import GhostteaCore
import GhostteaTransport
import Testing

@testable import GhostteaSession

private actor SessionEventRecorder {
  private(set) var events: [GhostteaSessionEvent] = []

  func record(_ event: GhostteaSessionEvent) {
    events.append(event)
  }

  func waitForState(_ expected: TerminalReconnectState) async {
    while !events.contains(where: {
      guard case .stateChanged(let snapshot) = $0 else { return false }
      return snapshot.reconnectState == expected
    }) {
      await Task.yield()
    }
  }
}

private actor ConnectionBox {
  private var connection: HoldingTerminalConnection?

  func store(_ connection: HoldingTerminalConnection) {
    self.connection = connection
  }

  func value() -> HoldingTerminalConnection? {
    connection
  }
}

private struct HoldingConnectionSnapshot: Sendable {
  let writes: [Data]
  let resizes: [TerminalSize]
  let isConnected: Bool
}

private actor HoldingTerminalConnection: TerminalConnection {
  private let writeFailure: TerminalTransportError?
  private var readContinuation: CheckedContinuation<Data?, any Error>?
  private var writes: [Data] = []
  private var resizes: [TerminalSize] = []
  private var isConnected = true

  init(writeFailure: TerminalTransportError? = nil) {
    self.writeFailure = writeFailure
  }

  func read(maxBytes: Int) async throws -> Data? {
    guard maxBytes > 0 else { throw TerminalTransportError.invalidReadSize(maxBytes) }
    guard isConnected else { throw TerminalTransportError.disconnected }
    return try await withTaskCancellationHandler {
      try await withCheckedThrowingContinuation { continuation in
        readContinuation = continuation
      }
    } onCancel: {
      Task { await self.cancelRead() }
    }
  }

  func write(_ bytes: Data) throws {
    guard isConnected else { throw TerminalTransportError.disconnected }
    if let writeFailure { throw writeFailure }
    writes.append(bytes)
  }

  func finishInput() throws {
    guard isConnected else { throw TerminalTransportError.disconnected }
  }

  func resize(columns: Int, rows: Int) throws {
    guard isConnected else { throw TerminalTransportError.disconnected }
    resizes.append(try TerminalSize(columns: columns, rows: rows))
  }

  func interrupt() throws {
    guard isConnected else { throw TerminalTransportError.disconnected }
  }

  func waitForExit() throws -> TerminalExitStatus {
    guard isConnected else { throw TerminalTransportError.disconnected }
    return .exited(code: 0)
  }

  func disconnect() {
    isConnected = false
    readContinuation?.resume(throwing: TerminalTransportError.disconnected)
    readContinuation = nil
  }

  func snapshot() -> HoldingConnectionSnapshot {
    HoldingConnectionSnapshot(writes: writes, resizes: resizes, isConnected: isConnected)
  }

  private func cancelRead() {
    readContinuation?.resume(throwing: CancellationError())
    readContinuation = nil
  }
}

private let satisfiedPath = TerminalNetworkPath(
  availability: .satisfied,
  interfaces: [.wifi]
)

private func makeTerminal(sessionHandle: UInt64) throws -> GhostteaTerminal {
  try GhostteaTerminal(
    runtime: GhostteaRuntime(),
    configuration: .init(sessionHandle: sessionHandle, columns: 80, rows: 24)
  )
}

@Test("Session pulls input, executes ordered replies, and reports clean exit")
func sessionInboundLifecycle() async throws {
  let input = Data("hello\u{1b}[6n".utf8)
  let connection = ReplayTransport(
    bytes: input,
    exitStatus: .exited(code: 7)
  ).makeConnection()
  let recorder = SessionEventRecorder()
  let session = GhostteaSession(
    terminal: try makeTerminal(sessionHandle: 201),
    configuration: .init(inboundChunkBytes: 3, initialPath: satisfiedPath),
    connectionFactory: { connection },
    eventHandler: { await recorder.record($0) }
  )

  await session.requestConnect()
  await recorder.waitForState(.idle)

  let transport = await connection.snapshot()
  #expect(transport.deliveredBytes == input.count)
  #expect(transport.readCalls > 2)
  #expect(transport.writes.contains(Data("\u{1b}[1;6R".utf8)))
  #expect(transport.didObserveExit)
  #expect(!transport.isConnected)
  #expect(await session.snapshot().lastExitStatus == .exited(code: 7))
  #expect(
    await recorder.events.contains(where: {
      guard case .frameReady = $0 else { return false }
      return true
    })
  )
}

@Test("Session serializes user input with PTY and core resize")
func sessionInputAndResize() async throws {
  let connection = HoldingTerminalConnection()
  let recorder = SessionEventRecorder()
  let session = GhostteaSession(
    terminal: try makeTerminal(sessionHandle: 202),
    configuration: .init(initialPath: satisfiedPath),
    connectionFactory: { connection },
    eventHandler: { await recorder.record($0) }
  )

  await session.requestConnect()
  await recorder.waitForState(.connected(generation: 1))
  try await session.send(Data("raw".utf8))
  try await session.sendKey(
    GhostteaKeyEvent(code: "KeyA", text: "a", unshiftedCodepoint: 97)
  )
  try await session.resize(columns: 100, rows: 30, layoutEpoch: 2)
  await session.disconnect()

  let transport = await connection.snapshot()
  #expect(Array(transport.writes.prefix(2)) == [Data("raw".utf8), Data("a".utf8)])
  #expect(transport.resizes == [try TerminalSize(columns: 100, rows: 30)])
  #expect(!transport.isConnected)
  #expect(
    await recorder.events.contains(where: {
      guard case .frameReady(let frame) = $0 else { return false }
      return !frame.isEmpty
    })
  )
}

@Test("Route changes tear down and require explicit fresh reconnect")
func sessionReconnectGeneration() async throws {
  let box = ConnectionBox()
  let recorder = SessionEventRecorder()
  let session = GhostteaSession(
    terminal: try makeTerminal(sessionHandle: 203),
    configuration: .init(initialPath: satisfiedPath),
    connectionFactory: {
      let connection = HoldingTerminalConnection()
      await box.store(connection)
      return connection
    },
    eventHandler: { await recorder.record($0) }
  )

  await session.requestConnect()
  await recorder.waitForState(.connected(generation: 1))
  await session.updateNetworkPath(
    TerminalNetworkPath(availability: .satisfied, interfaces: [.cellular], isExpensive: true)
  )
  await recorder.waitForState(.reconnectAvailable)
  #expect(await box.value()?.snapshot().isConnected == false)

  await session.requestConnect()
  await recorder.waitForState(.connected(generation: 2))
  #expect(await session.snapshot().reconnectState == .connected(generation: 2))
  await session.disconnect()
}

@Test("Connected operation failures tear down with redacted policy state")
func sessionConnectedOperationFailure() async throws {
  let connection = HoldingTerminalConnection(writeFailure: .disconnected)
  let recorder = SessionEventRecorder()
  let session = GhostteaSession(
    terminal: try makeTerminal(sessionHandle: 204),
    configuration: .init(
      initialPath: satisfiedPath,
      errorIsReconnectable: { _ in false },
      failureDescription: { _ in "Safe failure" }
    ),
    connectionFactory: { connection },
    eventHandler: { await recorder.record($0) }
  )

  await session.requestConnect()
  await recorder.waitForState(.connected(generation: 1))
  await #expect(throws: TerminalTransportError.disconnected) {
    try await session.send(Data("fails".utf8))
  }
  await recorder.waitForState(.failed)

  let snapshot = await session.snapshot()
  #expect(
    snapshot.lastFailure == GhostteaSessionFailure(message: "Safe failure", reconnectable: false))
  #expect(await !connection.snapshot().isConnected)
}
