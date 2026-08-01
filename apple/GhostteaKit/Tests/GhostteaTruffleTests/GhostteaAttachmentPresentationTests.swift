import Testing

@testable import GhostteaTruffle

/// The presenter reads snapshots the lifecycle actor builds, whose memberwise
/// initialisers are internal — hence `@testable`, as the rest of this target
/// already does.
private func presentationSnapshot(
  _ phase: GhostteaAttachmentPhase,
  seq: UInt64,
  exitCode: Int32? = nil,
  readWrite: Bool = true,
  lastContactAgeMs: UInt64? = nil
) -> GhostteaAttachmentSnapshot {
  GhostteaAttachmentSnapshot(
    sessionID: "session-1",
    localViewID: "view-1",
    lifecycleSeq: seq,
    phase: phase,
    exitCode: exitCode,
    readWrite: readWrite,
    negotiatedMinor: 6,
    lastContactAgeMs: lastContactAgeMs)
}

private func presenter() -> GhostteaAttachmentBannerPresenter {
  GhostteaAttachmentBannerPresenter(deviceName: "Studio")
}

/// Live at `t = 0`, so the outages below are recoveries rather than first
/// attaches — the distinction the "lost" copy and the resumed flash both turn on.
private func livePresenter() -> GhostteaAttachmentBannerPresenter {
  var subject = presenter()
  subject.apply(.state(presentationSnapshot(.live, seq: 1)), at: 0)
  return subject
}

// MARK: - Grace window

@Test("No banner inside the two-second grace window")
func graceWindowHidesTheBanner() {
  var subject = livePresenter()
  subject.apply(
    .state(presentationSnapshot(.reconnecting(attempt: 0, nextRetryMs: nil), seq: 2)), at: 10_000)

  #expect(subject.banner(at: 10_000) == nil)
  #expect(subject.banner(at: 11_999) == nil)
  #expect(subject.banner(at: 12_000)?.kind == .reconnecting)
}

@Test("A blip shorter than the grace window shows nothing at all — not even the flash")
func subGraceBlipStaysInvisible() {
  var subject = livePresenter()
  subject.apply(
    .state(presentationSnapshot(.reconnecting(attempt: 0, nextRetryMs: nil), seq: 2)), at: 10_000)
  subject.apply(.state(presentationSnapshot(.synchronizing, seq: 3)), at: 10_300)
  #expect(subject.banner(at: 10_400) == nil)

  subject.apply(.state(presentationSnapshot(.live, seq: 4)), at: 10_500)
  #expect(subject.banner(at: 10_500) == nil)
  #expect(subject.banner(at: 11_000) == nil)
}

@Test("Grace is measured over the whole outage, not restarted by each phase change")
func graceSpansReconnectingAndSynchronizing() {
  var subject = livePresenter()
  subject.apply(
    .state(presentationSnapshot(.reconnecting(attempt: 0, nextRetryMs: nil), seq: 2)), at: 0)
  // A resume that reached Synchronizing at 1.5 s and fell back would restart a
  // per-phase timer and keep the banner hidden through a real outage.
  subject.apply(.state(presentationSnapshot(.synchronizing, seq: 3)), at: 1_500)

  #expect(subject.banner(at: 2_000)?.kind == .synchronizing)
}

// MARK: - Resumed flash

@Test("A visible outage earns a brief resumed acknowledgement")
func visibleOutageFlashesResumed() {
  var subject = livePresenter()
  subject.apply(
    .state(presentationSnapshot(.reconnecting(attempt: 0, nextRetryMs: nil), seq: 2)), at: 0)
  subject.apply(.state(presentationSnapshot(.live, seq: 3)), at: 9_000)

  #expect(subject.banner(at: 9_000)?.kind == .resumed)
  #expect(subject.banner(at: 9_000)?.title == "Reconnected")
  #expect(subject.banner(at: 9_000)?.coolsTerminal == false)
  #expect(subject.banner(at: 11_000) == nil)
}

@Test("The first attach reaching live never claims a reconnection")
func firstAttachDoesNotFlashResumed() {
  var subject = presenter()
  subject.apply(.state(presentationSnapshot(.opening, seq: 1)), at: 0)
  subject.apply(.state(presentationSnapshot(.synchronizing, seq: 2)), at: 5_000)
  subject.apply(.state(presentationSnapshot(.live, seq: 3)), at: 9_000)

  #expect(subject.banner(at: 9_000) == nil)
}

