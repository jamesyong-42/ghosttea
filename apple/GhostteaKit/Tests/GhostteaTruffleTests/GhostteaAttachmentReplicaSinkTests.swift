import Foundation
import GhostteaCore
import Testing

@testable import GhostteaTruffle

/// The sink drives the same ``GhostteaReplicaPublisher`` the pump does, from the
/// push direction. The pump's own tests cover the pull direction, so these
/// exist to prove the shared core behaves identically when nobody is acking —
/// which is the whole reason the two halves were deduped rather than left as
/// two copies drifting apart.
private func snapshotJSON(terminalRevision: UInt64, viewportOffset: UInt64 = 0) -> String {
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
    "scrollbar": {"total": \(viewportOffset + 1), "offset": \(viewportOffset), "len": 1},
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

private let token = GhostteaAttachmentStateToken(generation: 1, incarnation: 1)

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
  ) { event, _ in
    await output.record(event)
  }
}

@Test func theSinkRendersSnapshotsAndContiguousPatchesThroughTheSharedCore() async throws {
  let output = SinkOutput()
  let sink = try makeSink(output: output)

  try await sink.apply(decoded(snapshotJSON(terminalRevision: 13)), from: token)
  try await sink.apply(decoded(patchJSON(sequence: 1, terminalRevision: 14)), from: token)

  let frames = await output.frames
  #expect(frames.count == 2)
  #expect(frames.first?.1 == true)
  #expect(frames.last?.1 == false)
  let rendered = try #require(frames.first?.0.effects.first { $0.kind == .frameReady })
  #expect(rendered.payload.starts(with: Data("TRF1".utf8)))
}

@Test func theSinkRendersTrackedSelectionAsASelectionOnlyFrame() async throws {
  let output = SinkOutput()
  let sink = try makeSink(output: output)
  try await sink.apply(decoded(snapshotJSON(terminalRevision: 13)), from: token)
  try await sink.apply(
    .selectionChanged(
      GhostteaTrackedSelection(
        anchor: GhostteaTrackedSelectionPoint(column: 1, row: 40),
        focus: GhostteaTrackedSelectionPoint(column: 6, row: 41)
      )
    ),
    from: token
  )

  let frames = await output.frames
  #expect(frames.count == 2)
  #expect(frames.last?.1 == false)
  let payload = try #require(frames.last?.0.effects.first { $0.kind == .frameReady }?.payload)
  let littleUInt32: (Int) -> UInt32 = { offset in
    UInt32(payload[offset])
      | UInt32(payload[offset + 1]) << 8
      | UInt32(payload[offset + 2]) << 16
      | UInt32(payload[offset + 3]) << 24
  }
  #expect(littleUInt32(108) == 0)  // no row replacements
  #expect(littleUInt32(168) == 12)  // tracked endpoint payload
  #expect(littleUInt32(172) == 1)
}

@Test func aDiscontinuousPatchRefusesTheFrameRatherThanRenderingIt() async throws {
  let output = SinkOutput()
  let sink = try makeSink(output: output)
  try await sink.apply(decoded(snapshotJSON(terminalRevision: 13)), from: token)

  // Sequence 2 with 1 missing is the gap only an authoritative snapshot can
  // bridge. The sink says so with the typed failure and reports no frame — the
  // lifecycle turns that into a snapshot request and, critically, no ack.
  var refusal: GhostteaAttachmentApplyFailure?
  do {
    try await sink.apply(decoded(patchJSON(sequence: 2, terminalRevision: 14)), from: token)
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
  try await sink.apply(.configurationChanged(initial), from: token)
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
  try await sink.apply(.configurationChanged(next), from: token)
  #expect(await output.presentations == [next])
  // A presentation re-specifies the grid, so the replica is rebuilt rather
  // than reconfigured in place.
  #expect(await sink.replica !== original)
}

@Test func theSinkReportsAClearedControllerTheRenderedVocabularyCannotExpress() async throws {
  let output = SinkOutput()
  let sink = try makeSink(output: output)

  try await sink.apply(
    .controlState(controller: nil, controlRevision: 4, cols: 120, rows: 40, layoutEpoch: 1),
    from: token)
  try await sink.apply(
    .controlChanged(
      controllerViewID: "r:pane-1", controlEpoch: 9, cols: 120, rows: 40, layoutEpoch: 1),
    from: token)

  let controllers = await output.events.compactMap { event -> GhostteaControllerInfo?? in
    if case .controller(let info) = event { return .some(info) }
    return nil
  }
  #expect(controllers.count == 2)
  #expect(controllers.first == .some(nil))
  #expect(
    controllers.last
      == .some(GhostteaControllerInfo(controllerViewID: "r:pane-1", controlEpoch: 9))
  )
}

