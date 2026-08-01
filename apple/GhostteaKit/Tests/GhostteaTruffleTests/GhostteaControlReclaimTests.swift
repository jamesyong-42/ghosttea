import Testing

@testable import GhostteaTruffle

private func decide(
  phase: GhostteaAttachmentPhase = .live,
  readWrite: Bool = true,
  hasFocus: Bool = true,
  observation: GhostteaControlObservation,
  attachmentGeneration: UInt64 = 1,
  lastClaim: GhostteaControlReclaimAttempt? = nil
) -> GhostteaControlReclaimDecision {
  GhostteaControlReclaim.decide(
    phase: phase,
    readWrite: readWrite,
    hasFocus: hasFocus,
    observation: observation,
    attachmentGeneration: attachmentGeneration,
    lastClaim: lastClaim)
}

@Test("An uncontrolled session is claimed with the revision that was observed")
func claimsAgainstTheObservedRevision() {
  #expect(decide(observation: .noController(revision: 17)) == .claim(expectedRevision: 17))
}

@Test("A legacy host is claimed unconditionally, because it cannot compare and swap")
func legacyHostGetsAnUnconditionalClaim() {
  #expect(decide(observation: .noController(revision: nil)) == .claim(expectedRevision: nil))
}

@Test("A pane that already holds control does not re-claim")
func selfHeldControlIsSatisfied() {
  #expect(decide(observation: .selfHolds) == .satisfied)
}

@Test("Another view holding control stops the reclaim rather than fighting for it")
func otherHeldControlStops() {
  #expect(decide(observation: .otherHolds) == .stop)
}

// MARK: - Preconditions

@Test(
  "A claim is only sent from Live",
  arguments: [
    GhostteaAttachmentPhase.opening,
    .synchronizing,
    .reconnecting(attempt: 1, nextRetryMs: 500),
    .suspended(.hostAbsent),
    .ended(.hostShutdown),
  ])
func nonLivePhasesWait(phase: GhostteaAttachmentPhase) {
  #expect(decide(phase: phase, observation: .noController(revision: 3)) == .wait)
}

@Test("A read-only pane has nothing to claim")
func readOnlyWaits() {
  #expect(decide(readWrite: false, observation: .noController(revision: 3)) == .wait)
}

@Test("Claiming requires meaningful focus; holding control does not")
func focusGatesTheClaimButNotTheHold() {
  #expect(decide(hasFocus: false, observation: .noController(revision: 3)) == .wait)
  // A backgrounded-but-controlling pane must not be told it has work to do.
  #expect(decide(hasFocus: false, observation: .selfHolds) == .satisfied)
}

// MARK: - Single-flight and the cleared-controller retry

@Test("The same observation is not claimed twice")
func singleFlightPerObservation() {
  let sent = GhostteaControlReclaimAttempt(attachmentGeneration: 4, expectedRevision: 17)
  #expect(
    decide(
      observation: .noController(revision: 17), attachmentGeneration: 4, lastClaim: sent) == .wait)
}

@Test("A controller cleared at a newer revision is claimed again")
func clearedControllerRetriesWithTheNewRevision() {
  let sent = GhostteaControlReclaimAttempt(attachmentGeneration: 4, expectedRevision: 17)
  #expect(
    decide(observation: .noController(revision: 19), attachmentGeneration: 4, lastClaim: sent)
      == .claim(expectedRevision: 19))
}

/// The regression the review found: a resume invalidates this view's controller
/// record, so a claim armed once per session never re-fires and the focused
/// pane silently loses control after every reconnect.
@Test("A new attachment re-arms the claim even at an unchanged revision")
func newAttachmentGenerationReArmsTheClaim() {
  let sent = GhostteaControlReclaimAttempt(attachmentGeneration: 4, expectedRevision: 17)
  #expect(
    decide(observation: .noController(revision: 17), attachmentGeneration: 5, lastClaim: sent)
      == .claim(expectedRevision: 17))
}

@Test("A legacy host is claimed once per attachment, not once per evaluation")
func legacySingleFlightHoldsWithinAnAttachment() {
  let sent = GhostteaControlReclaimAttempt(attachmentGeneration: 2, expectedRevision: nil)
  #expect(
    decide(observation: .noController(revision: nil), attachmentGeneration: 2, lastClaim: sent)
      == .wait)
  #expect(
    decide(observation: .noController(revision: nil), attachmentGeneration: 3, lastClaim: sent)
      == .claim(expectedRevision: nil))
}