// MARK: - Reconnecting copy

@Test("The first reconnecting event carries no schedule, and the detail says nothing it lacks")
func firstReconnectingEventToleratesMissingBackoffFields() {
  var subject = livePresenter()
  // §12 measured reality: attempt 0 / nextRetryMs nil on the first event.
  subject.apply(
    .state(
      presentationSnapshot(.reconnecting(attempt: 0, nextRetryMs: nil), seq: 2, lastContactAgeMs: 0)
    ),
    at: 0)

  let banner = subject.banner(at: 3_000)
  #expect(banner?.title == "Connection to Studio lost — reconnecting…")
  #expect(banner?.detail == "last contact 3 s ago")
}

@Test("Attempt and countdown appear once the engine has decided a schedule")
func reconnectingDetailCountsDownAndAgesContact() {
  var subject = livePresenter()
  subject.apply(
    .state(
      presentationSnapshot(
        .reconnecting(attempt: 2, nextRetryMs: 4_000), seq: 2, lastContactAgeMs: 8_000)),
    at: 0)

  #expect(
    subject.banner(at: 2_000)?.detail == "last contact 10 s ago · attempt 2 · retrying in 2 s")
  // Both clocks keep running between events rather than freezing at whatever
  // the actor measured when it published.
  #expect(
    subject.banner(at: 3_000)?.detail == "last contact 11 s ago · attempt 2 · retrying in 1 s")
  #expect(subject.banner(at: 4_000)?.detail == "last contact 12 s ago · attempt 2 · retrying now")
}

@Test("A session that was never live is still connecting, not disconnected")
func preFirstLiveReconnectingDoesNotClaimALoss() {
  var subject = presenter()
  subject.apply(.state(presentationSnapshot(.opening, seq: 1)), at: 0)
  subject.apply(
    .state(
      presentationSnapshot(
        .reconnecting(attempt: 1, nextRetryMs: 500), seq: 2, lastContactAgeMs: 700)),
    at: 0)

  let banner = subject.banner(at: 3_000)
  #expect(banner?.title == "Still connecting to Studio…")
  // No "last contact" either: there was never a contact to lose.
  #expect(banner?.detail == "attempt 1 · retrying now")
}

@Test("Opening defers to the scene's own attach progress")
func openingShowsNoBanner() {
  var subject = presenter()
  subject.apply(.state(presentationSnapshot(.opening, seq: 1)), at: 0)

  #expect(subject.banner(at: 60_000) == nil)
}

// MARK: - Suspended

@Test("Suspended states carry the affordance their reason earns")
func suspendedBannersOfferHonestActions() {
  var absent = livePresenter()
  absent.apply(.state(presentationSnapshot(.suspended(.hostAbsent), seq: 2)), at: 0)
  #expect(absent.banner(at: 0)?.title == "Studio is offline")
  #expect(absent.banner(at: 0)?.actions == [.retryNow, .close])

  var backgrounded = livePresenter()
  backgrounded.apply(.state(presentationSnapshot(.suspended(.suspendedByApp), seq: 2)), at: 0)
  #expect(backgrounded.banner(at: 0)?.title == "Paused while Ghosttea was in the background")
  #expect(backgrounded.banner(at: 0)?.actions == [.resume, .close])

  var denied = livePresenter()
  denied.apply(.state(presentationSnapshot(.suspended(.accessDenied), seq: 2)), at: 0)
  #expect(denied.banner(at: 0)?.title == "Studio refused this connection")
  // A redial cannot change a refusal, so no retry is offered.
  #expect(denied.banner(at: 0)?.actions == [.close])
}

/// The §8.2 scene-phase round trip: `suspendForBackground()` publishes
/// `suspended(.suspendedByApp)`, and `resumeFromForeground()` publishes
/// `reconnecting(0, nil)` before the dial it triggers.
@Test("Backgrounding rests visibly; a slow resume gets the standard reconnecting treatment")
func backgroundSuspendThroughSlowForegroundResume() {
  var subject = livePresenter()
  subject.apply(.state(presentationSnapshot(.suspended(.suspendedByApp), seq: 2)), at: 1_000)
  #expect(subject.banner(at: 1_000)?.kind == .suspended)

  subject.apply(
    .state(presentationSnapshot(.reconnecting(attempt: 0, nextRetryMs: nil), seq: 3)), at: 5_000)
  #expect(subject.banner(at: 5_000) == nil)
  #expect(subject.banner(at: 7_000)?.kind == .reconnecting)

  subject.apply(.state(presentationSnapshot(.synchronizing, seq: 4)), at: 7_500)
  #expect(subject.banner(at: 7_500)?.kind == .synchronizing)

  subject.apply(.state(presentationSnapshot(.live, seq: 5)), at: 8_000)
  #expect(subject.banner(at: 8_000)?.kind == .resumed)
}

