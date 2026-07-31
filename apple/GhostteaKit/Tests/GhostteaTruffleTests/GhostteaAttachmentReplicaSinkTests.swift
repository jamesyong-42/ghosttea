import Foundation
import GhostteaCore
import Testing

@testable import GhostteaTruffle

/// The sink drives the same ``GhostteaReplicaPublisher`` the pump does, from the
/// push direction. The pump's own tests cover the pull direction, so these
/// exist to prove the shared core behaves identically when nobody is acking —
/// which is the whole reason the two halves were deduped rather than left as
/// two copies drifting apart.
private func snapshotJSON(terminalRevision: UInt64) -> String {
  """
  {
    "type": "snapshot",
    "sessionEpoch": 7,
    "layoutEpoch": 4,
    "terminalRevision": \(terminalRevision),
    "cols": 120,
    "rows": [{
      "text": "shared",
      "cells": [{
        "column": 0, "span": 1, "text": "shared",
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
  """
}

private func patchJSON(sequence: UInt64, terminalRevision: UInt64) -> String {
  """
  {
    "type": "patch",
    "sessionEpoch": 7,
    "layoutEpoch": 4,
    "patchSequence": \(sequence),
    "terminalRevision": \(terminalRevision),
    "rowReplacements": [],
    "cursor": null,
    "mouseTracking": null,
    "scrollbar": null
  }
  """
}

private func decoded(_ json: String) throws -> GhostteaTerminalStateMessage {
  try GhostteaTerminalStateCodec.decode(Data(json.utf8), codec: .json)
}

private actor SinkOutput {
  private(set) var events: [GhostteaAttachmentSinkEvent] = []

  func record(_ event: GhostteaAttachmentSinkEvent) {
    events.append(event)
  }

  var frames: [(GhostteaUpdate, Bool)] {
    events.compactMap {
      if case .frame(let update, let full) = $0 { return (update, full) }
      return nil
    }
  }

  var presentations: [GhostteaTerminalPresentationConfig] {
    events.compactMap {
      if case .presentation(let config) = $0 { return config }
      return nil
    }
  }
}

private func makeSink(
  presentation: GhostteaTerminalPresentationConfig? = nil,
  output: SinkOutput
) throws -> GhostteaAttachmentReplicaSink {
  let runtime = try presentation.map { try GhostteaRuntime(presentation: $0) } ?? GhostteaRuntime()
  return try GhostteaAttachmentReplicaSink(
    runtime: runtime,
    sessionHandle: 4_201,
    presentation: presentation
  ) { event in
    await output.record(event)
  }
}

@Test func theSinkRendersSnapshotsAndContiguousPatchesThroughTheSharedCore() async throws {
  let output = SinkOutput()
  let sink = try makeSink(output: output)

  try await sink.apply(decoded(snapshotJSON(terminalRevision: 13)))
  try await sink.apply(decoded(patchJSON(sequence: 1, terminalRevision: 14)))

  let frames = await output.frames
  #expect(frames.count == 2)
  #expect(frames.first?.1 == true)
  #expect(frames.last?.1 == false)
  let rendered = try #require(frames.first?.0.effects.first { $0.kind == .frameReady })
  #expect(rendered.payload.starts(with: Data("TRF1".utf8)))
}

@Test func aDiscontinuousPatchRefusesTheFrameRatherThanRenderingIt() async throws {
  let output = SinkOutput()
  let sink = try makeSink(output: output)
  try await sink.apply(decoded(snapshotJSON(terminalRevision: 13)))

  // Sequence 2 with 1 missing is the gap only an authoritative snapshot can
  // bridge. The sink says so with the typed failure and reports no frame — the
  // lifecycle turns that into a snapshot request and, critically, no ack.
  var refusal: GhostteaAttachmentApplyFailure?
  do {
    try await sink.apply(decoded(patchJSON(sequence: 2, terminalRevision: 14)))
  } catch let failure as GhostteaAttachmentApplyFailure {
    refusal = failure
  }
  #expect(refusal == .needsSnapshot)
  #expect(await output.frames.count == 1)
}

@Test func onlyAChangedPresentationRebuildsTheReplicaAndIsReported() async throws {
  let initial = GhostteaTerminalPresentationConfig(
    schemaVersion: 1, revision: "initial", foreground: [0xee, 0xee, 0xee],
    background: [0x11, 0x22, 0x33], cursor: [0xaa, 0xbb, 0xcc],
    selectionBackground: [0x44, 0x55, 0x66], selectionForeground: [0xff, 0xff, 0xff],
    fontSize: 13, fontFamilies: ["JetBrains Mono"], paddingX: [3, 4], paddingY: [5, 6],
    postProcess: .none, customShaderCount: 0)
  let output = SinkOutput()
  let sink = try makeSink(presentation: initial, output: output)
  let original = await sink.replica

  // The presentation it already has re-specifies nothing, so nothing is
  // rebuilt and the scene is not told about a change that did not happen.
  try await sink.apply(.configurationChanged(initial))
  #expect(await output.presentations.isEmpty)
  #expect(await sink.replica === original)

  var next = initial
  next = GhostteaTerminalPresentationConfig(
    schemaVersion: 1, revision: "live", foreground: initial.foreground,
    background: initial.background, cursor: initial.cursor,
    selectionBackground: initial.selectionBackground,
    selectionForeground: initial.selectionForeground, fontSize: 17,
    fontFamilies: initial.fontFamilies, paddingX: initial.paddingX,
    paddingY: initial.paddingY, postProcess: initial.postProcess,
    customShaderCount: initial.customShaderCount)
  try await sink.apply(.configurationChanged(next))
  #expect(await output.presentations == [next])
  // A presentation re-specifies the grid, so the replica is rebuilt rather
  // than reconfigured in place.
  #expect(await sink.replica !== original)
}

@Test func theSinkReportsAClearedControllerTheRenderedVocabularyCannotExpress() async throws {
  let output = SinkOutput()
  let sink = try makeSink(output: output)

  try await sink.apply(
    .controlState(controller: nil, controlRevision: 4, cols: 120, rows: 40, layoutEpoch: 1))
  try await sink.apply(
    .controlChanged(
      controllerViewID: "r:pane-1", controlEpoch: 9, cols: 120, rows: 40, layoutEpoch: 1))

  let controllers = await output.events.compactMap { event -> GhostteaControllerInfo?? in
    if case .controller(let info) = event { return .some(info) }
    return nil
  }
  #expect(controllers.count == 2)
  #expect(controllers.first == .some(nil))
  #expect(controllers.last == .some(GhostteaControllerInfo(controllerViewID: "r:pane-1", controlEpoch: 9)))
}
