import Foundation
import Truffle

/// Why an attachment is over. A closed set: each reason requires the evidence
/// §6.4 defines, and absence is never upgraded to a claim.
public enum GhostteaAttachmentEndReason: String, Codable, Equatable, Sendable {
  case sessionClosed = "session-closed"
  case sessionExited = "session-exited"
  /// The honest "we do not know": the host could not or would not say.
  case sessionUnavailable = "session-unavailable"
  case hostRestarted = "host-restarted"
  case hostShutdown = "host-shutdown"
  case closedLocally = "closed-locally"
}

/// Why an attachment has stopped dialing without being over.
public enum GhostteaAttachmentSuspendReason: String, Codable, Equatable, Sendable {
  /// The host stayed absent past `suspendAfterMs`. A watcher remains: a wake
  /// signal or a manual retry re-enters Reconnecting immediately.
  case hostAbsent = "host-absent"
  /// The app went to the background and suspended this attachment in an
  /// orderly way (§8.2).
  case suspendedByApp = "suspended-by-app"
  /// The host refused on grounds a redial cannot change. Not an ending: the
  /// session exists, this client is not allowed in.
  case accessDenied = "access-denied"
}

public enum GhostteaAttachmentPhase: Equatable, Sendable {
  case opening
  /// Attached, generation activated, recovery snapshot not yet applied. Input
  /// stays blocked here: attach completion is not recovery.
  case synchronizing
  case live
  case reconnecting(attempt: UInt32, nextRetryMs: UInt64?)
  case suspended(GhostteaAttachmentSuspendReason)
  case ended(GhostteaAttachmentEndReason)

  /// Live is the only phase input may leave the device in (§4.3).
  public var acceptsInput: Bool {
    if case .live = self { return true }
    return false
  }

  public var isTerminal: Bool {
    if case .ended = self { return true }
    return false
  }
}

/// What the scene renders. Every transition carries a monotonically increasing
/// `lifecycleSeq`, so a late event can be discarded rather than re-applied.
public struct GhostteaAttachmentSnapshot: Equatable, Sendable {
  public let sessionID: String
  public let localViewID: String
  public let lifecycleSeq: UInt64
  public let phase: GhostteaAttachmentPhase
  /// Present only with `ended(.sessionExited)`, and only when the host said so.
  public let exitCode: Int32?
  public let readWrite: Bool
  /// `0` until a hello lands. Read the reconnect gate from here, never from
  /// what the host advertises.
  public let negotiatedMinor: UInt16
  /// How long since the current connection last proved the host was there.
  public let lastContactAgeMs: UInt64?

  public var acceptsInput: Bool { phase.acceptsInput && readWrite }
}

/// Why a keystroke was discarded. §4.3: rejected visibly, never queued, never
/// replayed on resume.
public struct GhostteaAttachmentInputRejection: Error, Equatable, Sendable {
  public enum Reason: String, Equatable, Sendable {
    case notLive
    case readOnly
    case writeFailed
  }

  public let phase: GhostteaAttachmentPhase
  public let reason: Reason
}

public enum GhostteaAttachmentLifecycleEvent: Equatable, Sendable {
  case state(GhostteaAttachmentSnapshot)
  case inputRejected(GhostteaAttachmentInputRejection)
}

/// One dial's worth of transport, plus the evidence the resume handshake reads
/// before it trusts an absence.
public protocol GhostteaAttachmentDialer: Sendable {
  /// The local Truffle device id the hello announces.
  var localDeviceID: String { get }
  /// A fresh compact connection to the host. Throwing means "not right now",
  /// which is a retry — never a verdict about the session.
  func dial() async throws -> any MeshConnection
  /// What the host says it is serving (§4.2 step 4). `nil` from a client with
  /// no listing path: absence then proves nothing and no verdict is drawn.
  func listSessions() async throws -> [GhostteaSharedSessionSummary]?
}

extension GhostteaAttachmentDialer {
  public func listSessions() async throws -> [GhostteaSharedSessionSummary]? { nil }
}

/// Where admitted state frames go. Awaited in order: the lifecycle reports Live
/// only once the recovery snapshot has come back from here, so input can never
/// race ahead of the screen it is typed against.
public protocol GhostteaAttachmentStateSink: Sendable {
  func apply(_ message: GhostteaTerminalStateMessage) async throws
}

