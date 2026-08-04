import Foundation
import GhostteaCore

public enum GhostteaPresentationAuthority: Equatable, Sendable {
  /// Preserve the existing GhostteaKit contract for generic replicated views.
  case host
  /// Keep renderer presentation local while the host owns terminal semantics.
  case device
}

public struct GhostteaDevicePresentationResult: Sendable {
  public let applied: Bool
  public let update: GhostteaUpdate?

  fileprivate init(applied: Bool, update: GhostteaUpdate?) {
    self.applied = applied
    self.update = update
  }
}

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
  private let presentationAuthority: GhostteaPresentationAuthority
  private var devicePresentationGeneration: UInt64 = 0
  private var replicaOperationActive = false
  private var replicaOperationWaiters: [CheckedContinuation<Void, Never>] = []
  private let output:
    @Sendable (GhostteaAttachmentSinkEvent, GhostteaAttachmentStateToken) async -> Void

  public init(
    runtime: GhostteaRuntime,
    sessionHandle: UInt64,
    presentation: GhostteaTerminalPresentationConfig?,
    presentationAuthority: GhostteaPresentationAuthority = .host,
    output:
      @escaping @Sendable (GhostteaAttachmentSinkEvent, GhostteaAttachmentStateToken) async -> Void
  ) throws {
    self.output = output
    self.presentationAuthority = presentationAuthority
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
    let viewport = await publisher.retainedViewport
    return GhostteaViewportSelection.extract(
      request,
      from: viewport.rows,
      viewportOffset: viewport.offset
    )
  }

  /// The replica this sink renders into. It is replaced whenever the host
  /// re-specifies the presentation, so read it rather than holding it.
  public var replica: GhostteaLogicalReplica {
    get async { await publisher.replica }
  }

  /// Commits a validated device presentation in generation order. It returns
  /// the local frame instead of routing through the host state token, so a
  /// settings update cannot advance or masquerade as network state.
  public func reconfigureDevicePresentation(
    _ presentation: GhostteaTerminalPresentationConfig,
    runtime: GhostteaRuntime?,
    generation: UInt64,
    publish: (@Sendable (GhostteaDevicePresentationResult) async -> Void)? = nil
  ) async throws -> GhostteaDevicePresentationResult {
    guard presentationAuthority == .device else {
      return GhostteaDevicePresentationResult(applied: false, update: nil)
    }
    if replicaOperationActive {
      await withCheckedContinuation { replicaOperationWaiters.append($0) }
    } else {
      replicaOperationActive = true
    }
    defer { releaseReplicaOperation() }
    try Task.checkCancellation()
    guard generation > devicePresentationGeneration else {
      return GhostteaDevicePresentationResult(applied: false, update: nil)
    }
    let update = try await publisher.reconfigureDevicePresentation(
      presentation,
      runtime: runtime
    )
    devicePresentationGeneration = generation
    let result = GhostteaDevicePresentationResult(applied: true, update: update)
    // Keep publication inside the same transaction as the native mutation.
    // Otherwise a state patch can publish a newer frame while this method is
    // returning, only for its caller to overwrite it with this older frame.
    await publish?(result)
    return result
  }

  /// Swift actors are reentrant at `await`; this small FIFO keeps replica
  /// mutation and frame publication in one total order across host frames and
  /// local presentation changes.
  private func releaseReplicaOperation() {
    guard !replicaOperationWaiters.isEmpty else {
      replicaOperationActive = false
      return
    }
    replicaOperationWaiters.removeFirst().resume()
  }

  /// Every report carries the token of the frame that produced it, unchanged.
  /// This sink cannot know whether its lifecycle has since moved on — only the
  /// consumer holding the current token can — so it forwards rather than
  /// judges.
  public func apply(
    _ message: GhostteaTerminalStateMessage, from token: GhostteaAttachmentStateToken
  ) async throws {
    let ordersReplica: Bool
    switch message {
    case .snapshot, .patch, .selectionChanged:
      ordersReplica = true
    case .configurationChanged:
      ordersReplica = presentationAuthority == .host
    case .controlState, .controlChanged, .activityChanged, .sessionEnded, .hostShutdown:
      ordersReplica = false
    }
    if ordersReplica {
      if replicaOperationActive {
        await withCheckedContinuation { replicaOperationWaiters.append($0) }
      } else {
        replicaOperationActive = true
      }
    }
    defer {
      if ordersReplica { releaseReplicaOperation() }
    }

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
      guard presentationAuthority == .host else { return }
      guard try await publisher.adopt(next) else { return }
      await output(.presentation(next), token)

    case .selectionChanged(let selection):
      #if DEBUG
        if ProcessInfo.processInfo.environment["GHOSTTEA_SELECTION_TRACE"] == "1" {
          if let selection {
            print(
              "[GhostteaSelection] sink publish (\(selection.anchor.column),\(selection.anchor.row))->(\(selection.focus.column),\(selection.focus.row)) generation=\(token.generation)"
            )
          } else {
            print("[GhostteaSelection] sink publish nil generation=\(token.generation)")
          }
        }
      #endif
      await output(.frame(try await publisher.publish(selection), fullSnapshot: false), token)

    // The lifecycle consumes both before the sink is called; they are listed
    // rather than defaulted so a new state message cannot be silently ignored.
    case .sessionEnded, .hostShutdown:
      break
    }
  }
}
