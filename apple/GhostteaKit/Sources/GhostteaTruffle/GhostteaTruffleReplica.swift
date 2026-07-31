import Foundation
import GhostteaCore
import GhostteaPerformance

public enum GhostteaRenderedAttachmentEvent: Sendable {
  case frame(GhostteaUpdate, fullSnapshot: Bool)
  case controlChanged(
    controllerViewID: String,
    controlEpoch: UInt64,
    cols: UInt16,
    rows: UInt16,
    layoutEpoch: UInt64
  )
  case activityChanged(GhostteaSessionActivity)
  case configurationChanged(GhostteaTerminalPresentationConfig)
  case selectionText(requestID: String, text: String)
  case resynchronizing
}

/// Pulls one bounded attachment event at a time and turns remote logical state
/// into local TRF1. Renderer demand therefore controls how quickly network
/// state is read, instead of an unbounded buffering stream.
public actor GhostteaTruffleReplicaPump {
  public let attachment: GhostteaTruffleAttachment
  public private(set) var replica: GhostteaLogicalReplica

  private let encoder = JSONEncoder()
  private let sessionHandle: UInt64
  private var renderRuntime: GhostteaRuntime
  private var presentation: GhostteaTerminalPresentationConfig?

  public init(
    attachment: GhostteaTruffleAttachment,
    runtime: GhostteaRuntime,
    sessionHandle: UInt64,
    presentation: GhostteaTerminalPresentationConfig? = nil
  ) throws {
    self.attachment = attachment
    self.sessionHandle = sessionHandle
    renderRuntime = runtime
    self.presentation = presentation
    replica = try GhostteaLogicalReplica(runtime: runtime, sessionHandle: sessionHandle)
  }

  public func next() async throws -> GhostteaRenderedAttachmentEvent {
    switch try await attachment.nextEvent() {
    case .selectionText(let requestID, let text):
      return .selectionText(requestID: requestID, text: text)
    case .state(.controlChanged(let viewID, let epoch, let cols, let rows, let layout)):
      return .controlChanged(
        controllerViewID: viewID,
        controlEpoch: epoch,
        cols: cols,
        rows: rows,
        layoutEpoch: layout
      )
    case .state(.activityChanged(let activity)):
      return .activityChanged(activity)
    case .state(.configurationChanged(let presentation)):
      if self.presentation != presentation {
        let runtime = try GhostteaRuntime(presentation: presentation)
        replica = try GhostteaLogicalReplica(runtime: runtime, sessionHandle: sessionHandle)
        renderRuntime = runtime
        self.presentation = presentation
      }
      return .configurationChanged(presentation)
    case .state(.snapshot(let snapshot)):
      let update = try await GhostteaPerformanceRecorder.shared.measure(
        .truffleReplicaPublication
      ) {
        try await replica.publishSnapshotJSON(encoder.encode(snapshot))
      }
      try await attachment.acknowledge(
        sessionEpoch: snapshot.sessionEpoch,
        layoutEpoch: snapshot.layoutEpoch,
        patchSequence: 0,
        terminalRevision: snapshot.terminalRevision
      )
      return .frame(update, fullSnapshot: true)
    case .state(.patch(let patch)):
      let update: GhostteaUpdate
      do {
        update = try await GhostteaPerformanceRecorder.shared.measure(
          .truffleReplicaPublication
        ) {
          try await replica.publishPatchJSON(encoder.encode(patch))
        }
      } catch {
        if await replica.isPoisoned {
          // The ABI contract permits only destruction after a caught panic;
          // surface this as attachment/session death rather than retrying.
          throw error
        }
        // A logical discontinuity is recoverable only through an authoritative
        // snapshot. Never apply or acknowledge the rejected patch.
        try await attachment.requestSnapshot()
        return .resynchronizing
      }
      try await attachment.acknowledge(
        sessionEpoch: patch.sessionEpoch,
        layoutEpoch: patch.layoutEpoch,
        patchSequence: patch.patchSequence,
        terminalRevision: patch.terminalRevision
      )
      return .frame(update, fullSnapshot: false)
    }
  }
}