/// The §3 state machine for one compact attachment.
///
/// This actor is the session's serialized lifecycle owner. Every liveness
/// effect — contact refresh, probe failure, host shutdown, disconnect —
/// arrives naming the connection incarnation it acted for and is compared
/// against the current one *here*, inside the actor: **the actor's
/// serialization is the lock**. A check-then-dispatch pattern would not do,
/// because a task can verify "A is current", be descheduled while B replaces
/// A, and resume holding a verdict for a connection that no longer exists.
public actor GhostteaAttachmentLifecycle {
  public let sessionID: String
  /// The stable identity this client knows the pane by. The wire identity
  /// rotates underneath it against legacy hosts.
  public let localViewID: String

  private let dialer: any GhostteaAttachmentDialer
  private let sink: (any GhostteaAttachmentStateSink)?
  private let clock: any GhostteaLifecycleClock
  private let jitter: GhostteaJitterSource
  private let config: GhostteaReconnectConfig
  private let accessToken: String?

  private var phase: GhostteaAttachmentPhase = .opening
  private var lifecycleSeq: UInt64 = 1
  /// §4.2.2 state generation. Every state-channel dispatch is dropped unless
  /// the publishing reader carries this value.
  private var generation: UInt64 = 1
  /// The connection incarnation the current attachment belongs to.
  private var incarnation: UInt64 = 0
  private var nextIncarnation: UInt64 = 1
  /// Monotonic per wire-view lineage over **every** attempt, initial retries
  /// included: a timed-out initial attach that reached the host leaves the
  /// same same-epoch collision a resume would.
  private var attachGeneration: UInt64 = 0
  private var inputSequence: UInt64 = 0
  private var attempt: UInt32 = 0
  private var cols: UInt16
  private var rows: UInt16

  private var hostInstanceID: String?
  private var sessionEpoch: UInt64?
  private var lastAttachmentEpoch: UInt64?
  private var terminalRevision: UInt64 = 0
  private var negotiatedMinor: UInt16 = 0
  private var readWrite = false
  private var exitCode: Int32?
  private var controller: GhostteaControllerInfo?
  private var controlRevision: UInt64 = 0

  private var lastContactMs: UInt64?
  private var outstandingPing: UInt64?
  private var pingNonce: UInt64 = 0
  private var absentSinceMs: UInt64?
  private var synchronizedGeneration: UInt64 = 0
  private var synchronizeWaiter: CheckedContinuation<Bool, Never>?
  private var wakeWaiters: [CheckedContinuation<Void, Never>] = []
  private var backgrounded = false

  private var current: GhostteaTruffleAttachment?
  private var engineTask: Task<Void, Never>?
  private var readerTask: Task<Void, Never>?
  private var heartbeatTask: Task<Void, Never>?
  private var subscribers: [UUID: AsyncStream<GhostteaAttachmentLifecycleEvent>.Continuation] = [:]

  public init(
    sessionID: String,
    localViewID: String,
    cols: UInt16,
    rows: UInt16,
    dialer: any GhostteaAttachmentDialer,
    sink: (any GhostteaAttachmentStateSink)? = nil,
    accessToken: String? = nil,
    config: GhostteaReconnectConfig = GhostteaReconnectConfig(),
    clock: any GhostteaLifecycleClock = GhostteaSystemClock(),
    jitter: @escaping GhostteaJitterSource = GhostteaBackoff.uniformJitter
  ) {
    self.sessionID = sessionID
    self.localViewID = localViewID
    self.cols = cols
    self.rows = rows
    self.dialer = dialer
    self.sink = sink
    self.accessToken = accessToken
    self.config = config
    self.clock = clock
    self.jitter = jitter
  }

  // MARK: - Scene API

  public var currentSnapshot: GhostteaAttachmentSnapshot { snapshot() }

  public var currentControlState: (controller: GhostteaControllerInfo?, revision: UInt64) {
    (controller, controlRevision)
  }

  /// A new subscription, seeded with the current state so a scene that
  /// subscribes late still renders the right banner.
  public func events() -> AsyncStream<GhostteaAttachmentLifecycleEvent> {
    let id = UUID()
    return AsyncStream(bufferingPolicy: .bufferingNewest(64)) { continuation in
      subscribers[id] = continuation
      continuation.yield(.state(snapshot()))
      continuation.onTermination = { [weak self] _ in
        Task { await self?.removeSubscriber(id) }
      }
    }
  }

  public func start() {
    guard engineTask == nil, !phase.isTerminal else { return }
    engineTask = Task { [weak self] in await self?.runEngine() }
  }

  /// The pane's geometry, used by the next attach. Resizing a live attachment
  /// is a control claim, which the focus-owning layer drives (§4.2.3).
  public func setViewport(cols: UInt16, rows: UInt16) {
    self.cols = cols
    self.rows = rows
  }

  /// §4.3: input outside Live is discarded with a signal the UI can surface.
  /// There is no queue, so there is nothing to replay on resume.
  public func send(_ operation: GhostteaTunnelInput) async throws {
    guard phase.acceptsInput, let attachment = current else {
      // The one silent drop the design allows: losing focus is cosmetic, and
      // reporting it would train the user to ignore the signal.
      if case .focus(false) = operation { return }
      let rejection = GhostteaAttachmentInputRejection(phase: phase, reason: .notLive)
      emit(.inputRejected(rejection))
      throw rejection
    }
    guard readWrite else {
      let rejection = GhostteaAttachmentInputRejection(phase: phase, reason: .readOnly)
      emit(.inputRejected(rejection))
      throw rejection
    }
    inputSequence &+= 1
    let sequence = inputSequence
    let sentIncarnation = incarnation
    let sentGeneration = generation
    do {
      try await attachment.send(operation, sequence: sequence)
    } catch {
      commitDisconnect(generation: sentGeneration, incarnation: sentIncarnation)
      let rejection = GhostteaAttachmentInputRejection(phase: phase, reason: .writeFailed)
      emit(.inputRejected(rejection))
      throw rejection
    }
  }

  /// §8.2: backgrounding is an explicit, orderly suspend — stop the heartbeat,
  /// close the connection, record why. The retained last frame stays on screen.
  public func suspendForBackground() {
    guard !phase.isTerminal else { return }
    backgrounded = true
    teardownCurrent()
    engineTask?.cancel()
    engineTask = nil
    advance(to: .suspended(.suspendedByApp))
  }

  /// Foreground: dial immediately rather than waiting out a schedule, and show
  /// the retained frame under the standard reconnecting treatment until Live.
  public func resumeFromForeground() {
    guard !phase.isTerminal else { return }
    backgrounded = false
    attempt = 0
    absentSinceMs = clock.nowMs
    advance(to: .reconnecting(attempt: 0, nextRetryMs: nil))
    if engineTask == nil {
      engineTask = Task { [weak self] in await self?.runEngine() }
    }
    wakeAll()
  }

  /// A fresh advertisement or peer-online signal for this device: short-circuit
  /// the backoff timer and dial now. This is the primary resume trigger, so it
  /// is cheap to call often.
  public func noteDeviceReachable() {
    wakeAll()
  }

  /// Manual retry out of Suspended.
  public func retryNow() {
    guard !phase.isTerminal else { return }
    attempt = 0
    absentSinceMs = clock.nowMs
    wakeAll()
  }

  public func close() async {
    guard !phase.isTerminal else { return }
    let attachment = current
    teardownCurrent()
    engineTask?.cancel()
    engineTask = nil
    advance(to: .ended(.closedLocally))
    await attachment?.detach()
    finishSubscribers()
  }

  // MARK: - Engine

  private func runEngine() async {
    // Absence is measured from the moment the engine started caring, not from
    // the first drop: an initial open that never reaches the host is exactly
    // as absent as a session that lost one.
    if absentSinceMs == nil { absentSinceMs = clock.nowMs }
    while !Task.isCancelled {
      if phase.isTerminal { return }
      if backgrounded {
        await waitForWake()
        continue
      }
      if let absent = absentSinceMs, clock.nowMs &- absent >= config.suspendAfterMs {
        advance(to: .suspended(.hostAbsent))
        await waitForWake()
        // Whatever woke us starts the absence over. Without this the next turn
        // of the loop would compare against the same stale mark and drop
        // straight back into Suspended, ignoring the wake.
        absentSinceMs = clock.nowMs
        attempt = 0
        continue
      }
      let outcome = await runAttempt()
      // Re-check before acting on the result: cancellation is only observed at
      // the top of this loop, so a suspend that landed mid-attempt would
      // otherwise publish one more Reconnecting and arm a schedule nobody
      // asked for — a backgrounded attachment announcing a retry it will
      // never make.
      if Task.isCancelled || backgrounded || phase.isTerminal { return }
      switch outcome {
      case .ended:
        return
      case .rest(let reason):
        advance(to: .suspended(reason))
        await waitForWake()
      case .retry:
        attempt &+= 1
        let delay = GhostteaBackoff.delayMs(config, attempt: attempt - 1, jitter: jitter)
        advance(to: .reconnecting(attempt: attempt, nextRetryMs: delay))
        await sleepOrWake(delay)
      }
    }
  }

  private enum AttemptOutcome {
    case retry
    case rest(GhostteaAttachmentSuspendReason)
    case ended
  }

  private func runAttempt() async -> AttemptOutcome {
    // Activation is early and Live is late (§4.2.2). The moment this advances,
    // every in-flight reader is stale and its late publishes drop — before any
    // replacement has read a byte.
    generation &+= 1
    let attemptGeneration = generation
    teardownCurrent()

    if let verdict = await listingVerdict() {
      commitEnded(verdict)
      return .ended
    }
    guard generation == attemptGeneration, !phase.isTerminal else { return .retry }

    let connection: any MeshConnection
    do {
      connection = try await dialer.dial()
    } catch {
      return .retry
    }
    guard generation == attemptGeneration, !phase.isTerminal else {
      await connection.close()
      return .retry
    }

    // Both shapes are computed before the dial and chosen after the hello: the
    // planner runs inside the handshake, where the actor cannot be consulted,
    // and the fencing shape depends on the minor the connection settles on.
    attachGeneration &+= 1
    let lineageGeneration = attachGeneration
    let rotated = GhostteaWireViewIdentity.rotated(localViewID, generation: lineageGeneration)
    let stable = GhostteaWireViewIdentity.stable(localViewID)
    let hint = resumeHint()
    let planner: GhostteaAttachPlanner = { hello in
      guard hello.supportsReconnect else {
        // Zero is the legacy declaration: a rotating client must not claim a
        // lineage the host would order against.
        return GhostteaAttachPlan(wireViewID: rotated, attachGeneration: 0, resume: nil)
      }
      return GhostteaAttachPlan(
        wireViewID: stable, attachGeneration: lineageGeneration, resume: hint)
    }

    let attachment: GhostteaTruffleAttachment
    do {
      attachment = try await GhostteaTruffleAttachment.connect(
        over: connection,
        localDeviceID: dialer.localDeviceID,
        sessionID: sessionID,
        viewID: localViewID,
        cols: cols,
        rows: rows,
        accessToken: accessToken,
        plan: planner)
    } catch GhostteaTruffleError.attachRejected(let code) {
      switch GhostteaAttachRejectAction(code: code) {
      // The host answered a question a newer attempt has already asked again.
      // Mark nothing; the superseding attempt governs.
      case .discard: return .retry
      case .retry: return .retry
      case .end(let reason):
        commitEnded(reason)
        return .ended
      case .rest(let reason): return .rest(reason)
      }
    } catch {
      return .retry
    }

    // §4.2 steps 2 and 6: a different host instance, or a different session
    // epoch under the same instance, is a new world. Definitive, not a retry.
    let info = attachment.info
    if let recorded = hostInstanceID, recorded != info.hostInstanceID {
      await attachment.detach()
      commitEnded(.hostRestarted)
      return .ended
    }
    if let recorded = sessionEpoch, recorded != info.sessionEpoch {
      await attachment.detach()
      commitEnded(.hostRestarted)
      return .ended
    }
    guard generation == attemptGeneration, !phase.isTerminal else {
      await attachment.detach()
      return .retry
    }
    if hostInstanceID == nil { hostInstanceID = info.hostInstanceID }
    if sessionEpoch == nil { sessionEpoch = info.sessionEpoch }

    // Bind before the reader exists, so its eventual verdict has an
    // incarnation to be compared against.
    let attemptIncarnation = nextIncarnation
    nextIncarnation &+= 1
    incarnation = attemptIncarnation
    current = attachment
    negotiatedMinor = info.negotiatedMinor
    readWrite = info.readWrite
    lastAttachmentEpoch = info.attachmentEpoch
    lastContactMs = clock.nowMs
    outstandingPing = nil
    applyController(info.controller, revision: info.controlRevision)
    advance(to: .synchronizing)
    startReader(
      attachment: attachment, generation: attemptGeneration, incarnation: attemptIncarnation)

    guard await awaitFirstSnapshot(generation: attemptGeneration) else {
      // Leaving this attempt's reader alive under the current generation would
      // let it mutate a replica the user has already been told is frozen.
      teardownCurrent()
      return .retry
    }
    guard generation == attemptGeneration, !phase.isTerminal else { return .retry }

    attempt = 0
    absentSinceMs = nil
    lastContactMs = clock.nowMs
    advance(to: .live)
    startHeartbeat(attachment: attachment, incarnation: attemptIncarnation)

    // Hold here until the connection is finished: the reader commits the
    // disconnect, so the engine never has to guess whether one happened. The
    // redial that follows still waits out a schedule — a host that just
    // dropped us is the last thing to hammer.
    await readerTask?.value
    if phase.isTerminal { return .ended }
    return .retry
  }

  /// §4.2 step 4 with §6.4's evidence rules. A host that cannot be asked, or
  /// that throws, yields no verdict at all — absence only counts when the host
  /// answered.
  private func listingVerdict() async -> GhostteaAttachmentEndReason? {
    let sessions: [GhostteaSharedSessionSummary]?
    do {
      sessions = try await dialer.listSessions()
    } catch {
      return nil
    }
    guard let sessions else { return nil }
    guard let entry = sessions.first(where: { $0.sessionID == sessionID }) else {
      // The host answered and does not hold it. Without a tombstone lookup on
      // the compact path, unavailable is the honest name for that.
      return .sessionUnavailable
    }
    // Exitedness is process metadata, not a lifecycle state: a session whose
    // process exited but which the host still lists as attachable resumes
    // normally and stays Live showing the final screen.
    if entry.attachable { return nil }
    return entry.running ? .sessionClosed : .sessionExited
  }

  private func resumeHint() -> GhostteaResumeHint? {
    guard let sessionEpoch, let lastAttachmentEpoch else { return nil }
    return GhostteaResumeHint(
      previousSessionEpoch: sessionEpoch,
      previousAttachmentEpoch: lastAttachmentEpoch,
      previousTerminalRevision: terminalRevision)
  }

  // MARK: - Reader

  private func startReader(
    attachment: GhostteaTruffleAttachment, generation: UInt64, incarnation: UInt64
  ) {
    readerTask = Task { [weak self] in
      while !Task.isCancelled {
        do {
          let event = try await attachment.nextEvent()
          guard let self else { return }
          guard await self.ingest(event, generation: generation, incarnation: incarnation) else {
            return
          }
        } catch {
          if Task.isCancelled { return }
          await self?.commitDisconnect(generation: generation, incarnation: incarnation)
          return
        }
      }
    }
  }

  /// Returns whether the reader should keep reading.
  private func ingest(
    _ event: GhostteaAttachmentEvent, generation: UInt64, incarnation: UInt64
  ) async -> Bool {
    switch event {
    case .pong(let nonce):
      notePong(nonce: nonce, incarnation: incarnation)
      return true
    case .ping(let nonce):
      // Answering keeps the channel symmetric for a host that probes its
      // clients. An inbound probe is not evidence the host is answering *us*,
      // so it refreshes nothing — and a probe that arrived on a connection
      // since replaced must not be answered on its replacement.
      guard incarnation == self.incarnation, let attachment = current else { return true }
      try? await attachment.pong(nonce: nonce)
      return true
    case .selectionText:
      return true
    case .state(let message):
      // The gate covers every state-channel dispatch, not only replica
      // publication: a superseded reader that only had its frames gated could
      // still move controller state, end the session, or refresh the current
      // connection's contact clock on its behalf.
      guard admitState(generation: generation, incarnation: incarnation) else { return true }
      switch message {
      case .sessionEnded(let reason):
        switch reason {
        case .exited(let code):
          exitCode = code
          commitEnded(.sessionExited)
        case .closed:
          commitEnded(.sessionClosed)
        }
        return false
      case .hostShutdown:
        commitEnded(.hostShutdown)
        return false
      case .controlState(let controller, let revision, _, _, _):
        applyController(controller, revision: revision)
      case .controlChanged(let viewID, let epoch, _, _, _):
        // Revision 0 says "legacy, unknown": this host cannot report revisions
        // or clears, and nothing may compare-and-swap against it.
        applyController(
          GhostteaControllerInfo(controllerViewID: viewID, controlEpoch: epoch), revision: 0)
      case .snapshot(let snapshot):
        terminalRevision = snapshot.terminalRevision
      case .patch(let patch):
        terminalRevision = patch.terminalRevision
      case .activityChanged, .configurationChanged:
        break
      }
      do {
        try await sink?.apply(message)
      } catch {
        commitDisconnect(generation: generation, incarnation: incarnation)
        return false
      }
      // Re-checked after the sink's await: applying is a suspension point, and
      // a snapshot that finished under a generation that has since been
      // retired must not be the one that unblocks input.
      guard generation == self.generation, incarnation == self.incarnation else { return true }
      if case .snapshot = message { signalSynchronized(generation: generation) }
      return true
    }
  }

  /// The identifiers a state dispatch must carry to be admitted. Internal
  /// rather than private so the module's tests can probe the fence directly.
  var fencingState: (generation: UInt64, incarnation: UInt64) { (generation, incarnation) }

  /// Gate one state-channel dispatch and refresh contact in the same critical
  /// section. Checking currency and then refreshing separately would let a
  /// superseded connection vouch for the current one.
  func admitState(generation: UInt64, incarnation: UInt64) -> Bool {
    guard generation == self.generation, incarnation == self.incarnation else { return false }
    lastContactMs = clock.nowMs
    return true
  }

  /// Internal rather than private for the same reason ``admitState`` is: the
  /// drop rule below is worth a direct test.
  func applyController(_ controller: GhostteaControllerInfo?, revision: UInt64) {
    // A revisioned announcement older than what is cached is a queued view of
    // the past and is dropped whole. Keeping its payload while raising the
    // revision would manufacture a state that never existed — "nobody holds
    // control, as of the newest revision" — which reads as an empty seat a
    // reclaim would take from the real holder.
    if revision >= 1 && revision < controlRevision { return }
    self.controller = controller
    // A legacy announcement carries no revision; keep the last one so a
    // downgrade never looks like a clear at a newer revision.
    controlRevision = max(revision, controlRevision)
  }

  // MARK: - Heartbeat (§5)

  private enum HeartbeatAction: Equatable {
    case idle
    case ping(UInt64)
    case fail
    case stop
  }

  private func startHeartbeat(attachment: GhostteaTruffleAttachment, incarnation: UInt64) {
    // Sample several times inside the idle window: the cadence bounds how late
    // a probe can be, it is not an interval anything is scheduled on.
    let tick = max(config.heartbeatIdleMs / 3, 10)
    let clock = self.clock
    heartbeatTask = Task { [weak self] in
      while !Task.isCancelled {
        do { try await clock.sleep(millis: tick) } catch { return }
        guard let self else { return }
        switch await self.heartbeatTick(incarnation: incarnation) {
        case .stop:
          return
        case .idle:
          continue
        case .ping(let nonce):
          do {
            try await attachment.ping(nonce: nonce)
          } catch {
            await self.failIncarnation(incarnation)
            return
          }
        case .fail:
          await self.failIncarnation(incarnation)
          return
        }
      }
    }
  }

  private func heartbeatTick(incarnation: UInt64) -> HeartbeatAction {
    guard incarnation == self.incarnation else { return .stop }
    // Silence is only evidence while something is attached and expecting
    // traffic. A connection nothing rides has no reason to hear from the host.
    guard case .live = phase, let contact = lastContactMs else {
      outstandingPing = nil
      return .idle
    }
    let quiet = clock.nowMs &- contact
    if quiet >= config.heartbeatFailMs { return .fail }
    if quiet >= config.heartbeatIdleMs, outstandingPing == nil {
      pingNonce &+= 1
      outstandingPing = pingNonce
      return .ping(pingNonce)
    }
    return .idle
  }

  /// An unsolicited or replayed pong refreshes nothing, even on the current
  /// connection: only an answer to a ping this incarnation actually sent is
  /// evidence the host is still there.
  private func notePong(nonce: UInt64, incarnation: UInt64) {
    guard incarnation == self.incarnation, outstandingPing == nonce else { return }
    outstandingPing = nil
    lastContactMs = clock.nowMs
  }

  private func failIncarnation(_ incarnation: UInt64) {
    guard incarnation == self.incarnation else { return }
    commitDisconnect(generation: generation, incarnation: incarnation)
  }

  // MARK: - Commits

  private func commitDisconnect(generation: UInt64, incarnation: UInt64) {
    guard generation == self.generation, incarnation == self.incarnation else { return }
    switch phase {
    case .live, .synchronizing, .opening: break
    case .reconnecting, .suspended, .ended: return
    }
    teardownCurrent()
    if absentSinceMs == nil { absentSinceMs = clock.nowMs }
    attempt = 0
    // The engine owns the schedule; the first event after a drop carries no
    // countdown because none has been decided yet.
    advance(to: .reconnecting(attempt: 0, nextRetryMs: nil))
  }

  private func commitEnded(_ reason: GhostteaAttachmentEndReason) {
    guard !phase.isTerminal else { return }
    teardownCurrent()
    engineTask?.cancel()
    engineTask = nil
    advance(to: .ended(reason))
    finishSubscribers()
  }

  /// Cancel this incarnation's tasks and let go of its connection. State is
  /// consistent the moment this returns; the socket closes just after, because
  /// closing needs an await this critical section must not take.
  private func teardownCurrent() {
    readerTask?.cancel()
    readerTask = nil
    heartbeatTask?.cancel()
    heartbeatTask = nil
    outstandingPing = nil
    if let attachment = current {
      current = nil
      Task { await attachment.detach() }
    }
    if let waiter = synchronizeWaiter {
      synchronizeWaiter = nil
      waiter.resume(returning: false)
    }
  }

  // MARK: - Synchronization barrier

  private func awaitFirstSnapshot(generation: UInt64) async -> Bool {
    if synchronizedGeneration == generation { return true }
    let clock = self.clock
    let bound = config.synchronizeTimeoutMs
    let timeout = Task { [weak self] in
      do { try await clock.sleep(millis: bound) } catch { return }
      await self?.failSynchronize(generation: generation)
    }
    let synchronized = await withCheckedContinuation { continuation in
      if synchronizedGeneration == generation {
        continuation.resume(returning: true)
      } else {
        synchronizeWaiter = continuation
      }
    }
    timeout.cancel()
    return synchronized
  }

  private func signalSynchronized(generation: UInt64) {
    guard generation == self.generation else { return }
    synchronizedGeneration = generation
    if let waiter = synchronizeWaiter {
      synchronizeWaiter = nil
      waiter.resume(returning: true)
    }
  }

  private func failSynchronize(generation: UInt64) {
    guard generation == self.generation, let waiter = synchronizeWaiter else { return }
    synchronizeWaiter = nil
    waiter.resume(returning: false)
  }

  // MARK: - Wake gate

  private func waitForWake() async {
    await withCheckedContinuation { continuation in
      wakeWaiters.append(continuation)
    }
  }

  private func wakeAll() {
    let waiters = wakeWaiters
    wakeWaiters.removeAll()
    for waiter in waiters { waiter.resume() }
  }

  /// Wait out a scheduled backoff, cut short when the device reappears.
  private func sleepOrWake(_ delayMs: UInt64) async {
    let clock = self.clock
    let timer = Task { [weak self] in
      do { try await clock.sleep(millis: delayMs) } catch { return }
      await self?.wakeAll()
    }
    await waitForWake()
    timer.cancel()
  }

  // MARK: - Publication

  private func advance(to next: GhostteaAttachmentPhase) {
    guard phase != next else { return }
    phase = next
    lifecycleSeq &+= 1
    emit(.state(snapshot()))
  }

  private func snapshot() -> GhostteaAttachmentSnapshot {
    GhostteaAttachmentSnapshot(
      sessionID: sessionID,
      localViewID: localViewID,
      lifecycleSeq: lifecycleSeq,
      phase: phase,
      exitCode: exitCode,
      readWrite: readWrite,
      negotiatedMinor: negotiatedMinor,
      lastContactAgeMs: lastContactMs.map { clock.nowMs &- $0 })
  }

  private func emit(_ event: GhostteaAttachmentLifecycleEvent) {
    for continuation in subscribers.values { continuation.yield(event) }
  }

  private func removeSubscriber(_ id: UUID) {
    subscribers[id] = nil
  }

  private func finishSubscribers() {
    for continuation in subscribers.values { continuation.finish() }
    subscribers.removeAll()
  }
}
