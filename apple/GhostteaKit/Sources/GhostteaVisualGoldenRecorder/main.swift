import Foundation
import GhostteaCore
import GhostteaTerminal

@main
struct GhostteaVisualGoldenRecorder {
  static func main() async throws {
    guard CommandLine.arguments.count == 2 else {
      throw RecorderError.expectedOutputPath
    }
    let runtime = try GhostteaRuntime()
    let terminal = try GhostteaTerminal(
      runtime: runtime,
      configuration: .init(sessionHandle: 109, columns: 100, rows: 30)
    )
    let bytes = Data("Metal proof ✓ 界 \u{1b}[31;44;4;9mstyled\u{1b}[0m 🙂\r\n".utf8)
    let update = try await terminal.feed(bytes, render: .full)
    guard let frame = update.effects.first(where: { $0.kind == .frameReady })?.payload else {
      throw RecorderError.missingFrame
    }
    let proof = try GhostteaMetalProof.run(frame: frame)
    let record = GhostteaVisualGoldenRecord(
      fixture: "phase4-styled-unicode-v1",
      referencePixelHash: String(format: "%016llx", proof.pixelHash),
      fingerprint: proof.visualFingerprint,
      tolerance: GhostteaVisualTolerance(
        maxEdgeHammingDistance: 48,
        maxMeanChannelDelta: 1,
        maxNonBackgroundPixelDelta: 128
      )
    )
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
    var data = try encoder.encode(record)
    data.append(0x0A)
    try data.write(to: URL(filePath: CommandLine.arguments[1]), options: .atomic)
  }
}

private enum RecorderError: Error {
  case expectedOutputPath
  case missingFrame
}
