import Foundation
import Testing
import Truffle

@testable import GhostteaTruffle

// MARK: - Wire shapes (scripted against the Rust contract, not a live host)

@Test func compactControlStateCarriesTheRevisionedTupleAndACleardController() throws {
  let withController = try GhostteaTerminalStateCodec.decode(
    Data(#"{"cs":[["r:pane-1",4],17,100,30,2]}"#.utf8), codec: .compactJSONV1)
  guard
    case .controlState(let controller, let revision, let cols, let rows, let layout) =
      withController
  else {
    Issue.record("expected control-state")
    return
  }
  #expect(controller == GhostteaControllerInfo(controllerViewID: "r:pane-1", controlEpoch: 4))
  #expect(revision == 17)
  #expect(cols == 100)
  #expect(rows == 30)
  #expect(layout == 2)

  let cleared = try GhostteaTerminalStateCodec.decode(
    Data(#"{"cs":[null,18,100,30,2]}"#.utf8), codec: .compactJSONV1)
  #expect(cleared == .controlState(controller: nil, controlRevision: 18, cols: 100, rows: 30, layoutEpoch: 2))
}

@Test func compactSessionEndAndHostShutdownMatchTheRustTuples() throws {
  #expect(
    try GhostteaTerminalStateCodec.decode(
      Data(#"{"se":["exited",3]}"#.utf8), codec: .compactJSONV1) == .sessionEnded(.exited(code: 3)))
  #expect(
    try GhostteaTerminalStateCodec.decode(
      Data(#"{"se":["exited",null]}"#.utf8), codec: .compactJSONV1)
      == .sessionEnded(.exited(code: nil)))
  #expect(
    try GhostteaTerminalStateCodec.decode(
      Data(#"{"se":["closed",null]}"#.utf8), codec: .compactJSONV1) == .sessionEnded(.closed))
  #expect(
    try GhostteaTerminalStateCodec.decode(Data(#"{"hs":[]}"#.utf8), codec: .compactJSONV1)
      == .hostShutdown)

  // A closed session carrying an exit code is a contradiction, and a widened
  // tuple is the exact failure new tags exist to avoid.
  for malformed in [
    #"{"se":["closed",7]}"#, #"{"se":["vanished",null]}"#, #"{"se":["exited"]}"#,
    #"{"hs":[1]}"#, #"{"cs":[["r:pane-1",4],17,100,30]}"#,
    #"{"cs":[["r:pane-1",4],17,100,30,2,9]}"#,
  ] {
    #expect(throws: (any Error).self) {
      try GhostteaTerminalStateCodec.decode(Data(malformed.utf8), codec: .compactJSONV1)
    }
  }
}

@Test func theLegacyControlChangedTagKeepsDecodingUnchanged() throws {
  let legacy = try GhostteaTerminalStateCodec.decode(
    Data(#"{"c":["desktop-view",12,120,40,4]}"#.utf8), codec: .compactJSONV1)
  #expect(
    legacy
      == .controlChanged(
        controllerViewID: "desktop-view", controlEpoch: 12, cols: 120, rows: 40, layoutEpoch: 4))
}

@Test func attachViewCarriesTheGenerationAndResumeHintInDesktopShape() throws {
  let attach = GhostteaSessionControlMessage.attachView(
    requestID: "request-1", sessionID: "session-1", viewID: "r:pane-1", accessToken: nil,
    cols: 100, rows: 30, attachGeneration: 4,
    resume: GhostteaResumeHint(
      previousSessionEpoch: 7, previousAttachmentEpoch: 11, previousTerminalRevision: 42),
    wantsState: true)
  let object = try #require(
    JSONSerialization.jsonObject(with: JSONEncoder().encode(attach)) as? [String: Any])
  #expect(object["attachGeneration"] as? Int == 4)
  #expect(object["wantsState"] as? Bool == true)
  let resume = try #require(object["resume"] as? [String: Any])
  #expect(resume["previousSessionEpoch"] as? Int == 7)
  #expect(resume["previousAttachmentEpoch"] as? Int == 11)
  #expect(resume["previousTerminalRevision"] as? Int == 42)
}

@Test func viewAttachedFromALegacyHostDecodesWithoutTheReconnectFields() throws {
  let legacy = Data(
    #"""
    {"type":"view-attached","requestId":"r","sessionEpoch":7,"layoutEpoch":3,
     "attachmentEpoch":11,"cols":100,"rows":30,"readWrite":true}
    """#.utf8)
  let message = try JSONDecoder().decode(GhostteaSessionControlMessage.self, from: legacy)
  guard
    case .viewAttached(_, _, _, _, _, _, _, _, let resumed, let controller, let revision) = message
  else {
    Issue.record("expected view-attached")
    return
  }
  #expect(resumed == false)
  #expect(controller == nil)
  // Zero is the "legacy host, controller state unknown" sentinel, never a
  // compare-and-swappable observation.
  #expect(revision == 0)
}

@Test func attachRejectionsFollowTheCodeActionTableAndUnknownIsAmbiguous() throws {
  let unknown = try JSONDecoder().decode(
    GhostteaSessionControlMessage.self,
    from: Data(
      #"{"type":"attach-rejected","requestId":"r","code":"from-the-future","retryable":true}"#.utf8)
  )
  guard case .attachRejected(_, let code, let retryable) = unknown else {
    Issue.record("expected attach-rejected")
    return
  }
  #expect(code == .unknown)
  #expect(retryable == true)
  // Advisory only: an unrecognised code takes the ambiguous path whatever the
  // host claims about retrying.
  #expect(GhostteaAttachRejectAction(code: code) == .retry)

  #expect(GhostteaAttachRejectAction(code: .staleResume) == .discard)
  #expect(GhostteaAttachRejectAction(code: .viewInvalid) == .retry)
  #expect(GhostteaAttachRejectAction(code: .viewLimit) == .retry)
  #expect(GhostteaAttachRejectAction(code: .unknownSession) == .end(.sessionUnavailable))
  #expect(GhostteaAttachRejectAction(code: .sessionEpochMismatch) == .end(.hostRestarted))
  #expect(GhostteaAttachRejectAction(code: .accessDenied) == .rest(.accessDenied))
}

@Test func wireViewIdentityMatchesTheRustEncoding() {
  #expect(GhostteaWireViewIdentity.stable("pane-1") == "r:pane-1")
  #expect(GhostteaWireViewIdentity.rotated("pane-1", generation: 1) == "r:pane-1#g1")
  #expect(GhostteaWireViewIdentity.rotated("pane-1", generation: 4) == "r:pane-1#g4")

  let widest = GhostteaWireViewIdentity.rotated(
    String(repeating: "v", count: GhostteaWireViewIdentity.maximumInlineLocalViewIDBytes),
    generation: UInt64.max)
  #expect(widest.hasPrefix("r:"))
  #expect(widest.utf8.count <= 128)

  let long = String(repeating: "v", count: 200)
  let hashed = GhostteaWireViewIdentity.rotated(long, generation: 2)
  #expect(hashed.hasPrefix("h:"))
  let digest = try? #require(hashed.dropFirst(2).split(separator: "#").first)
  #expect(digest?.count == 32)
  #expect(hashed.utf8.count <= 128)
  // The namespaces stay disjoint: a short local id equal to another id's hash
  // must not produce the same base.
  #expect(GhostteaWireViewIdentity.stable(String(digest ?? "")) != "h:\(digest ?? "")")

  #expect(GhostteaWireViewIdentity.localViewID(fromWire: "r:pane-1#g4") == "pane-1")
  #expect(GhostteaWireViewIdentity.localViewID(fromWire: "r:pane-1") == "pane-1")
  #expect(GhostteaWireViewIdentity.localViewID(fromWire: "h:0011#g2") == nil)
}

@Test func backoffIsFullJitterWithTheDocumentedFloorAndCap() {
  let config = GhostteaReconnectConfig()
  // The floor wins over a sampler that returns nothing, so no schedule can
  // become a hot loop.
  #expect(GhostteaBackoff.delayMs(config, attempt: 0, jitter: { _ in 0 }) == 250)
  #expect(GhostteaBackoff.delayMs(config, attempt: 0, jitter: { $0 }) == 500)
  #expect(GhostteaBackoff.delayMs(config, attempt: 1, jitter: { $0 }) == 1_000)
  #expect(GhostteaBackoff.delayMs(config, attempt: 4, jitter: { $0 }) == 8_000)
  // The window doubles to the cap and stops there, however long the outage runs.
  #expect(GhostteaBackoff.delayMs(config, attempt: 5, jitter: { $0 }) == 10_000)
  #expect(GhostteaBackoff.delayMs(config, attempt: 60, jitter: { $0 }) == 10_000)
  // A sampler that overshoots its window is clamped, never trusted.
  #expect(GhostteaBackoff.delayMs(config, attempt: 0, jitter: { _ in .max }) == 500)
}

@Test func reconnectDefaultsAreTheDocumentedTimings() {
  // The Rust side pins these same numbers by parsing
  // GhostteaReconnectConstants.swift; this end fails first if the Swift value
  // moves without the Rust one.
  #expect(GhostteaReconnectDefaults.heartbeatIdleMs == 3_000)
  #expect(GhostteaReconnectDefaults.heartbeatFailMs == 6_000)
  #expect(GhostteaReconnectDefaults.backoffBaseMs == 500)
  #expect(GhostteaReconnectDefaults.backoffCapMs == 10_000)
  #expect(GhostteaReconnectDefaults.backoffFloorMs == 250)
  #expect(GhostteaReconnectDefaults.suspendAfterMs == 600_000)
  #expect(GhostteaReconnectDefaults.synchronizeTimeoutMs == 10_000)
  #expect(GhostteaReconnectDefaults.remoteReconnectProtocolMinor == 6)
  #expect(UInt64(GhostteaTruffleContract.protocolMinor) == 6)
}

// MARK: - Controller revision rule (§4.2.3)

@Test func aRevisionedAnnouncementOlderThanTheCachedOneIsDroppedWhole() async {
  let lifecycle = makeLifecycle(dialer: ScriptedDialer())
  await lifecycle.applyController(
    GhostteaControllerInfo(controllerViewID: "r:pane-2", controlEpoch: 9), revision: 17)
  // Keeping the payload while raising the revision would manufacture "nobody
  // holds control, as of the newest revision" — an empty seat that never
  // existed, which a reclaim would take from the real holder.
  await lifecycle.applyController(nil, revision: 16)
  var state = await lifecycle.currentControlState
  #expect(state.controller?.controllerViewID == "r:pane-2")
  #expect(state.revision == 17)

  // A legacy frame carries no revision and cannot be ordered; it stays
  // last-write-wins without pretending to a newer revision.
  await lifecycle.applyController(
    GhostteaControllerInfo(controllerViewID: "r:pane-3", controlEpoch: 1), revision: 0)
  state = await lifecycle.currentControlState
  #expect(state.controller?.controllerViewID == "r:pane-3")
  #expect(state.revision == 17)

  await lifecycle.applyController(nil, revision: 18)
  state = await lifecycle.currentControlState
  #expect(state.controller == nil)
  #expect(state.revision == 18)
}

// MARK: - Lifecycle over a scripted peer

@Test func liveIsReachedOnlyAfterTheSnapshotApplies() async {
  let dialer = ScriptedDialer()
  let sink = RecordingSink()
  let lifecycle = makeLifecycle(dialer: dialer, sink: sink)
  let recorder = await PhaseRecorder.watching(lifecycle)
  await lifecycle.start()

  let peer = await dialer.nextPeer()
  try? await peer.completeHandshake(minor: 6)
  let attach = try? await peer.readAttach()
  #expect(attach?.wireViewID == "r:pane-1")
  try? await peer.acceptAttach(attach)

  let synchronizing = await recorder.wait { $0.phase == .synchronizing }
  #expect(synchronizing != nil)
  // Attach completion is not recovery: the host sends ViewAttached before it
  // has published any state.
  #expect(await sink.applied.isEmpty)
  #expect(await recorder.sawLive == false)

  try? await peer.writeState(snapshotJSON(terminalRevision: 42))
  let live = await recorder.wait { $0.phase == .live }
  #expect(live != nil)
  #expect(await sink.applied.count == 1)
  await lifecycle.close()
}

@Test func inputOutsideLiveIsRejectedAndNeverReachesTheHostLater() async {
  let dialer = ScriptedDialer()
  let lifecycle = makeLifecycle(dialer: dialer)
  let recorder = await PhaseRecorder.watching(lifecycle)
  await lifecycle.start()

  let peer = await dialer.nextPeer()
  try? await peer.completeHandshake(minor: 6)
  let attach = try? await peer.readAttach()
  try? await peer.acceptAttach(attach)
  _ = await recorder.wait { $0.phase == .synchronizing }

  var rejected = false
  do {
    try await lifecycle.send(.text("rm -rf tmp\n"))
  } catch let rejection as GhostteaAttachmentInputRejection {
    rejected = true
    #expect(rejection.reason == .notLive)
    #expect(rejection.phase == .synchronizing)
  } catch {
    Issue.record("unexpected error \(error)")
  }
  #expect(rejected)
  #expect(await recorder.rejectionCount(settlingAt: 1) == 1)
  // Losing focus is the one cosmetic drop the design allows, and it is silent.
  try? await lifecycle.send(.focus(false))
  #expect(await recorder.rejectionCount(settlingAt: 2) == 1)

  try? await peer.writeState(snapshotJSON(terminalRevision: 1))
  _ = await recorder.wait { $0.phase == .live }
  try? await lifecycle.send(.text("echo safe\n"))

  // The queue is what would have replayed the discarded keystroke here; there
  // is none, so the host only ever sees what was typed against a live screen.
  let firstInput = await nextControl(peer)
  if case .input(_, _, _, let operation) = firstInput {
    #expect(operation == .text("echo safe\n"))
  } else {
    Issue.record("expected the post-recovery input, got \(String(describing: firstInput))")
  }
  await lifecycle.close()
}

@Test func aMinorSixHostGetsAStableIdentityAnAdvancingGenerationAndAResumeHint() async {
  let dialer = ScriptedDialer()
  let clock = ManualClock()
  let lifecycle = makeLifecycle(dialer: dialer, clock: clock)
  let recorder = await PhaseRecorder.watching(lifecycle)
  await lifecycle.start()

  let first = await dialer.nextPeer()
  try? await first.completeHandshake(minor: 6)
  let firstAttach = try? await first.readAttach()
  #expect(firstAttach?.wireViewID == "r:pane-1")
  // Monotonic from the very first attempt: a timed-out initial attach that
  // reached the host leaves the same collision a resume would.
  #expect(firstAttach?.attachGeneration == 1)
  #expect(firstAttach?.resume == nil)
  try? await first.acceptAttach(firstAttach, sessionEpoch: 7, attachmentEpoch: 11)
  try? await first.writeState(snapshotJSON(terminalRevision: 42))
  _ = await recorder.wait { $0.phase == .live }

  await first.close()
  _ = await recorder.wait {
    if case .reconnecting = $0.phase { return true }
    return false
  }
  await clock.advance(250)

  let second = await dialer.nextPeer()
  try? await second.completeHandshake(minor: 6)
  let secondAttach = try? await second.readAttach()
  // The identity is stable because takeover mints a fresh epoch for it; the
  // generation is what orders the attempts.
  #expect(secondAttach?.wireViewID == "r:pane-1")
  #expect(secondAttach?.attachGeneration == 2)
  #expect(
    secondAttach?.resume
      == GhostteaResumeHint(
        previousSessionEpoch: 7, previousAttachmentEpoch: 11, previousTerminalRevision: 42))
  await lifecycle.close()
}

@Test func aLegacyHostGetsARotatedWireIdAndNoGenerationOrResume() async {
  let dialer = ScriptedDialer()
  let clock = ManualClock()
  let lifecycle = makeLifecycle(dialer: dialer, clock: clock)
  let recorder = await PhaseRecorder.watching(lifecycle)
  await lifecycle.start()

  let first = await dialer.nextPeer()
  try? await first.completeHandshake(minor: 5)
  let firstAttach = try? await first.readAttach()
  #expect(firstAttach?.wireViewID == "r:pane-1#g1")
  // Zero is the legacy declaration: a rotating client must not claim a lineage
  // the host would order against, and a host that sees it takes the plain
  // attach path.
  #expect(firstAttach?.attachGeneration == 0)
  #expect(firstAttach?.resume == nil)
  try? await first.acceptAttach(firstAttach)
  try? await first.writeState(snapshotJSON(terminalRevision: 3))
  let live = await recorder.wait { $0.phase == .live }
  #expect(live?.negotiatedMinor == 5)

  await first.close()
  _ = await recorder.wait {
    if case .reconnecting = $0.phase { return true }
    return false
  }
  await clock.advance(250)

  let second = await dialer.nextPeer()
  try? await second.completeHandshake(minor: 5)
  let secondAttach = try? await second.readAttach()
  #expect(secondAttach?.wireViewID == "r:pane-1#g2")
  #expect(secondAttach?.attachGeneration == 0)
  await lifecycle.close()
}

@Test func theHeartbeatPingsOnlyAfterIdleAndAMatchedPongKeepsTheConnection() async {
  let dialer = ScriptedDialer()
  let clock = ManualClock()
  let lifecycle = makeLifecycle(dialer: dialer, clock: clock)
  let recorder = await PhaseRecorder.watching(lifecycle)
  await lifecycle.start()
  let peer = await dialer.nextPeer()
  try? await peer.goLive(snapshot: snapshotJSON(terminalRevision: 1), minor: 6)
  _ = await recorder.wait { $0.phase == .live }

  // Nothing is sent while the idle window has not elapsed.
  await clock.advance(1_000)
  #expect(await peer.pendingControlCount == 0)

  await clock.advance(2_000)
  guard case .ping(let nonce)? = await nextControl(peer) else {
    Issue.record("expected a ping after the idle window")
    return
  }
  #expect(nonce == 1)
  try? await peer.writeControl(.pong(nonce: nonce))
  #expect(await awaitContactRefresh(lifecycle))

  // The pong refreshed contact, so the fail deadline moved with it: three more
  // idle seconds produce another probe rather than a teardown.
  await clock.advance(3_000)
  guard case .ping(let second)? = await nextControl(peer) else {
    Issue.record("expected a second ping rather than a teardown")
    return
  }
  #expect(second == 2)
  #expect(await recorder.phases.contains { if case .reconnecting = $0 { return true } else { return false } } == false)
  await lifecycle.close()
}

@Test func theActorAcknowledgesEachAppliedFrameOnTheSinksBehalf() async {
  let dialer = ScriptedDialer()
  let sink = RecordingSink()
  let lifecycle = makeLifecycle(dialer: dialer, sink: sink)
  let recorder = await PhaseRecorder.watching(lifecycle)
  await lifecycle.start()
  let peer = await dialer.nextPeer()
  try? await peer.goLive(snapshot: snapshotJSON(terminalRevision: 42), minor: 6)
  _ = await recorder.wait { $0.phase == .live }

  // The sink never acks; returning from apply is the trigger, and the frame's
  // own coordinates are what goes on the wire.
  guard
    case .stateAck(let sessionEpoch, let layoutEpoch, let patchSequence, let revision)? =
      await nextAcknowledgement(peer)
  else {
    Issue.record("expected the snapshot acknowledgement")
    return
  }
  #expect(sessionEpoch == 7)
  #expect(layoutEpoch == 3)
  #expect(patchSequence == 0)
  #expect(revision == 42)

  try? await peer.writeState(patchJSON())
  guard case .stateAck(_, _, let patchAck, let patchRevision)? = await nextAcknowledgement(peer)
  else {
    Issue.record("expected the patch acknowledgement")
    return
  }
  #expect(patchAck == 1)
  #expect(patchRevision == 43)
  #expect(await sink.applied.count == 2)
  await lifecycle.close()
}

@Test func aSinkThatNeedsASnapshotGetsOneAndTheRejectedFrameIsNotAcknowledged() async {
  let dialer = ScriptedDialer()
  let sink = RecordingSink()
  let lifecycle = makeLifecycle(dialer: dialer, sink: sink)
  let recorder = await PhaseRecorder.watching(lifecycle)
  await lifecycle.start()
  let peer = await dialer.nextPeer()
  try? await peer.goLive(snapshot: snapshotJSON(terminalRevision: 42), minor: 6)
  _ = await recorder.wait { $0.phase == .live }
  _ = await nextAcknowledgement(peer)

  await sink.refuseNext(.needsSnapshot)
  try? await peer.writeState(patchJSON())

  // A discontinuity asks for an authoritative snapshot; it never acknowledges
  // the patch it could not apply, and it never tears the session down.
  guard case .requestSnapshot? = await nextControl(peer) else {
    Issue.record("expected a snapshot request")
    return
  }
  #expect(await peer.pendingAcknowledgementCount == 0)
  #expect(await lifecycle.currentSnapshot.phase == .live)
  await lifecycle.close()
}

@Test func selectionTextResolvesWithTheHostsAnswerAndFailsWithItsAttachment() async {
  let dialer = ScriptedDialer()
  let lifecycle = makeLifecycle(dialer: dialer)
  let recorder = await PhaseRecorder.watching(lifecycle)
  await lifecycle.start()
  let peer = await dialer.nextPeer()
  try? await peer.goLive(snapshot: snapshotJSON(terminalRevision: 1), minor: 6)
  _ = await recorder.wait { $0.phase == .live }
  _ = await nextAcknowledgement(peer)

  // Awaited through a box rather than inline: a breakage that drops the answer
  // has to fail this test, not park it on a continuation forever.
  let copied = SelectionBox()
  await copied.run { try await lifecycle.selectionText(GhostteaSelectionRequest(selectAll: true)) }
  guard
    case .selectionText(let requestID, _, let epoch, _, _, _, _, let selectAll)? =
      await nextControl(peer)
  else {
    Issue.record("expected a selection request")
    return
  }
  #expect(epoch == 11)
  #expect(selectAll)
  try? await peer.writeControl(.selectionTextResult(requestID: requestID, text: "shared output"))
  #expect(await copied.settledText() == "shared output")

  // A request that outlives its attachment is released by the teardown rather
  // than parked on a continuation nothing will ever resume.
  let orphaned = SelectionBox()
  await orphaned.run { try await lifecycle.selectionText(GhostteaSelectionRequest(selectAll: true)) }
  _ = await nextControl(peer)
  await peer.close()
  #expect(await orphaned.settledReason() == .attachmentEnded)
}

@Test func controlClaimsAndResizesCarryTheFencedEpochsOrAreRefused() async {
  let dialer = ScriptedDialer()
  let lifecycle = makeLifecycle(dialer: dialer)
  let recorder = await PhaseRecorder.watching(lifecycle)
  await lifecycle.start()

  // Outside Live both refuse for the same reason input does — there is no
  // attachment to stamp an epoch from.
  await #expect(throws: GhostteaAttachmentControlRejection.self) {
    try await lifecycle.claimControl(cols: 100, rows: 30)
  }

  let peer = await dialer.nextPeer()
  try? await peer.goLive(snapshot: snapshotJSON(terminalRevision: 1), minor: 6)
  _ = await recorder.wait { $0.phase == .live }
  _ = await nextAcknowledgement(peer)

  // A resize before control is held is refused locally rather than sent for
  // the host to reject.
  #expect(await lifecycle.heldControlEpoch == nil)
  var refusal: GhostteaAttachmentControlRejection.Reason?
  do { try await lifecycle.resize(cols: 120, rows: 40) } catch
    let rejection as GhostteaAttachmentControlRejection
  {
    refusal = rejection.reason
  } catch {}
  #expect(refusal == .noControl)

  try? await lifecycle.claimControl(cols: 120, rows: 40)
  guard
    case .focusAndResize(let viewID, let epoch, let cols, let rows, _, _)? = await nextControl(peer)
  else {
    Issue.record("expected a control claim")
    return
  }
  #expect(viewID == "r:pane-1")
  #expect(epoch == 11)
  #expect(cols == 120 && rows == 40)

  // Control held by *another* view is not this pane's to resize with. The
  // epoch belongs to whoever the host named, so a pane that reads it as its
  // own would resize with an epoch the host will reject — or worse, one it
  // will accept for a claim this pane never made.
  try? await peer.writeState(#"{"cs":[["r:other-pane",9],2,120,40,1]}"#)
  _ = await poll { await lifecycle.currentControlState.revision == 2 ? true : nil }
  #expect(await lifecycle.heldControlEpoch == nil)
  var borrowed: GhostteaAttachmentControlRejection.Reason?
  do { try await lifecycle.resize(cols: 132, rows: 44) } catch
    let rejection as GhostteaAttachmentControlRejection
  {
    borrowed = rejection.reason
  } catch {}
  #expect(borrowed == .noControl)

  // The host grants control to this pane's wire identity; only then does a
  // resize go out, carrying the granted control epoch.
  try? await peer.writeState(#"{"cs":[["r:pane-1",4],3,120,40,1]}"#)
  _ = await poll { await lifecycle.heldControlEpoch }
  #expect(await lifecycle.heldControlEpoch == 4)
  try? await lifecycle.resize(cols: 132, rows: 44)
  guard
    case .resize(_, let resizeEpoch, let controlEpoch, _, let newCols, let newRows)? =
      await nextControl(peer)
  else {
    Issue.record("expected a resize")
    return
  }
  #expect(resizeEpoch == 11)
  #expect(controlEpoch == 4)
  #expect(newCols == 132 && newRows == 44)
  await lifecycle.close()
}

@Test func aLegacyHostIsNeverProbed() async {
  let dialer = ScriptedDialer()
  let clock = ManualClock()
  let lifecycle = makeLifecycle(dialer: dialer, clock: clock)
  let recorder = await PhaseRecorder.watching(lifecycle)
  await lifecycle.start()
  let peer = await dialer.nextPeer()
  try? await peer.goLive(snapshot: snapshotJSON(terminalRevision: 1), minor: 5)
  let live = await recorder.wait { $0.phase == .live }
  #expect(live?.negotiatedMinor == 5)

  // A Ping below the reconnect minor is not ignored by the host — it reaches
  // the catch-all and closes the connection. Probing here would manufacture
  // the outage the probe exists to detect, so nothing is scheduled at all.
  #expect(await clock.settledSleeperCount() == 0)
  await clock.advance(30_000, sleepers: 0)
  // The snapshot's acknowledgement is expected and lives on its own queue;
  // what must not appear is a probe.
  #expect(await peer.pendingControlCount == 0)
  #expect(await lifecycle.currentSnapshot.phase == .live)
  await lifecycle.close()
}

@Test func silencePastTheFailWindowTearsTheConnectionDown() async {
  let dialer = ScriptedDialer()
  let clock = ManualClock()
  let lifecycle = makeLifecycle(dialer: dialer, clock: clock)
  let recorder = await PhaseRecorder.watching(lifecycle)
  await lifecycle.start()
  let peer = await dialer.nextPeer()
  try? await peer.goLive(snapshot: snapshotJSON(terminalRevision: 1), minor: 6)
  _ = await recorder.wait { $0.phase == .live }

  await clock.advance(3_000)
  _ = await nextControl(peer)  // the probe nobody answers
  await clock.advance(3_000)

  let reconnecting = await recorder.wait {
    if case .reconnecting = $0.phase { return true }
    return false
  }
  #expect(reconnecting != nil)
  // The first event after a drop carries no countdown: the engine has not
  // decided one yet.
  #expect(reconnecting?.phase == .reconnecting(attempt: 0, nextRetryMs: nil))
  await lifecycle.close()
}

@Test func stateTrafficOnTheCurrentIncarnationRefreshesContact() async {
  let dialer = ScriptedDialer()
  let clock = ManualClock()
  let lifecycle = makeLifecycle(dialer: dialer, clock: clock)
  let recorder = await PhaseRecorder.watching(lifecycle)
  await lifecycle.start()
  let peer = await dialer.nextPeer()
  try? await peer.goLive(snapshot: snapshotJSON(terminalRevision: 1), minor: 6)
  _ = await recorder.wait { $0.phase == .live }

  // A busy stream never pings: contact is state traffic or a matched pong.
  for _ in 0..<4 {
    await clock.advance(2_000)
    try? await peer.writeState(patchJSON())
    #expect(await awaitContactRefresh(lifecycle))
  }
  #expect(await peer.pendingControlCount == 0)
  #expect(await recorder.sawLive)
  await lifecycle.close()
}

@Test func anUnsolicitedPongRefreshesNothing() async {
  let dialer = ScriptedDialer()
  let clock = ManualClock()
  let lifecycle = makeLifecycle(dialer: dialer, clock: clock)
  let recorder = await PhaseRecorder.watching(lifecycle)
  await lifecycle.start()
  let peer = await dialer.nextPeer()
  try? await peer.goLive(snapshot: snapshotJSON(terminalRevision: 1), minor: 6)
  _ = await recorder.wait { $0.phase == .live }

  await clock.advance(3_000)
  _ = await nextControl(peer)
  // Answering a ping nobody sent proves nothing about the host being there.
  try? await peer.writeControl(.pong(nonce: 99))
  await clock.advance(3_000)

  let reconnecting = await recorder.wait {
    if case .reconnecting = $0.phase { return true }
    return false
  }
  #expect(reconnecting != nil)
  await lifecycle.close()
}

@Test func theFenceDropsFramesFromASupersededGenerationOrIncarnation() async {
  let dialer = ScriptedDialer()
  let lifecycle = makeLifecycle(dialer: dialer)
  let recorder = await PhaseRecorder.watching(lifecycle)
  await lifecycle.start()
  let peer = await dialer.nextPeer()
  try? await peer.goLive(snapshot: snapshotJSON(terminalRevision: 1), minor: 6)
  _ = await recorder.wait { $0.phase == .live }

  let current = await lifecycle.fencingState
  #expect(await lifecycle.admitState(generation: current.generation, incarnation: current.incarnation))
  // The generation alone is not enough: attaching again rebinds the
  // incarnation without advancing the generation, so a reader from a replaced
  // connection would still match on generation — and would then refresh the
  // contact clock on behalf of the connection that replaced it.
  #expect(
    await lifecycle.admitState(
      generation: current.generation, incarnation: current.incarnation &- 1) == false)
  #expect(
    await lifecycle.admitState(
      generation: current.generation &- 1, incarnation: current.incarnation) == false)
  await lifecycle.close()
}

@Test func aSessionEndedFrameEndsWithItsOwnReasonAndExitCode() async {
  let dialer = ScriptedDialer()
  let lifecycle = makeLifecycle(dialer: dialer)
  let recorder = await PhaseRecorder.watching(lifecycle)
  await lifecycle.start()
  let peer = await dialer.nextPeer()
  try? await peer.goLive(snapshot: snapshotJSON(terminalRevision: 1), minor: 6)
  _ = await recorder.wait { $0.phase == .live }

  try? await peer.writeState(#"{"se":["exited",7]}"#)
  let ended = await recorder.wait { $0.phase == .ended(.sessionExited) }
  #expect(ended != nil)
  #expect(ended?.exitCode == 7)
  #expect(await dialer.dialCount == 1)
}

@Test func aHostShutdownFrameEndsAsHostShutdownRatherThanRestarted() async {
  let dialer = ScriptedDialer()
  let lifecycle = makeLifecycle(dialer: dialer)
  let recorder = await PhaseRecorder.watching(lifecycle)
  await lifecycle.start()
  let peer = await dialer.nextPeer()
  try? await peer.goLive(snapshot: snapshotJSON(terminalRevision: 1), minor: 6)
  _ = await recorder.wait { $0.phase == .live }

  try? await peer.writeState(#"{"hs":[]}"#)
  // A polite goodbye is a shutdown; host-restarted is reserved for a host that
  // vanished without a word.
  #expect(await recorder.wait { $0.phase == .ended(.hostShutdown) } != nil)
}

@Test func aDifferentHostInstanceEndsAsHostRestartedWithoutRetrying() async {
  let dialer = ScriptedDialer()
  let clock = ManualClock()
  let lifecycle = makeLifecycle(dialer: dialer, clock: clock)
  let recorder = await PhaseRecorder.watching(lifecycle)
  await lifecycle.start()

  let first = await dialer.nextPeer()
  try? await first.goLive(snapshot: snapshotJSON(terminalRevision: 1), minor: 6, host: "desktop-a")
  _ = await recorder.wait { $0.phase == .live }
  await first.close()
  _ = await recorder.wait {
    if case .reconnecting = $0.phase { return true }
    return false
  }
  await clock.advance(250)

  let second = await dialer.nextPeer()
  try? await second.completeHandshake(minor: 6, host: "desktop-b")
  let attach = try? await second.readAttach()
  try? await second.acceptAttach(attach)
  #expect(await recorder.wait { $0.phase == .ended(.hostRestarted) } != nil)
  #expect(await dialer.dialCount == 2)
}

@Test func aRejectedAttachEndsOrRetriesPerTheTable() async {
  let dialer = ScriptedDialer()
  let lifecycle = makeLifecycle(dialer: dialer)
  let recorder = await PhaseRecorder.watching(lifecycle)
  await lifecycle.start()

  let peer = await dialer.nextPeer()
  try? await peer.completeHandshake(minor: 6)
  let attach = try? await peer.readAttach()
  try? await peer.writeControl(
    .attachRejected(
      requestID: attach?.requestID ?? "", code: .sessionEpochMismatch, retryable: true))
  // The advisory `retryable: true` does not soften a terminal code.
  #expect(await recorder.wait { $0.phase == .ended(.hostRestarted) } != nil)
}

@Test func anAccessDeniedAttachComesToRestWithoutClaimingTheSessionEnded() async {
  let dialer = ScriptedDialer()
  let lifecycle = makeLifecycle(dialer: dialer)
  let recorder = await PhaseRecorder.watching(lifecycle)
  await lifecycle.start()

  let peer = await dialer.nextPeer()
  try? await peer.completeHandshake(minor: 6)
  let attach = try? await peer.readAttach()
  try? await peer.writeControl(
    .attachRejected(requestID: attach?.requestID ?? "", code: .accessDenied, retryable: false))
  #expect(await recorder.wait { $0.phase == .suspended(.accessDenied) } != nil)
  #expect(await recorder.phases.contains { $0.isTerminal } == false)
  await lifecycle.close()
}

@Test func anAbsentListingEndsAsUnavailableAndNeverAsClosed() async {
  let dialer = ScriptedDialer()
  await dialer.setListing([
    GhostteaSharedSessionSummary(
      sessionID: "other-session", title: "other", cwdLabel: nil, running: true, attachable: true,
      readWrite: true, createdAtMs: 0)
  ])
  let lifecycle = makeLifecycle(dialer: dialer)
  let recorder = await PhaseRecorder.watching(lifecycle)
  await lifecycle.start()

  // The host answered and does not hold it. Absence is never upgraded to a
  // claim about how it ended.
  #expect(await recorder.wait { $0.phase == .ended(.sessionUnavailable) } != nil)
  #expect(await dialer.dialCount == 0)
}

@Test func anUnattachableExitedListingEndsAsExited() async {
  let dialer = ScriptedDialer()
  await dialer.setListing([
    GhostteaSharedSessionSummary(
      sessionID: "session-1", title: "shell", cwdLabel: nil, running: false, attachable: false,
      readWrite: true, createdAtMs: 0)
  ])
  let lifecycle = makeLifecycle(dialer: dialer)
  let recorder = await PhaseRecorder.watching(lifecycle)
  await lifecycle.start()
  #expect(await recorder.wait { $0.phase == .ended(.sessionExited) } != nil)
}

@Test func anExitedButAttachableListingResumesNormally() async {
  let dialer = ScriptedDialer()
  await dialer.setListing([
    GhostteaSharedSessionSummary(
      sessionID: "session-1", title: "shell", cwdLabel: nil, running: false, attachable: true,
      readWrite: true, createdAtMs: 0)
  ])
  let lifecycle = makeLifecycle(dialer: dialer)
  let recorder = await PhaseRecorder.watching(lifecycle)
  await lifecycle.start()

  // Exitedness is process metadata, not a lifecycle state: the session stays
  // Live showing its final screen.
  let peer = await dialer.nextPeer()
  try? await peer.goLive(snapshot: snapshotJSON(terminalRevision: 1), minor: 6)
  #expect(await recorder.wait { $0.phase == .live } != nil)
  await lifecycle.close()
}

@Test func backgroundingSuspendsInPlaceAndForegroundingDialsImmediately() async {
  let dialer = ScriptedDialer()
  let clock = ManualClock()
  let lifecycle = makeLifecycle(dialer: dialer, clock: clock)
  let recorder = await PhaseRecorder.watching(lifecycle)
  await lifecycle.start()
  let peer = await dialer.nextPeer()
  try? await peer.goLive(snapshot: snapshotJSON(terminalRevision: 1), minor: 6)
  _ = await recorder.wait { $0.phase == .live }

  await lifecycle.suspendForBackground()
  let suspended = await recorder.wait { $0.phase == .suspended(.suspendedByApp) }
  #expect(suspended != nil)
  // Input is rejected while suspended for exactly the reason it is rejected
  // while reconnecting: there is no live screen behind it.
  await #expect(throws: GhostteaAttachmentInputRejection.self) {
    try await lifecycle.send(.text("ls\n"))
  }
  // Suspended costs no network: nothing is left on a timer to bring the
  // attachment back, so no amount of elapsed time produces another dial.
  #expect(await clock.settledSleeperCount() == 0)
  await clock.advance(120_000, sleepers: 0)
  #expect(await dialer.dialCount == 1)

  await lifecycle.resumeFromForeground()
  let second = await dialer.nextPeer()
  try? await second.goLive(snapshot: snapshotJSON(terminalRevision: 2), minor: 6)
  let resumedSeq = suspended?.lifecycleSeq ?? 0
  #expect(await recorder.wait { $0.phase == .live && $0.lifecycleSeq > resumedSeq } != nil)
  #expect(await dialer.dialCount == 2)
  await lifecycle.close()
}

@Test func aHostAbsentPastTheSuspendWindowRestsUntilItLooksReachableAgain() async {
  let dialer = ScriptedDialer()
  await dialer.failDials(2)
  let clock = ManualClock()
  let lifecycle = GhostteaAttachmentLifecycle(
    sessionID: "session-1", localViewID: "pane-1", cols: 100, rows: 30, dialer: dialer,
    config: GhostteaReconnectConfig(suspendAfterMs: 400), clock: clock, jitter: { _ in 0 })
  let recorder = await PhaseRecorder.watching(lifecycle)
  await lifecycle.start()

  // Two failed dials on the floor-length schedule carry the clock past the
  // suspend window, and the engine comes to rest rather than burning more.
  _ = await recorder.wait { $0.phase == .reconnecting(attempt: 1, nextRetryMs: 250) }
  await clock.advance(250)
  _ = await recorder.wait { $0.phase == .reconnecting(attempt: 2, nextRetryMs: 250) }
  await clock.advance(250)
  #expect(await recorder.wait { $0.phase == .suspended(.hostAbsent) } != nil)
  #expect(await dialer.dialCount == 2)

  // A device that looks reachable again re-enters Reconnecting immediately —
  // and the woken engine must not compare against the same stale absence mark
  // and drop straight back into Suspended.
  await lifecycle.noteDeviceReachable()
  let peer = await poll { await dialer.takePeer() }
  #expect(peer != nil)
  try? await peer?.goLive(snapshot: snapshotJSON(terminalRevision: 1), minor: 6)
  #expect(await recorder.wait { $0.phase == .live } != nil)
  #expect(await dialer.dialCount == 3)
  await lifecycle.close()
}

@Test func closingLocallyEndsWithThatReasonAndStopsDialing() async {
  let dialer = ScriptedDialer()
  let lifecycle = makeLifecycle(dialer: dialer)
  let recorder = await PhaseRecorder.watching(lifecycle)
  await lifecycle.start()
  let peer = await dialer.nextPeer()
  try? await peer.goLive(snapshot: snapshotJSON(terminalRevision: 1), minor: 6)
  _ = await recorder.wait { $0.phase == .live }

  await lifecycle.close()
  #expect(await lifecycle.currentSnapshot.phase == .ended(.closedLocally))
  #expect(await dialer.dialCount == 1)
}

// MARK: - Harness

private func makeLifecycle(
  dialer: ScriptedDialer,
  sink: RecordingSink? = nil,
  clock: ManualClock = ManualClock()
) -> GhostteaAttachmentLifecycle {
  GhostteaAttachmentLifecycle(
    sessionID: "session-1",
    localViewID: "pane-1",
    cols: 100,
    rows: 30,
    dialer: dialer,
    sink: sink,
    config: GhostteaReconnectConfig(),
    clock: clock,
    jitter: { _ in 0 })
}

private func snapshotJSON(terminalRevision: UInt64) -> String {
  #"{"s":[7,3,\#(terminalRevision),2,[],[0,0,true,0,false],false,[1,0,1],null,null]}"#
}

private func patchJSON() -> String {
  #"{"p":[7,3,1,43,[],null,null,null,0]}"#
}

/// Waits until the client has actually taken delivery of whatever the peer
/// just sent — the contact clock is the observable proof, since a refresh
/// publishes no event of its own.
@discardableResult
private func awaitContactRefresh(_ lifecycle: GhostteaAttachmentLifecycle) async -> Bool {
  await poll { await lifecycle.currentSnapshot.lastContactAgeMs == 0 ? true : nil } ?? false
}

/// The next control frame the client sends, or `nil` if it never comes.
private func nextControl(_ peer: ScriptedPeer) async -> GhostteaSessionControlMessage? {
  await poll { await peer.takeControl() }
}

/// The next acknowledgement, which the peer queues apart from pane-initiated
/// frames.
private func nextAcknowledgement(_ peer: ScriptedPeer) async -> GhostteaSessionControlMessage? {
  await poll { await peer.takeAcknowledgement() }
}

/// Wall-clock guard so an expectation that will never be met fails in seconds
/// instead of hanging the suite.
///
/// Deliberately a poll rather than a task-group race: a losing child that is
/// parked on a continuation cannot be cancelled, and `withTaskGroup` waits for
/// every child, so the "timeout" would hang exactly in the case it exists for.
private func poll<T: Sendable>(
  seconds: Double = 3,
  _ probe: @Sendable () async -> T?
) async -> T? {
  let attempts = Int(seconds * 200)
  for _ in 0..<attempts {
    if let value = await probe() { return value }
    try? await Task.sleep(nanoseconds: 5_000_000)
  }
  return nil
}

/// A clock the test advances by hand: heartbeat and backoff behaviour is
/// asserted exactly, in microseconds, instead of being slept through.
private final class ManualClock: GhostteaLifecycleClock, @unchecked Sendable {
  private struct Waiter {
    let deadline: UInt64
    let continuation: CheckedContinuation<Void, Error>
  }

  private let lock = NSLock()
  private var now: UInt64 = 0
  private var waiters: [UUID: Waiter] = [:]
  private var cancelled: Set<UUID> = []

  var nowMs: UInt64 {
    lock.lock()
    defer { lock.unlock() }
    return now
  }

  var sleeperCount: Int {
    lock.lock()
    defer { lock.unlock() }
    return waiters.count
  }

  /// Sleepers still registered once the runtime has settled — how a test
  /// asserts that *nothing* is scheduled to happen later, which no amount of
  /// advancing time can show.
  func settledSleeperCount() async -> Int {
    for _ in 0..<64 { await Task.yield() }
    return sleeperCount
  }

  func sleep(millis: UInt64) async throws {
    let id = UUID()
    let deadline = nowMs &+ millis
    try await withTaskCancellationHandler {
      try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
        lock.lock()
        if cancelled.remove(id) != nil {
          lock.unlock()
          continuation.resume(throwing: CancellationError())
          return
        }
        if now >= deadline {
          lock.unlock()
          continuation.resume()
          return
        }
        waiters[id] = Waiter(deadline: deadline, continuation: continuation)
        lock.unlock()
      }
    } onCancel: {
      self.cancel(id)
    }
  }

  private func cancel(_ id: UUID) {
    lock.lock()
    guard let waiter = waiters.removeValue(forKey: id) else {
      cancelled.insert(id)
      lock.unlock()
      return
    }
    lock.unlock()
    waiter.continuation.resume(throwing: CancellationError())
  }

  /// Waits until something is actually sleeping before moving time, so a test
  /// cannot advance past a deadline that has not been registered yet.
  func advance(_ delta: UInt64, sleepers: Int = 1) async {
    _ = await poll { self.sleeperCount >= sleepers ? true : nil }
    for continuation in due(after: delta) { continuation.resume() }
    await Task.yield()
  }

  private func due(after delta: UInt64) -> [CheckedContinuation<Void, Error>] {
    lock.lock()
    defer { lock.unlock() }
    now &+= delta
    var due: [CheckedContinuation<Void, Error>] = []
    for (id, waiter) in waiters where waiter.deadline <= now {
      due.append(waiter.continuation)
      waiters[id] = nil
    }
    return due
  }
}

/// Holds the outcome of a selection request that is in flight, so a test can
/// poll for it with a deadline instead of awaiting it inline — an awaited call
/// that never resolves hangs the suite, and proving nothing is the one thing a
/// test must not do.
private actor SelectionBox {
  private var text: String?
  private var reason: GhostteaAttachmentInputRejection.Reason?
  private var finished = false

  func run(_ body: @escaping @Sendable () async throws -> String) {
    Task {
      do {
        await self.finish(text: try await body(), reason: nil)
      } catch let rejection as GhostteaAttachmentInputRejection {
        await self.finish(text: nil, reason: rejection.reason)
      } catch {
        await self.finish(text: nil, reason: nil)
      }
    }
  }

  private func finish(text: String?, reason: GhostteaAttachmentInputRejection.Reason?) {
    self.text = text
    self.reason = reason
    finished = true
  }

  func settledText() async -> String? {
    await poll { await self.settled() } ?? nil
    return text
  }

  func settledReason() async -> GhostteaAttachmentInputRejection.Reason? {
    await poll { await self.settled() } ?? nil
    return reason
  }

  private func settled() -> Bool? { finished ? true : nil }
}

private actor RecordingSink: GhostteaAttachmentStateSink {
  private(set) var applied: [GhostteaTerminalStateMessage] = []
  private var refusal: GhostteaAttachmentApplyFailure?

  /// Makes the next frame fail the way a replica rejecting a discontinuous
  /// patch does.
  func refuseNext(_ failure: GhostteaAttachmentApplyFailure) {
    refusal = failure
  }

  private(set) var tokens: [GhostteaAttachmentStateToken] = []

  func apply(_ message: GhostteaTerminalStateMessage, from token: GhostteaAttachmentStateToken)
    async throws
  {
    if let refusal {
      self.refusal = nil
      throw refusal
    }
    applied.append(message)
    tokens.append(token)
  }
}

private actor PhaseRecorder {
  private var snapshots: [GhostteaAttachmentSnapshot] = []
  private(set) var rejections: [GhostteaAttachmentInputRejection] = []

  static func watching(_ lifecycle: GhostteaAttachmentLifecycle) async -> PhaseRecorder {
    let recorder = PhaseRecorder()
    let events = await lifecycle.events()
    Task {
      for await event in events { await recorder.record(event) }
    }
    return recorder
  }

  var phases: [GhostteaAttachmentPhase] { snapshots.map(\.phase) }

  var sawLive: Bool { snapshots.contains { $0.phase == .live } }

  func record(_ event: GhostteaAttachmentLifecycleEvent) {
    switch event {
    case .inputRejected(let rejection):
      rejections.append(rejection)
    case .state(let snapshot):
      snapshots.append(snapshot)
    }
  }

  nonisolated func wait(
    _ check: @escaping @Sendable (GhostteaAttachmentSnapshot) -> Bool
  ) async -> GhostteaAttachmentSnapshot? {
    await poll { await self.matching(check) }
  }

  /// The *first* matching transition, not the newest: a test that asks when a
  /// phase was entered means the event that entered it, and the engine may
  /// have moved on by the time the poll looks.
  private func matching(
    _ check: @Sendable (GhostteaAttachmentSnapshot) -> Bool
  ) -> GhostteaAttachmentSnapshot? {
    snapshots.first(where: check)
  }

  /// Lets the reader drain whatever is queued before a test asserts on it.
  func waitForSinkQuiet() async -> Bool {
    for _ in 0..<8 { await Task.yield() }
    return true
  }

  /// Rejections reach the scene through the same stream as phases, so a test
  /// has to let that delivery land before counting them.
  func rejectionCount(settlingAt expected: Int) async -> Int {
    for _ in 0..<32 where rejections.count < expected { await Task.yield() }
    return rejections.count
  }

}

private struct ScriptedAttach: Sendable {
  let requestID: String
  let sessionID: String
  let wireViewID: String
  let attachGeneration: UInt64
  let resume: GhostteaResumeHint?
  let wantsState: Bool
}

/// The host side of one compact connection, driven frame by frame. Every
/// minor-6 shape here is scripted from `tunnel_protocol.rs`: the real host
/// answers compact at minor ≤ 5 until the cap lift lands, so cross-language
/// proof belongs to the integration stage, not here.
private actor ScriptedPeer {
  private let connection: LoopbackConnection
  private var buffer = Data()
  private var received: [GhostteaSessionControlMessage] = []
  private var acknowledgements: [GhostteaSessionControlMessage] = []
  private var controlWaiters: [CheckedContinuation<GhostteaSessionControlMessage, Never>] = []
  private var pump: Task<Void, Never>?

  init(connection: LoopbackConnection) {
    self.connection = connection
  }

  func completeHandshake(minor: UInt16, host: String = "desktop-instance") async throws {
    let header = try await readExactly(16)
    let metadataCount = Int(header[12..<16].reduce(UInt32(0)) { ($0 << 8) | UInt32($1) })
    _ = try await readExactly(metadataCount)
    let hello: GhostteaConnectionMessage = try await readFrame()
    guard case .clientHello(_, _, _, _, let nonce, _) = hello else {
      throw GhostteaTruffleError.mismatchedResponse
    }
    try await connection.write(
      GhostteaTerminalProtocolCodec.encodeFrame(
        GhostteaConnectionMessage.serverHello(
          protocolMajor: 1, protocolMinor: minor, hostInstanceID: host, nonce: nonce,
          stateCodec: .compactJSONV1)))
    // Everything after the hello is compact framing, so one pump owns the
    // socket from here. A test that asserts *nothing* was sent needs a queue
    // to look at, not a speculative read that could swallow the next frame.
    pump = Task { [weak self] in
      while !Task.isCancelled {
        guard let self, let message = try? await self.readCompactControl() else { return }
        await self.deliver(message)
      }
    }
  }

  func readAttach() async throws -> ScriptedAttach {
    guard
      case .attachView(
        let requestID, let sessionID, let viewID, _, _, _, let generation, let resume,
        let wantsState)? = await poll({ await self.takeControl() })
    else {
      throw GhostteaTruffleError.mismatchedResponse
    }
    return ScriptedAttach(
      requestID: requestID, sessionID: sessionID, wireViewID: viewID,
      attachGeneration: generation, resume: resume, wantsState: wantsState)
  }

  /// Acknowledgements are queued apart from everything else. They are
  /// automatic state-sync traffic rather than something the pane chose to
  /// send, so keeping them out of the main queue is what lets a test still
  /// assert "the pane sent nothing" and mean it.
  private func deliver(_ message: GhostteaSessionControlMessage) {
    if case .stateAck = message {
      acknowledgements.append(message)
      return
    }
    if controlWaiters.isEmpty {
      received.append(message)
    } else {
      controlWaiters.removeFirst().resume(returning: message)
    }
  }

  func takeAcknowledgement() -> GhostteaSessionControlMessage? {
    acknowledgements.isEmpty ? nil : acknowledgements.removeFirst()
  }

  var pendingAcknowledgementCount: Int {
    get async {
      for _ in 0..<16 { await Task.yield() }
      return acknowledgements.count
    }
  }

  func acceptAttach(
    _ attach: ScriptedAttach?, sessionEpoch: UInt64 = 7, attachmentEpoch: UInt64 = 11,
    readWrite: Bool = true
  ) async throws {
    guard let attach else { throw GhostteaTruffleError.mismatchedResponse }
    try await writeControl(
      .viewAttached(
        requestID: attach.requestID, sessionEpoch: sessionEpoch, layoutEpoch: 3,
        attachmentEpoch: attachmentEpoch, cols: 100, rows: 30, readWrite: readWrite,
        presentation: nil, resumed: attach.resume != nil, controller: nil, controlRevision: 1))
  }

  /// Handshake, attach, and the recovery snapshot in one step, for tests whose
  /// subject is what happens after Live.
  func goLive(snapshot: String, minor: UInt16, host: String = "desktop-instance") async throws {
    try await completeHandshake(minor: minor, host: host)
    let attach = try await readAttach()
    try await acceptAttach(attach)
    try await writeState(snapshot)
  }

  func writeControl(_ message: GhostteaSessionControlMessage) async throws {
    try await connection.write(
      GhostteaTerminalProtocolCodec.encodeCompactFrame(.control, message))
  }

  func writeState(_ json: String) async throws {
    let payload = Data(json.utf8)
    var size = UInt32(payload.count + 1).bigEndian
    var frame = Swift.withUnsafeBytes(of: &size) { Data($0) }
    frame.append(GhostteaCompactChannel.state.rawValue)
    frame.append(payload)
    try await connection.write(frame)
  }

  /// Non-blocking by design: the tests poll it, so a frame that never arrives
  /// ends as a failed expectation rather than a parked task.
  func takeControl() -> GhostteaSessionControlMessage? {
    received.isEmpty ? nil : received.removeFirst()
  }

  /// Control frames the client has sent and no expectation has claimed —
  /// how a test asserts that *nothing* was sent.
  var pendingControlCount: Int {
    get async {
      for _ in 0..<16 { await Task.yield() }
      return received.count
    }
  }

  func close() async {
    pump?.cancel()
    pump = nil
    await connection.close()
  }

  private func readCompactControl() async throws -> GhostteaSessionControlMessage {
    while true {
      let header = try await readExactly(4)
      let size = Int(header.reduce(UInt32(0)) { ($0 << 8) | UInt32($1) })
      let framed = try await readExactly(size)
      guard framed.first == GhostteaCompactChannel.control.rawValue else { continue }
      return try JSONDecoder().decode(
        GhostteaSessionControlMessage.self, from: Data(framed.dropFirst()))
    }
  }

  private func readFrame<T: Decodable>() async throws -> T {
    let header = try await readExactly(4)
    let size = Int(header.reduce(UInt32(0)) { ($0 << 8) | UInt32($1) })
    return try JSONDecoder().decode(T.self, from: try await readExactly(size))
  }

  private func readExactly(_ count: Int) async throws -> Data {
    while buffer.count < count {
      guard let chunk = try await connection.read(max(4096, count - buffer.count)),
        !chunk.isEmpty
      else { throw GhostteaTruffleError.unexpectedEndOfStream }
      buffer.append(chunk)
    }
    let result = Data(buffer.prefix(count))
    buffer.removeFirst(count)
    return result
  }
}

private actor ScriptedDialer: GhostteaAttachmentDialer {
  nonisolated let localDeviceID = "ios-device"

  private var ready: [ScriptedPeer] = []
  private var listing: [GhostteaSharedSessionSummary]?
  private var listingHostInstanceID = "desktop-instance"
  private var listingStalled = false
  private var listingWaiters: [CheckedContinuation<Void, Never>] = []
  private var failingDials = 0
  private(set) var dialCount = 0

  func setListing(
    _ sessions: [GhostteaSharedSessionSummary], hostInstanceID: String = "desktop-instance"
  ) {
    listing = sessions
    listingHostInstanceID = hostInstanceID
  }

  /// The next `count` dials throw, the way an unreachable device presents.
  func failDials(_ count: Int) {
    failingDials = count
  }

  func dial() async throws -> any MeshConnection {
    dialCount += 1
    if failingDials > 0 {
      failingDials -= 1
      throw GhostteaTruffleError.hostUnavailable("scripted")
    }
    let (client, server) = LoopbackConnection.makePair()
    ready.append(ScriptedPeer(connection: server))
    return client
  }

  /// Holds the listing open, the way a host that has stopped answering does.
  func stallListing() {
    listingStalled = true
  }

  func releaseListing() {
    listingStalled = false
    let waiting = listingWaiters
    listingWaiters.removeAll()
    for waiter in waiting { waiter.resume() }
  }

  var listingIsStalled: Bool { listingStalled && !listingWaiters.isEmpty }

  func listSessions() async throws -> GhostteaSessionListing? {
    if listingStalled {
      await withCheckedContinuation { listingWaiters.append($0) }
    }
    return listing.map {
      GhostteaSessionListing(hostInstanceID: listingHostInstanceID, sessions: $0)
    }
  }

  /// The next dial, or — if none arrives — a peer whose connection is already
  /// closed. Handing back a dead peer keeps a test that expected a dial
  /// failing on its own expectations instead of parking the whole suite on a
  /// continuation nothing will resume: a hung test proves nothing, and under a
  /// deliberate breakage "no dial" is exactly the case being provoked.
  func nextPeer() async -> ScriptedPeer {
    if let peer = await poll({ await self.takePeer() }) { return peer }
    // Both ends: closing only the server side leaves its *reads* blocked on a
    // mailbox nobody will ever finish, so the peer would look dead and still
    // hang the first handshake read.
    let (client, server) = LoopbackConnection.makePair()
    await client.close()
    await server.close()
    return ScriptedPeer(connection: server)
  }

  func takePeer() -> ScriptedPeer? {
    ready.isEmpty ? nil : ready.removeFirst()
  }
}

// MARK: - Review round: P1-1, P1-2, P1-3, P2-5, P2-7

@Test func aFencedClaimCarriesTheObservedRevisionAndNeverTheZeroSentinel() async {
  let dialer = ScriptedDialer()
  let lifecycle = makeLifecycle(dialer: dialer)
  let recorder = await PhaseRecorder.watching(lifecycle)
  await lifecycle.start()
  let peer = await dialer.nextPeer()
  try? await peer.goLive(snapshot: snapshotJSON(terminalRevision: 1), minor: 6)
  _ = await recorder.wait { $0.phase == .live }
  _ = await nextAcknowledgement(peer)

  // Nothing revisioned observed yet beyond the attach's own revision 1, which
  // IS compare-and-swappable — a revisioned authority initializes at 1.
  try? await lifecycle.claimControl(cols: 100, rows: 30)
  guard case .focusAndResize(_, _, _, _, _, let expected)? = await nextControl(peer) else {
    Issue.record("expected a control claim")
    return
  }
  #expect(expected == 1)

  // A legacy host reports revision 0, which is the "unknown" sentinel and is
  // never CAS-able: the claim must go out unfenced rather than asking the host
  // to compare against a premise that was never true.
  let legacyDialer = ScriptedDialer()
  let legacy = makeLifecycle(dialer: legacyDialer)
  let legacyRecorder = await PhaseRecorder.watching(legacy)
  await legacy.start()
  let legacyPeer = await legacyDialer.nextPeer()
  try? await legacyPeer.goLive(snapshot: snapshotJSON(terminalRevision: 1), minor: 5)
  _ = await legacyRecorder.wait { $0.phase == .live }
  _ = await nextAcknowledgement(legacyPeer)
  try? await legacy.claimControl(cols: 100, rows: 30)
  guard case .focusAndResize(_, _, _, _, _, let legacyExpected)? = await nextControl(legacyPeer)
  else {
    Issue.record("expected a legacy control claim")
    return
  }
  #expect(legacyExpected == nil)
  #expect(await legacy.lastClaimOutcome == .unfenced)
  await lifecycle.close()
  await legacy.close()
}

@Test func aRejectedClaimEndsTheReclaimOrOffersARetryPerTheAsymmetry() async {
  let dialer = ScriptedDialer()
  let lifecycle = makeLifecycle(dialer: dialer)
  let recorder = await PhaseRecorder.watching(lifecycle)
  await lifecycle.start()
  let peer = await dialer.nextPeer()
  try? await peer.goLive(snapshot: snapshotJSON(terminalRevision: 1), minor: 6)
  _ = await recorder.wait { $0.phase == .live }
  _ = await nextAcknowledgement(peer)

  // Rejected with another view holding control: the reclaim is over. Retrying
  // is the fight the compare-and-swap exists to prevent.
  try? await lifecycle.claimControl(cols: 100, rows: 30)
  _ = await nextControl(peer)
  try? await peer.writeState(#"{"cs":[["r:rival",8],4,100,30,1]}"#)
  let lost = await poll { await lifecycle.lastClaimOutcome }
  #expect(lost == .lostToAnotherView(controllerViewID: "r:rival", revision: 4))
  #expect(lost?.isRetryable == false)

  // Rejected with nobody holding it at a newer revision: retryable, and the
  // caller is told so rather than the lifecycle retrying behind the focus
  // layer's back.
  try? await lifecycle.claimControl(cols: 100, rows: 30)
  _ = await nextControl(peer)
  try? await peer.writeState(#"{"cs":[null,6,100,30,1]}"#)
  let cleared = await poll {
    let outcome = await lifecycle.lastClaimOutcome
    if case .clearedAtNewerRevision = outcome { return outcome }
    return nil
  }
  #expect(cleared == .clearedAtNewerRevision(revision: 6))
  #expect(cleared?.isRetryable == true)
  await lifecycle.close()
}

@Test func backgroundingDuringAListingNeitherEndsTheSessionNorKeepsAttaching() async {
  let dialer = ScriptedDialer()
  await dialer.setListing([])
  await dialer.stallListing()
  let lifecycle = makeLifecycle(dialer: dialer)
  let recorder = await PhaseRecorder.watching(lifecycle)
  await lifecycle.start()
  _ = await poll { await dialer.listingIsStalled ? true : nil }

  // The listing would answer "no such session" — a verdict this attempt must
  // no longer be allowed to commit, because the user backgrounded while it was
  // in flight.
  await lifecycle.suspendForBackground()
  await dialer.releaseListing()

  #expect(await recorder.wait { $0.phase == .suspended(.suspendedByApp) } != nil)
  for _ in 0..<40 { await Task.yield() }
  #expect(await lifecycle.currentSnapshot.phase == .suspended(.suspendedByApp))
  #expect(await recorder.phases.contains { $0.isTerminal } == false)
  #expect(await dialer.dialCount == 0)
}

@Test func aRetiredSinkPublicationIsIdentifiableAsStale() async {
  let dialer = ScriptedDialer()
  let sink = RecordingSink()
  let clock = ManualClock()
  let lifecycle = makeLifecycle(dialer: dialer, sink: sink, clock: clock)
  let recorder = await PhaseRecorder.watching(lifecycle)
  await lifecycle.start()
  let peer = await dialer.nextPeer()
  try? await peer.goLive(snapshot: snapshotJSON(terminalRevision: 1), minor: 6)
  let live = await recorder.wait { $0.phase == .live }
  #expect(live != nil)

  let first = await sink.tokens.last
  let liveToken = await lifecycle.currentStateToken
  #expect(first == liveToken)

  // A new incarnation publishes under a new token, so anything still carrying
  // the old one is identifiable as belonging to a session that has moved on —
  // which is the only guarantee available once a call is already inside the
  // sink.
  await peer.close()
  _ = await recorder.wait {
    if case .reconnecting = $0.phase { return true }
    return false
  }
  await clock.advance(250)
  let second = await dialer.nextPeer()
  try? await second.goLive(snapshot: snapshotJSON(terminalRevision: 2), minor: 6)
  _ = await recorder.wait { $0.phase == .live && $0.lifecycleSeq > (live?.lifecycleSeq ?? 0) }
  let reattached = await sink.tokens.last
  let reattachedToken = await lifecycle.currentStateToken
  #expect(reattached != first)
  #expect(reattached == reattachedToken)
  await lifecycle.close()
}

@Test func aRestartedHostOutranksAnAbsentListing() async {
  let dialer = ScriptedDialer()
  let clock = ManualClock()
  await dialer.setListing(
    [
      GhostteaSharedSessionSummary(
        sessionID: "session-1", title: "shell", cwdLabel: nil, running: true, attachable: true,
        readWrite: true, createdAtMs: 0)
    ], hostInstanceID: "desktop-a")
  let lifecycle = makeLifecycle(dialer: dialer, clock: clock)
  let recorder = await PhaseRecorder.watching(lifecycle)
  await lifecycle.start()
  let peer = await dialer.nextPeer()
  try? await peer.goLive(snapshot: snapshotJSON(terminalRevision: 1), minor: 6, host: "desktop-a")
  _ = await recorder.wait { $0.phase == .live }

  // The host restarts: new instance, and its listing truthfully has no such
  // session. Absence is a consequence of the restart, not evidence about the
  // session, so the verdict must be host-restarted.
  await peer.close()
  await dialer.setListing([], hostInstanceID: "desktop-b")
  _ = await recorder.wait {
    if case .reconnecting = $0.phase { return true }
    return false
  }
  await clock.advance(250)
  #expect(await recorder.wait { $0.phase == .ended(.hostRestarted) } != nil)
}
