import Foundation
import GhostteaCore

/// What the sink reports after a frame has been applied.
public enum GhostteaAttachmentSinkEvent: Sendable {
  case frame(GhostteaUpdate, fullSnapshot: Bool)
  /// `nil` means nobody holds control. The rendered-event vocabulary cannot
  /// express a cleared controller, and this is the case the reclaim
  /// affordance turns on, so it gets its own event rather than being dropped.
  case controller(GhostteaControllerInfo?)
  case activity(GhostteaSessionActivity)
  case presentation(GhostteaTerminalPresentationConfig)
}

/// Applies the lifecycle's admitted state frames to a local replica.
///
/// This is ``GhostteaTruffleReplicaPump`` turned inside out. The pump owns an
/// attachment and pulls; the lifecycle owns the wire and pushes, so this side
/// only applies and reports — the two share ``GhostteaReplicaPublisher`` for
/// the part that is genuinely the same. It deliberately never acknowledges:
/// returning from ``apply(_:)`` *is* the acknowledgement, and a patch it cannot
/// apply throws ``GhostteaAttachmentApplyFailure/needsSnapshot`` so the
/// lifecycle asks for a snapshot without ever acking the frame it refused.
public actor GhostteaAttachmentReplicaSink: GhostteaAttachmentStateSink {
  private let publisher: GhostteaReplicaPublisher
  private let output:
    @Sendable (GhostteaAttachmentSinkEvent, GhostteaAttachmentStateToken) async -> Void

  public init(
    runtime: GhostteaRuntime,
    sessionHandle: UInt64,
    presentation: GhostteaTerminalPresentationConfig?,
    output: @escaping @Sendable (GhostteaAttachmentSinkEvent, GhostteaAttachmentStateToken) async ->
      Void
  ) throws {
    self.output = output
    publisher = try GhostteaReplicaPublisher(
      runtime: runtime, sessionHandle: sessionHandle, presentation: presentation)
  }

  /// Offline copy, from the rows the frozen frame is still showing (§4.4).
  ///
  /// `nil` when nothing has been retained yet. The caller routes: while the
  /// session is Live the host answers, because only the host can reach
  /// scrollback; this is what remains available once it cannot, and it covers
  /// the visible screen only.
  public func retainedSelection(_ request: GhostteaSelectionRequest) async -> String? {
    GhostteaViewportSelection.extract(request, from: await publisher.retainedRows)
  }

  /// The replica this sink renders into. It is replaced whenever the host
  /// re-specifies the presentation, so read it rather than holding it.
  public var replica: GhostteaLogicalReplica {
    get async { await publisher.replica }
  }

  /// Every report carries the token of the frame that produced it, unchanged.
  /// This sink cannot know whether its lifecycle has since moved on — only the
  /// consumer holding the current token can — so it forwards rather than
  /// judges.
  public func apply(
    _ message: GhostteaTerminalStateMessage, from token: GhostteaAttachmentStateToken
  ) async throws {
    switch message {
    case .snapshot(let snapshot):
      await output(.frame(try await publisher.publish(snapshot), fullSnapshot: true), token)

    case .patch(let patch):
      await output(.frame(try await publisher.publish(patch), fullSnapshot: false), token)

    case .controlState(let controller, _, _, _, _):
      await output(.controller(controller), token)

    case .controlChanged(let viewID, let epoch, _, _, _):
      await output(
        .controller(GhostteaControllerInfo(controllerViewID: viewID, controlEpoch: epoch)), token)

    case .activityChanged(let activity):
      await output(.activity(activity), token)

    case .configurationChanged(let next):
      guard try await publisher.adopt(next) else { return }
      await output(.presentation(next), token)

    // The lifecycle consumes both before the sink is called; they are listed
    // rather than defaulted so a new state message cannot be silently ignored.
    case .sessionEnded, .hostShutdown:
      break
    }
  }
}
