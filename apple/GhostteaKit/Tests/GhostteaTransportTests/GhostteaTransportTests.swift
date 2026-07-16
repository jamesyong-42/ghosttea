import Foundation
import Testing

@testable import GhostteaTransport

@Test("Replay transport is lossless, demand-driven, and bounded by each read")
func replayTransportDemandTest() async throws {
  let expected = Data((0..<31).map(UInt8.init))
  let connection = ReplayTransport(bytes: expected).makeConnection()
  var received = Data()

  while let chunk = try await connection.read(maxBytes: 4) {
    #expect(chunk.count <= 4)
    received.append(chunk)
  }

  #expect(received == expected)
  let snapshot = await connection.snapshot()
  #expect(snapshot.deliveredBytes == expected.count)
  #expect(snapshot.readCalls == 9)
}

@Test("Replay transport records ordered host operations")
func replayTransportOperationTest() async throws {
  let connection = ReplayTransport(
    bytes: Data(),
    exitStatus: .exited(code: 37)
  ).makeConnection()
  try await connection.write(Data("one".utf8))
  try await connection.write(Data("two".utf8))
  try await connection.resize(columns: 100, rows: 30)
  try await connection.interrupt()
  try await connection.finishInput()
  let exitStatus = try await connection.waitForExit()

  let snapshot = await connection.snapshot()
  #expect(snapshot.writes == [Data("one".utf8), Data("two".utf8)])
  #expect(snapshot.resizes == [try TerminalSize(columns: 100, rows: 30)])
  #expect(snapshot.interruptCount == 1)
  #expect(snapshot.didFinishInput)
  #expect(snapshot.didObserveExit)
  #expect(exitStatus == .exited(code: 37))

  let signaledConnection = ReplayTransport(
    bytes: Data(),
    exitStatus: .signaled(name: "TERM")
  ).makeConnection()
  #expect(try await signaledConnection.waitForExit() == .signaled(name: "TERM"))
}

@Test("Ordered writer preserves sequence and rejects byte or item overflow")
func orderedWriterTest() async throws {
  let connection = ReplayTransport(bytes: Data()).makeConnection()
  let writer = OrderedTerminalWriter(maxItems: 2, maxBytes: 6)
  try await writer.enqueue(SequencedTerminalBytes(sequence: 1, bytes: Data("abc".utf8)))
  try await writer.enqueue(SequencedTerminalBytes(sequence: 2, bytes: Data("de".utf8)))

  await #expect(throws: TerminalTransportError.outboundBackpressure(maxItems: 2, maxBytes: 6)) {
    try await writer.enqueue(SequencedTerminalBytes(sequence: 3, bytes: Data("f".utf8)))
  }

  try await writer.drain(to: connection)
  let pending = await writer.pending()
  #expect(pending.items == 0)
  #expect(pending.bytes == 0)
  #expect(await connection.snapshot().writes == [Data("abc".utf8), Data("de".utf8)])
}

@Test("Disconnected replay connection rejects further demand")
func replayDisconnectTest() async throws {
  let connection = ReplayTransport(bytes: Data([1])).makeConnection()
  await connection.disconnect()
  await #expect(throws: TerminalTransportError.disconnected) {
    _ = try await connection.read(maxBytes: 1)
  }
}