@Test("A resume that lands within the grace window never flashes anything")
func fastForegroundResumeIsSilent() {
  var subject = livePresenter()
  subject.apply(.state(presentationSnapshot(.suspended(.suspendedByApp), seq: 2)), at: 1_000)
  subject.apply(
    .state(presentationSnapshot(.reconnecting(attempt: 0, nextRetryMs: nil), seq: 3)), at: 5_000)
  subject.apply(.state(presentationSnapshot(.synchronizing, seq: 4)), at: 5_400)
  subject.apply(.state(presentationSnapshot(.live, seq: 5)), at: 5_800)

  #expect(subject.banner(at: 5_800) == nil)
  #expect(subject.banner(at: 6_500) == nil)
}

@Test("Suspended is not graced")
func suspendedShowsImmediately() {
  var subject = livePresenter()
  subject.apply(.state(presentationSnapshot(.suspended(.suspendedByApp), seq: 2)), at: 0)

  #expect(subject.banner(at: 0)?.kind == .suspended)
}

// MARK: - Ended

@Test(
  "Every end reason gets its own sentence",
  arguments: [
    (GhostteaAttachmentEndReason.sessionClosed, "Session closed on Studio."),
    (.sessionUnavailable, "This session is no longer available on Studio."),
    (.hostRestarted, "Session ended — Studio restarted."),
    (.hostShutdown, "Session ended — Studio shut down."),
    (.closedLocally, "Disconnected from Studio."),
  ])
func endedReasonsReadHonestly(reason: GhostteaAttachmentEndReason, expected: String) {
  var subject = livePresenter()
  subject.apply(.state(presentationSnapshot(.ended(reason), seq: 2)), at: 0)

  #expect(subject.banner(at: 0)?.kind == .ended)
  #expect(subject.banner(at: 0)?.title == expected)
}

@Test("An exit code is quoted only when the host reported one")
func exitCodeIsQuotedOnlyWhenKnown() {
  var known = livePresenter()
  known.apply(.state(presentationSnapshot(.ended(.sessionExited), seq: 2, exitCode: 1)), at: 0)
  #expect(known.banner(at: 0)?.title == "Process exited (code 1) on Studio.")

  var unknown = livePresenter()
  unknown.apply(.state(presentationSnapshot(.ended(.sessionExited), seq: 2)), at: 0)
  #expect(unknown.banner(at: 0)?.title == "Process exited on Studio.")
}

@Test("An ended session says the screen is frozen and offers a way out")
func endedBannerExplainsTheFrozenScreen() {
  var subject = livePresenter()
  subject.apply(.state(presentationSnapshot(.ended(.hostRestarted), seq: 2)), at: 0)

  #expect(subject.banner(at: 0)?.detail == "This is a frozen snapshot of the last screen.")
  #expect(subject.banner(at: 0)?.actions == [.browseSessions, .close])
  #expect(subject.banner(at: 0)?.coolsTerminal == true)
}

@Test("Ending inside the grace window is still announced")
func endedIsNotGraced() {
  var subject = livePresenter()
  subject.apply(
    .state(presentationSnapshot(.reconnecting(attempt: 0, nextRetryMs: nil), seq: 2)), at: 0)
  subject.apply(.state(presentationSnapshot(.ended(.hostShutdown), seq: 3)), at: 500)

  #expect(subject.banner(at: 500)?.kind == .ended)
}

// MARK: - Input rejection

@Test("A rejected keystroke is named for the phase it was rejected in")
func inputCueNamesTheRejectingPhase() {
  var subject = livePresenter()
  // The session has moved on to Synchronizing, but the user asked about the
  // keystroke they typed during the outage.
  subject.apply(.state(presentationSnapshot(.synchronizing, seq: 2)), at: 0)
  subject.apply(
    .inputRejected(
      GhostteaAttachmentInputRejection(
        phase: .reconnecting(attempt: 1, nextRetryMs: 500), reason: .notLive)),
    at: 0)

  #expect(subject.inputCue(at: 0)?.text == "Keystrokes are not delivered while reconnecting.")
}

