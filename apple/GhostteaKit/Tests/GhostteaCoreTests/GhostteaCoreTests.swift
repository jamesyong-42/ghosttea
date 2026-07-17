import Foundation
import GhostteaCore
import Testing

@Test func productionCorePreservesOrderedEffectsAndOwnership() async throws {
  let runtime = try GhostteaRuntime()
  let terminal = try GhostteaTerminal(
    runtime: runtime,
    configuration: .init(sessionHandle: 42)
  )
  let update = try await terminal.feed(
    Data("phase3\r\n\u{1B}]0;swift-title\u{07}\u{1B}[6n".utf8),
    render: .full
  )
  #expect(update.effects.map(\.sequence) == Array(0..<UInt32(update.effects.count)))
  #expect(update.effects.first?.kind == .writeToTransport)
  #expect(update.effects.contains { $0.kind == .frameReady })
  #expect(update.effects.contains { $0.kind == .logicalSnapshotJSON })
  let accessibility = try await terminal.accessibilityRows(start: 0, count: 2)
  #expect(String(decoding: accessibility, as: UTF8.self).contains("phase3"))
  #expect(!(await terminal.isPoisoned))
  #expect(!runtime.isPoisoned)
}

@Test func repeatedRuntimeTerminalAndArenaLifecycles() async throws {
  for index in 0..<100 {
    let runtime = try GhostteaRuntime()
    let terminal = try GhostteaTerminal(
      runtime: runtime,
      configuration: .init(sessionHandle: UInt64(index + 1))
    )
    let update = try await terminal.feed(Data("loop \(index)".utf8), render: .full)
    let frame = try #require(update.effects.first { $0.kind == .frameReady })
    #expect(frame.payload.starts(with: Data("TRF1".utf8)))
  }
}
