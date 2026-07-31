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
  private let output: @Sendable (GhostteaAttachmentSinkEvent) async -> Void

  public init(
    runtime: GhostteaRuntime,
    sessionHandle: UInt64,
    presentation: GhostteaTerminalPresentationConfig?,
    output: @escaping @Sendable (GhostteaAttachmentSinkEvent) async -> Void
  ) throws {
    self.output = output
    publisher = try GhostteaReplicaPublisher(
      runtime: runtime, sessionHandle: sessionHandle, presentation: presentation)
  }

  /// The replica this sink renders into. It is replaced whenever the host
  /// re-specifies the presentation, so read it rather than holding it.
  public var replica: GhostteaLogicalReplica {
    get async { await publisher.replica }
  }

  public func apply(_ message: GhostteaTerminalStateMessage) async throws {
    switch message {
    case .snapshot(let snapshot):
      await output(.frame(try await publisher.publish(snapshot), fullSnapshot: true))

    case .patch(let patch):
      await output(.frame(try await publisher.publish(patch), fullSnapshot: false))

    case .controlState(let controller, _, _, _, _):
      await output(.controller(controller))

    case .controlChanged(let viewID, let epoch, _, _, _):
      await output(
        .controller(GhostteaControllerInfo(controllerViewID: viewID, controlEpoch: epoch)))

    case .activityChanged(let activity):
      await output(.activity(activity))

    case .configurationChanged(let next):
      guard try await publisher.adopt(next) else { return }
      await output(.presentation(next))

    // The lifecycle consumes both before the sink is called; they are listed
    // rather than defaulted so a new state message cannot be silently ignored.
    case .sessionEnded, .hostShutdown:
      break
    }
  }
}
