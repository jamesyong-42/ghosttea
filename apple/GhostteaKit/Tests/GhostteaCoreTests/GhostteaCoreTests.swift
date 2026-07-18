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

@Test func logicalReplicaRendersRemoteSnapshotsAndPatchesToLocalTRF1() async throws {
  let runtime = try GhostteaRuntime()
  let replica = try GhostteaLogicalReplica(runtime: runtime, sessionHandle: 91)
  let snapshot = Data(
    """
    {
      "sessionEpoch": 7,
      "layoutEpoch": 3,
      "terminalRevision": 11,
      "cols": 20,
      "rows": [{
        "text": "shared",
        "cells": [{
          "column": 0,
          "span": 1,
          "text": "shared",
          "style": {
            "bold": false, "italic": false, "faint": false,
            "inverse": false, "invisible": false, "strikethrough": false,
            "underline": false, "foreground": null, "background": null
          }
        }]
      }],
      "cursor": {"x": 6, "y": 0, "visible": true, "style": 0, "blinking": true},
      "mouseTracking": false,
      "scrollbar": {"total": 1, "offset": 0, "len": 1},
      "title": "desktop",
      "cwd": "/shared"
    }
    """.utf8)
  let initial = try await replica.publishSnapshotJSON(snapshot)
  let initialFrame = try #require(initial.effects.onlyFrame)
  #expect(initialFrame.payload.starts(with: Data("TRF1".utf8)))

  let patch = Data(
    """
    {
      "sessionEpoch": 7,
      "layoutEpoch": 3,
      "patchSequence": 1,
      "terminalRevision": 12,
      "rowReplacements": [{
        "rowIndex": 0,
        "rowRevision": 12,
        "row": {
          "text": "shared!",
          "cells": [{
            "column": 0,
            "span": 1,
            "text": "shared!",
            "style": {
              "bold": true, "italic": false, "faint": false,
              "inverse": false, "invisible": false, "strikethrough": false,
              "underline": false, "foreground": null, "background": null
            }
          }]
        }
      }],
      "cursor": {"x": 7, "y": 0, "visible": true, "style": 0, "blinking": true},
      "mouseTracking": null,
      "scrollbar": null
    }
    """.utf8)
  let incremental = try await replica.publishPatchJSON(patch)
  let incrementalFrame = try #require(incremental.effects.onlyFrame)
  #expect(incrementalFrame.payload.starts(with: Data("TRF1".utf8)))
  #expect(!(await replica.isPoisoned))
  #expect(!runtime.isPoisoned)
}

private extension [GhostteaOrderedEffect] {
  var onlyFrame: GhostteaOrderedEffect? {
    count == 1 && first?.kind == .frameReady ? first : nil
  }
}
