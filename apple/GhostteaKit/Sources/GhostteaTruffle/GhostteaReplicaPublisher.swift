import Foundation
import GhostteaCore
import GhostteaPerformance

struct GhostteaRetainedViewport: Equatable, Sendable {
  var rows: [GhostteaLogicalRow]
  var offset: UInt64

  static let empty = Self(rows: [], offset: 0)
}

/// The replica half that both attachment readers share.
///
/// ``GhostteaTruffleReplicaPump`` pulls frames and ``GhostteaAttachmentReplicaSink``
/// is pushed them, but what either does *with* a frame once it has one is
/// identical — and it is the part carrying the subtlety worth having in exactly
/// one place: a rejected patch is a discontinuity a snapshot repairs, unless
/// the replica is poisoned, in which case the ABI contract permits only
/// destruction and the failure has to propagate as-is.
///
/// An actor rather than a plain object so the replica's mutation stays
/// serialized on its own terms; each owner drives it sequentially anyway.
actor GhostteaReplicaPublisher {
  private(set) var replica: GhostteaLogicalReplica
  private(set) var presentation: GhostteaTerminalPresentationConfig?
  /// The rows the replica is currently showing, kept alongside it so a frozen
  /// frame can still be copied from (§4.4). Retained *after* a successful
  /// publish, never before: rows the replica rejected were never on screen.
  private(set) var retainedViewport = GhostteaRetainedViewport.empty

  private let encoder = JSONEncoder()
  private let sessionHandle: UInt64

  init(
    runtime: GhostteaRuntime,
    sessionHandle: UInt64,
    presentation: GhostteaTerminalPresentationConfig? = nil
  ) throws {
    self.sessionHandle = sessionHandle
    self.presentation = presentation
    replica = try GhostteaLogicalReplica(runtime: runtime, sessionHandle: sessionHandle)
  }

  func publish(_ snapshot: GhostteaLogicalSnapshot) async throws -> GhostteaUpdate {
    let update = try await GhostteaPerformanceRecorder.shared.measure(
      .truffleReplicaPublication
    ) {
      try await replica.publishSnapshotJSON(encoder.encode(snapshot))
    }
    retainedViewport = GhostteaRetainedViewport(
      rows: snapshot.rows,
      offset: snapshot.scrollbar.offset
    )
    return update
  }

  /// Throws ``GhostteaAttachmentApplyFailure/needsSnapshot`` when only an
  /// authoritative snapshot can bridge the gap, and rethrows the underlying
  /// failure when the replica itself is unusable. Callers map those two onto
  /// whatever their own surface calls them; neither may acknowledge the frame.
  func publish(_ patch: GhostteaLogicalPatch) async throws -> GhostteaUpdate {
    do {
      let update = try await GhostteaPerformanceRecorder.shared.measure(
        .truffleReplicaPublication
      ) {
        try await replica.publishPatchJSON(encoder.encode(patch))
      }
      // Same row indices the replica just applied. A replacement past the
      // retained width is ignored rather than grown into: the rows are a
      // mirror of what was published, not a buffer of their own.
      for replacement in patch.rowReplacements
      where Int(replacement.rowIndex) < retainedViewport.rows.count {
        retainedViewport.rows[Int(replacement.rowIndex)] = replacement.row
      }
      if let scrollbar = patch.scrollbar {
        retainedViewport.offset = scrollbar.offset
      }
      return update
    } catch {
      if await replica.isPoisoned { throw error }
      throw GhostteaAttachmentApplyFailure.needsSnapshot
    }
  }

  func publish(_ selection: GhostteaTrackedSelection?) async throws -> GhostteaUpdate {
    try await GhostteaPerformanceRecorder.shared.measure(.truffleReplicaPublication) {
      if let selection {
        return try await replica.publishSelection(
          anchorColumn: selection.anchor.column,
          anchorRow: selection.anchor.row,
          focusColumn: selection.focus.column,
          focusRow: selection.focus.row
        )
      }
      return try await replica.clearSelection()
    }
  }

  /// Adopts a new presentation, rebuilding the replica because a presentation
  /// re-specifies the grid it renders into. Returns whether anything changed,
  /// so a caller can stay silent about a repeat of what it already has.
  @discardableResult
  func adopt(_ next: GhostteaTerminalPresentationConfig) throws -> Bool {
    guard presentation != next else { return false }
    replica = try GhostteaLogicalReplica(
      runtime: try GhostteaRuntime(presentation: next), sessionHandle: sessionHandle)
    presentation = next
    // The new replica has painted nothing yet, so nothing is on screen to
    // copy until the host's next frame arrives.
    retainedViewport = .empty
    return true
  }
}
