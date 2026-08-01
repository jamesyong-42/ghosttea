import Foundation

/// What a pane can observe about who holds resize control.
///
/// The three cases are exactly the ones ``GhostteaAttachmentLifecycle``'s
/// `heldControlEpoch` deliberately refuses to collapse: a `nil` epoch means
/// "not ours", which is not the same claim as "nobody's".
public enum GhostteaControlObservation: Equatable, Sendable {
  /// This attachment holds control.
  case selfHolds
  /// Nobody holds control, as of `revision`. A `nil` revision is §4.2.3's
  /// legacy sentinel: a 1.5 authority initialises its revision at 1, so 0
  /// means "this host cannot report revisions" and nothing may
  /// compare-and-swap against it.
  case noController(revision: UInt64?)
  /// Another view holds control.
  case otherHolds
}

/// One claim this pane has already sent, so the funnel can be re-evaluated as
/// often as its inputs change without re-firing (§4.2.3 single-flight).
public struct GhostteaControlReclaimAttempt: Equatable, Sendable {
  public let attachmentGeneration: UInt64
  public let expectedRevision: UInt64?

  public init(attachmentGeneration: UInt64, expectedRevision: UInt64?) {
    self.attachmentGeneration = attachmentGeneration
    self.expectedRevision = expectedRevision
  }
}

public enum GhostteaControlReclaimDecision: Equatable, Sendable {
  /// Send a claim carrying this expectation. `nil` is an unconditional legacy
  /// claim, which is all a 1.4 host understands.
  case claim(expectedRevision: UInt64?)
  /// Conditions are not met yet. Re-evaluate when any input changes.
  case wait
  /// Control is already ours.
  case satisfied
  /// Another view holds control, so this pane does not claim (§4.2.3's
  /// no-fighting rule).
  case stop
}

/// §4.2.3's reclaim funnel, as a pure decision.
///
/// The trigger cannot be a single event: recovery reports the view attached
/// *before* the session reaches Live, so "reclaim when attached" would fire
/// once, too early, and never retry. Every input instead funnels here and this
/// is re-evaluated whenever any of them changes; the single-flight record is
/// what keeps that idempotent rather than chatty.
public enum GhostteaControlReclaim {
  /// - Parameters:
  ///   - attachmentGeneration: Bumped whenever a new attachment reaches Live.
  ///     A resume invalidates this view's controller record, so the claim must
  ///     re-arm per attachment rather than once per session.
  ///   - lastClaim: The most recent claim sent, or `nil` if none.
  public static func decide(
    phase: GhostteaAttachmentPhase,
    readWrite: Bool,
    hasFocus: Bool,
    observation: GhostteaControlObservation,
    attachmentGeneration: UInt64,
    lastClaim: GhostteaControlReclaimAttempt?
  ) -> GhostteaControlReclaimDecision {
    // A claim is a control operation on a live attachment. Sending one while
    // reconnecting would be answered by a host that has not yet seen this
    // attachment, and read-only panes have nothing to claim.
    guard case .live = phase, readWrite else { return .wait }

    switch observation {
    case .selfHolds:
      return .satisfied
    case .otherHolds:
      // Asymmetric on purpose: this ends the reclaim against *this*
      // observation. §4.2.3 still permits a later observation of a cleared
      // controller at a newer revision to be claimed, which the `noController`
      // arm below reaches — "do not retry" forbids re-firing at the same
      // state, not treating a subsequent clear as new information.
      return .stop
    case .noController(let revision):
      // Meaningful focus is a claim precondition, not a general one: a pane
      // that already holds control keeps it without focus, and a pane that
      // will never claim should not be told to wait for focus it does not need.
      guard hasFocus else { return .wait }
      // Single-flight: one claim per (attachment, observed revision). A clear
      // at a *newer* revision is a different observation and may be claimed,
      // which is exactly the cleared-controller retry §4.2.3 allows.
      if let lastClaim,
        lastClaim.attachmentGeneration == attachmentGeneration,
        lastClaim.expectedRevision == revision
      {
        return .wait
      }
      return .claim(expectedRevision: revision)
    }
  }
}