// MARK: - P2-6: offline copy from the retained frame (§4.4)

private func row(_ text: String) -> GhostteaLogicalRow {
  GhostteaLogicalRow(text: text, cells: [])
}

@Test func viewportSelectionExtractsWholeAndPartialSpans() {
  let rows = [row("interop-line-1"), row("middle row here   "), row("interop-line-2")]

  #expect(
    GhostteaViewportSelection.extract(GhostteaSelectionRequest(selectAll: true), from: rows)
      == "interop-line-1\nmiddle row here\ninterop-line-2")

  // A single row clips at both ends.
  #expect(
    GhostteaViewportSelection.extract(
      GhostteaSelectionRequest(startColumn: 8, startRow: 0, endColumn: 13, endRow: 0),
      from: rows) == "line-1")

  // A span keeps its middle rows whole and clips only the ends — how a
  // terminal selection reads.
  #expect(
    GhostteaViewportSelection.extract(
      GhostteaSelectionRequest(startColumn: 8, startRow: 0, endColumn: 6, endRow: 2),
      from: rows) == "line-1\nmiddle row here\ninterop")

  // Backward drags and absolute scrollback coordinates match the host RPC.
  #expect(
    GhostteaViewportSelection.extract(
      GhostteaSelectionRequest(startColumn: 13, startRow: 40, endColumn: 8, endRow: 40),
      from: rows,
      viewportOffset: 40) == "line-1")

  // Nothing retained is not an empty selection: there is no screen to select.
  #expect(
    GhostteaViewportSelection.extract(GhostteaSelectionRequest(selectAll: true), from: [])
      == nil
  )

  // A column past the row's width clips rather than failing — the selection
  // describes a screen that is simply shorter there.
  #expect(
    GhostteaViewportSelection.extract(
      GhostteaSelectionRequest(startColumn: 0, startRow: 0, endColumn: 900, endRow: 0),
      from: rows) == "interop-line-1")
}

@Test func viewportSelectionUsesCellSpansForWideGraphemes() {
  let style = GhostteaLogicalCellStyle(
    bold: false,
    italic: false,
    faint: false,
    inverse: false,
    invisible: false,
    strikethrough: false,
    underline: false,
    foreground: nil,
    background: nil
  )
  let rows = [
    GhostteaLogicalRow(
      text: "a界b",
      cells: [
        GhostteaLogicalCell(column: 0, span: 1, text: "a", style: style),
        GhostteaLogicalCell(column: 1, span: 2, text: "界", style: style),
        GhostteaLogicalCell(column: 3, span: 1, text: "b", style: style),
      ]
    )
  ]
  #expect(
    GhostteaViewportSelection.extract(
      GhostteaSelectionRequest(startColumn: 2, startRow: 7, endColumn: 3, endRow: 7),
      from: rows,
      viewportOffset: 7
    ) == "界b"
  )
}

@Test func theSinkRetainsRowsThroughSnapshotsAndPatchesForOfflineCopy() async throws {
  let output = SinkOutput()
  let sink = try makeSink(output: output)
  #expect(await sink.retainedSelection(GhostteaSelectionRequest(selectAll: true)) == nil)

  try await sink.apply(decoded(snapshotJSON(terminalRevision: 13)), from: token)
  #expect(await sink.retainedSelection(GhostteaSelectionRequest(selectAll: true)) == "shared")

  // A patch mutates the retained rows the same way it mutates the replica, so
  // a frozen frame copies what is actually on screen rather than what the
  // last snapshot said.
  let patched = """
    {
      "type": "patch", "sessionEpoch": 7, "layoutEpoch": 4, "patchSequence": 1,
      "terminalRevision": 14,
      "rowReplacements": [{
        "rowIndex": 0, "rowRevision": 14,
        "row": {"text": "after the patch", "cells": []}
      }],
      "cursor": null, "mouseTracking": null, "scrollbar": null
    }
    """
  try await sink.apply(decoded(patched), from: token)
  #expect(
    await sink.retainedSelection(GhostteaSelectionRequest(selectAll: true)) == "after the patch")

  let offsetSink = try makeSink(output: SinkOutput())
  try await offsetSink.apply(
    decoded(snapshotJSON(terminalRevision: 20, viewportOffset: 40)),
    from: token
  )
  #expect(
    await offsetSink.retainedSelection(
      GhostteaSelectionRequest(startColumn: 0, startRow: 40, endColumn: 5, endRow: 40)
    ) == "shared"
  )
}
