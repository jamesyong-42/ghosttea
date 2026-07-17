import Foundation
import Testing

@testable import GhosttyVtProof

@Test("Memory budgets select conservative compact and standard device tiers")
func memoryBudgetTierSelection() {
  let compact = GhostteaMemoryBudget.recommended(
    forPhysicalMemoryBytes: 4 * 1_073_741_824
  )
  #expect(compact.tier == .compact)
  #expect(compact.maximumResidentSessions == 4)
  #expect(compact.scrollbackBytesPerSession == 3_000_000)
  #expect(compact.softApplicationFootprintBytes == 96 * 1_048_576)
  #expect(compact.hardApplicationFootprintBytes == 128 * 1_048_576)

  let standard = GhostteaMemoryBudget.recommended(
    forPhysicalMemoryBytes: 4 * 1_073_741_824 + 1
  )
  #expect(standard.tier == .standard)
  #expect(standard.maximumResidentSessions == 8)
  #expect(standard.scrollbackBytesPerSession == 5_000_000)
  #expect(standard.softApplicationFootprintBytes == 160 * 1_048_576)
  #expect(standard.hardApplicationFootprintBytes == 224 * 1_048_576)
}

@Test("Memory budget evaluation enforces process and retained-session gates")
func memoryBudgetEvaluation() {
  let budget = GhostteaMemoryBudget.recommended(
    forPhysicalMemoryBytes: 3 * 1_073_741_824
  )
  #expect(
    budget.failures(
      peakApplicationFootprintBytes: 100 * 1_048_576,
      foregroundAndBackgroundFootprintBytes: 80 * 1_048_576,
      compressionSupported: true,
      retainedScrollbackRows: [1, 1, 1, 1]
    ).isEmpty
  )
  let failures = budget.failures(
    peakApplicationFootprintBytes: 129 * 1_048_576,
    foregroundAndBackgroundFootprintBytes: 97 * 1_048_576,
    compressionSupported: false,
    retainedScrollbackRows: [1]
  )
  #expect(failures.count == 4)
}

@Test("Ghostty VT is callable from Swift and preserves terminal state")
func ghosttyVtSmokeTest() throws {
  let snapshot = try GhosttyVtProof.run()

  #expect(snapshot.columns == 100)
  #expect(snapshot.rows == 30)
  #expect(snapshot.cursorColumn == 5)
  #expect(snapshot.cursorRow == 0)
  #expect(snapshot.encodedKey == Array("a".utf8))
}

private struct TerminalFixture: Decodable {
  struct Expected: Decodable {
    let cursorColumn: UInt16
    let cursorRow: UInt16
    let replyHex: String
    let visibleText: [String]
  }

  let name: String
  let columns: UInt16
  let rows: UInt16
  let maxScrollbackBytes: Int
  let inputHex: String
  let expected: Expected
}

private struct FixtureResult: Equatable {
  let state: GhosttyVtState
  let replies: [UInt8]
  let plainText: [UInt8]
}

@Test("VT fixtures are invariant to inbound byte chunking and preserve reply order")
func terminalFixtureChunkingTest() throws {
  let fixture = try loadFixture(named: "basic-dsr")
  let input = try decodeHex(fixture.inputHex)

  let whole = try run(fixture: fixture, input: input, chunkSizes: [input.count])
  let bytewise = try run(
    fixture: fixture, input: input, chunkSizes: Array(repeating: 1, count: input.count))
  let patterned = try run(fixture: fixture, input: input, chunkSizes: [1, 2, 5, 3, 8])

  #expect(bytewise == whole)
  #expect(patterned == whole)
  #expect(whole.state.cursorColumn == fixture.expected.cursorColumn)
  #expect(whole.state.cursorRow == fixture.expected.cursorRow)
  let expectedReplies = try decodeHex(fixture.expected.replyHex)
  #expect(whole.replies == expectedReplies)

  let visibleText = String(decoding: whole.plainText, as: UTF8.self)
  for expectedLine in fixture.expected.visibleText {
    #expect(visibleText.contains(expectedLine), "Missing fixture text: \(expectedLine)")
  }
}

private func run(
  fixture: TerminalFixture,
  input: [UInt8],
  chunkSizes: [Int]
) throws -> FixtureResult {
  let session = try GhosttyVtProofSession(
    columns: fixture.columns,
    rows: fixture.rows,
    maxScrollbackBytes: fixture.maxScrollbackBytes
  )
  var offset = 0
  var chunkIndex = 0
  while offset < input.count {
    let requested = chunkSizes[chunkIndex % chunkSizes.count]
    let end = min(offset + requested, input.count)
    session.feed(Array(input[offset..<end]))
    offset = end
    chunkIndex += 1
  }
  return try FixtureResult(
    state: session.state(),
    replies: session.replyBytes,
    plainText: session.plainText()
  )
}

private func loadFixture(named name: String) throws -> TerminalFixture {
  guard
    let url = Bundle.module.url(forResource: name, withExtension: "json", subdirectory: "Fixtures")
  else {
    throw GhosttyVtProofError.operationFailed("missing fixture \(name)")
  }
  return try JSONDecoder().decode(TerminalFixture.self, from: Data(contentsOf: url))
}

private func decodeHex(_ value: String) throws -> [UInt8] {
  guard value.count.isMultiple(of: 2) else {
    throw GhosttyVtProofError.operationFailed("hex fixture has odd length")
  }
  var result: [UInt8] = []
  result.reserveCapacity(value.count / 2)
  var index = value.startIndex
  while index < value.endIndex {
    let end = value.index(index, offsetBy: 2)
    guard let byte = UInt8(value[index..<end], radix: 16) else {
      throw GhosttyVtProofError.operationFailed("invalid hex fixture")
    }
    result.append(byte)
    index = end
  }
  return result
}