@Test("A read-only rejection explains the permission, not an outage")
func readOnlyRejectionReadsAsPermission() {
  var subject = livePresenter()
  subject.apply(
    .inputRejected(GhostteaAttachmentInputRejection(phase: .live, reason: .readOnly)),
    at: 0)

  #expect(subject.inputCue(at: 0)?.text == "This session is read-only.")
}

@Test("A failed write reads as connectivity, not permission")
func writeFailureReadsAsConnectivity() {
  var subject = livePresenter()
  subject.apply(
    .inputRejected(GhostteaAttachmentInputRejection(phase: .live, reason: .writeFailed)),
    at: 0)

  #expect(subject.inputCue(at: 0)?.text == "Keystroke not delivered — reconnecting.")
}

@Test("A refused resize names control, not connectivity")
func noControlRejectionReadsAsControl() {
  var subject = livePresenter()
  subject.apply(
    .inputRejected(GhostteaAttachmentInputRejection(phase: .live, reason: .noControl)),
    at: 0)

  #expect(subject.inputCue(at: 0)?.text == "Another view controls the terminal size.")
}

@Test("A request outliving its attachment says so")
func attachmentEndedRejectionIsItsOwnSentence() {
  var subject = livePresenter()
  subject.apply(
    .inputRejected(GhostteaAttachmentInputRejection(phase: .live, reason: .attachmentEnded)),
    at: 0)

  #expect(subject.inputCue(at: 0)?.text == "The connection dropped before that finished.")
}

/// §4.4's offline copy never touches the wire, so there is no lifecycle event
/// to carry its feedback — the scene raises the cue itself.
@Test("A scene-raised cue behaves like any other, including expiring")
func sceneRaisedCueIsShownAndExpires() {
  var subject = livePresenter()
  subject.noteCue("Copied the visible screen.", at: 1_000)

  #expect(subject.inputCue(at: 1_000)?.text == "Copied the visible screen.")
  #expect(subject.inputCue(at: 3_000) != nil)
  #expect(subject.inputCue(at: 3_500) == nil)
}

@Test("A rejection raised later replaces a scene cue rather than queueing behind it")
func lifecycleRejectionSupersedesASceneCue() {
  var subject = livePresenter()
  subject.noteCue("Copied the visible screen.", at: 0)
  subject.apply(
    .inputRejected(GhostteaAttachmentInputRejection(phase: .live, reason: .readOnly)),
    at: 500)

  #expect(subject.inputCue(at: 500)?.text == "This session is read-only.")
}

@Test("The dropped-keystroke note is transient")
func inputCueExpires() {
  var subject = livePresenter()
  subject.apply(
    .inputRejected(
      GhostteaAttachmentInputRejection(phase: .ended(.hostShutdown), reason: .notLive)),
    at: 1_000)

  #expect(subject.inputCue(at: 3_000) != nil)
  #expect(subject.inputCue(at: 3_500) == nil)
}

// MARK: - Ordering and refresh

@Test("A late event is discarded rather than re-applied")
func staleLifecycleSequenceIsIgnored() {
  var subject = livePresenter()
  subject.apply(.state(presentationSnapshot(.ended(.hostShutdown), seq: 5)), at: 0)
  // A reconnecting event that lost the race would otherwise un-end the session.
  subject.apply(
    .state(presentationSnapshot(.reconnecting(attempt: 0, nextRetryMs: nil), seq: 4)), at: 0)

  #expect(subject.banner(at: 0)?.kind == .ended)
}

@Test("The scene is told when the presentation would change on its own")
func nextRefreshTracksThePendingDeadline() {
  var subject = livePresenter()
  subject.apply(
    .state(presentationSnapshot(.reconnecting(attempt: 1, nextRetryMs: 5_000), seq: 2)), at: 0)
  // Grace still closed: wake exactly when the banner is due.
  #expect(subject.nextRefreshMs(at: 500) == 1_500)
  // Banner visible: the countdown ticks once a second.
  #expect(subject.nextRefreshMs(at: 3_000) == 1_000)

  subject.apply(.state(presentationSnapshot(.live, seq: 3)), at: 4_000)
  #expect(subject.nextRefreshMs(at: 4_500) == 1_500)
  subject.apply(.state(presentationSnapshot(.live, seq: 4)), at: 8_000)
  #expect(subject.nextRefreshMs(at: 8_000) == nil)
}
