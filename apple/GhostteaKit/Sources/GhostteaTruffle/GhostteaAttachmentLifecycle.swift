import Foundation
import Truffle

private func ghostteaTraceSelection(_ message: @autoclosure () -> String) {
  #if DEBUG
    guard ProcessInfo.processInfo.environment["GHOSTTEA_SELECTION_TRACE"] == "1" else { return }
    print("[GhostteaSelection] lifecycle \(message())")
  #endif
}

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

/// Why an operation this pane initiated was refused.
///
/// One vocabulary for keystrokes and for the control operations — take
/// control, resize, copy — because the scene renders them from one place.
/// They differ in *delivery*, not in shape: a rejected keystroke is also
/// broadcast on the event stream, since §4.3 requires it be visible without
/// the caller asking, while a control refusal is thrown to the caller that
/// invoked the action and already knows which one it was.
public struct GhostteaAttachmentInputRejection: Error, Equatable, Sendable {
  public enum Reason: String, Equatable, Sendable {
    case notLive
    case readOnly
    case writeFailed
    /// A resize from a pane that does not hold control. The host would refuse
    /// it; refusing locally keeps the reason legible.
    case noControl
    /// The attachment a request was waiting on went away before the host
    /// answered. Distinct from a write failure: the request did leave.
    case attachmentEnded
  }

  public let phase: GhostteaAttachmentPhase
  public let reason: Reason
}

/// The control operations throw this alias so their call sites read honestly;
/// it is the same type the input path uses, deliberately.
public typealias GhostteaAttachmentControlRejection = GhostteaAttachmentInputRejection

/// What became of a compare-and-swap claim, per §4.2.3's asymmetry.
///
/// The asymmetry is the point: losing to *another view* ends the reclaim,
/// because two panes retrying at each other is the fight the CAS exists to
/// prevent. Losing to a *clear* is retryable, because nobody holds the seat
/// and the pane may still want it — but only the layer that owns focus truth
/// can decide that, so this reports rather than retries.
public enum GhostteaControlClaimOutcome: Equatable, Sendable {
  /// The host announced this view as the controller.
  case claimed(controlEpoch: UInt64, revision: UInt64)
  /// Another view holds control as of a newer revision. Do not retry.
  case lostToAnotherView(controllerViewID: String, revision: UInt64)
  /// Nobody holds control at a newer revision than the one claimed against.
  /// Retryable with the updated expectation while focus is still meaningful.
  case clearedAtNewerRevision(revision: UInt64)
  /// The claim went out as legacy last-write-wins because no revisioned
  /// observation existed to compare against — a `0` sentinel is never a
  /// compare-and-swappable observation.
  case unfenced

  public var isRetryable: Bool {
    if case .clearedAtNewerRevision = self { return true }
    return false
  }
}

/// How a sink refuses one frame.
///
/// The distinction is load-bearing: a discontinuity the replica cannot bridge
/// is repaired by asking for an authoritative snapshot, while any other
/// failure means the replica itself is unusable and the attachment has to go.
/// Throwing something untyped takes the second path.
public enum GhostteaAttachmentApplyFailure: Error, Equatable, Sendable {
  /// This frame could not be applied but the attachment is healthy — a logical
  /// discontinuity only a full snapshot can repair. The lifecycle requests one
  /// and, critically, does **not** acknowledge the frame it rejected.
  case needsSnapshot
}

public enum GhostteaAttachmentLifecycleEvent: Equatable, Sendable {
  case state(GhostteaAttachmentSnapshot)
  case inputRejected(GhostteaAttachmentInputRejection)
}

/// What a host answered when asked what it is serving.
///
/// The host identity travels with the list because absence is only evidence
/// about a session once you know it is the *same host* that used to hold it: a
/// restarted host answers truthfully that it has no such session, and reading
/// that as "the session is gone" turns a restart into a wrong verdict.
public struct GhostteaSessionListing: Sendable {
  public let hostInstanceID: String
  public let sessions: [GhostteaSharedSessionSummary]

  public init(hostInstanceID: String, sessions: [GhostteaSharedSessionSummary]) {
    self.hostInstanceID = hostInstanceID
    self.sessions = sessions
  }
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
  func listSessions() async throws -> GhostteaSessionListing?
}

extension GhostteaAttachmentDialer {
  public func listSessions() async throws -> GhostteaSessionListing? { nil }
}

/// Which attachment incarnation a state frame belongs to.
///
/// Carried on every sink callback because cancellation cannot recall a call
/// already inside `apply`: the achievable guarantee is not that a retired
/// reader never publishes, but that anything it publishes is *identifiable* as
/// stale. This is the §4.2.2 gate extended past the actor's edge — the last
/// point where the lifecycle can vouch for a frame is before it hands it over.
public struct GhostteaAttachmentStateToken: Hashable, Sendable {
  public let generation: UInt64
  public let incarnation: UInt64

  public init(generation: UInt64, incarnation: UInt64) {
    self.generation = generation
    self.incarnation = incarnation
  }
}

/// Where admitted state frames go. Awaited in order: the lifecycle reports Live
/// only once the recovery snapshot has come back from here, so input can never
/// race ahead of the screen it is typed against.
///
/// **The sink never acknowledges.** Returning from `apply` *is* the
/// acknowledgement: the lifecycle owns the wire, so it sends the `StateAck`
/// once the frame has been applied, with that frame's own coordinates. A sink
/// that throws ``GhostteaAttachmentApplyFailure/needsSnapshot`` gets a fresh
/// snapshot requested and no ack for the frame it refused, which is exactly
/// what "never apply or acknowledge the rejected patch" requires.
public protocol GhostteaAttachmentStateSink: Sendable {
  /// `token` names the attachment incarnation this frame came from. A sink
  /// that forwards anywhere shared must pass it on: a slow publication can
  /// land after its session is gone, and by then only the token can say so.
  func apply(_ message: GhostteaTerminalStateMessage, from token: GhostteaAttachmentStateToken)
    async throws
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
  /// The minor each attempt announces. Present so a test can stage a legacy
  /// pair against a current host; production sends the contract minor.
  private let offeredMinor: UInt16

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
  /// What the most recent attach actually put on the wire. Kept because a
  /// client can see what it sent but not what the host concluded from it —
  /// whether a takeover *displaced* anything depends on whether the host had
  /// reaped the previous attachment yet, which no client can observe.
  private var lastAttachGeneration: UInt64 = 0
  private var lastAttachCarriedResume = false
  private var inputSequence: UInt64 = 0
  /// Separate sequence spaces, as the wire defines them: input, control
  /// claims, and resizes are ordered independently of one another.
  private var clientSequence: UInt64 = 0
  private var resizeSequence: UInt64 = 0
  private var selectionWaiters: [String: CheckedContinuation<String, Error>] = [:]
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
  /// The revision a claim was compare-and-swapped against, kept until the
  /// host's answering announcement lands so the outcome can be read off it.
  private var claimedAgainstRevision: UInt64?
  private var claimOutcome: GhostteaControlClaimOutcome?

  private var lastContactMs: UInt64?
  private var outstandingPing: UInt64?
  private var pingNonce: UInt64 = 0
  private var absentSinceMs: UInt64?
  private var synchronizedGeneration: UInt64 = 0
  private var synchronizeWaiter: CheckedContinuation<Bool, Never>?
  private var wakeWaiters: [CheckedContinuation<Void, Never>] = []
  private var backgrounded = false

  private var current: GhostteaTruffleAttachment?
  /// The connection an in-flight attempt is still negotiating on. It is not
  /// `current` yet — nothing is attached — but it is the only handle that can
  /// unblock a read that has no deadline of its own, so suspension and
  /// teardown need it.
  private var attemptConnection: (any MeshConnection)?
  private var attemptWatchdog: Task<Void, Never>?
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
    offeredMinor: UInt16 = GhostteaTruffleContract.protocolMinor,
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
    self.offeredMinor = offeredMinor
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
    do {
      try await write(sequence: inputSequence, to: attachment) { attachment, sequence in
        try await attachment.send(operation, sequence: sequence)
      }
    } catch {
      // Same dead connection, different surface: a keystroke that did not land
      // is the one thing §4.3 requires be visible without the caller asking.
      let rejection = GhostteaAttachmentInputRejection(phase: phase, reason: .writeFailed)
      emit(.inputRejected(rejection))
      throw rejection
    }
  }

  /// The one fenced write path every pane-initiated operation takes — input,
  /// control claim, resize, selection. The attachment stamps its own
  /// attachment epoch on the frame, so the fencing is identical across all of
  /// them, and a failed write is the same evidence of a dead connection
  /// whatever the frame was — committed against the incarnation that owned it,
  /// never against whatever has replaced it since.
  private func write(
    sequence: UInt64,
    to attachment: GhostteaTruffleAttachment,
    _ body: (GhostteaTruffleAttachment, UInt64) async throws -> Void
  ) async throws {
    let sentGeneration = generation
    let sentIncarnation = incarnation
    do {
      try await body(attachment, sequence)
    } catch {
      commitDisconnect(generation: sentGeneration, incarnation: sentIncarnation)
      throw GhostteaAttachmentControlRejection(phase: phase, reason: .writeFailed)
    }
  }

  private func requireLiveAttachment() throws -> GhostteaTruffleAttachment {
    guard case .live = phase, let attachment = current else {
      throw GhostteaAttachmentControlRejection(phase: phase, reason: .notLive)
    }
    return attachment
  }

  /// The ack the sink never sends. Coordinates come from the frame that was
  /// applied, so a snapshot acks at patch sequence 0 and a patch at its own.
  /// A failed ack is a dying connection, which the reader reports on its own;
  /// swallowing it here can never invent state.
  private func acknowledge(_ message: GhostteaTerminalStateMessage) async {
    guard let attachment = current else { return }
    switch message {
    case .snapshot(let snapshot):
      try? await attachment.acknowledge(
        sessionEpoch: snapshot.sessionEpoch, layoutEpoch: snapshot.layoutEpoch,
        patchSequence: 0, terminalRevision: snapshot.terminalRevision)
    case .patch(let patch):
      try? await attachment.acknowledge(
        sessionEpoch: patch.sessionEpoch, layoutEpoch: patch.layoutEpoch,
        patchSequence: patch.patchSequence, terminalRevision: patch.terminalRevision)
    default:
      break
    }
  }

  private func requestSnapshotOnCurrentAttachment() async {
    guard let attachment = current else { return }
    try? await attachment.requestSnapshot()
  }

  /// Whether this pane currently holds resize control, and at which epoch.
  /// `nil` when another view holds it, when nobody does, or when the host has
  /// not said — the three cases a resize must not guess between.
  public var heldControlEpoch: UInt64? {
    guard let controller, let attachment = current,
      controller.controllerViewID == attachment.viewID
    else { return nil }
    return controller.controlEpoch
  }

  /// Ask the pane's focus layer to take resize control (§4.2.3's claim, minus
  /// the compare-and-swap, which the focus-owning layer drives).
  public func claimControl(cols: UInt16, rows: UInt16) async throws {
    let attachment = try requireLiveAttachment()
    self.cols = cols
    self.rows = rows
    clientSequence &+= 1
    // Revision 0 is the "legacy host, controller state unknown" sentinel and
    // is never compare-and-swappable: a revisioned authority initializes at 1,
    // so 0 means we have observed nothing to swap against. Sending it would
    // ask the host to compare against a premise that was never true.
    let expected = attachment.info.supportsReconnect && controlRevision >= 1
      ? controlRevision : nil
    claimedAgainstRevision = expected
    claimOutcome = expected == nil ? .unfenced : nil
    try await write(sequence: clientSequence, to: attachment) { attachment, sequence in
      try await attachment.claimControl(
        cols: cols, rows: rows, sequence: sequence, expectedControlRevision: expected)
    }
  }

  /// The outcome of the most recent claim, once the host's announcement has
  /// landed. `nil` while a fenced claim is still outstanding.
  public var lastClaimOutcome: GhostteaControlClaimOutcome? { claimOutcome }

  /// Resize the shared terminal. Only the controlling pane may: the epoch is
  /// read from the controller state this attachment last observed, never
  /// assumed.
  public func resize(cols: UInt16, rows: UInt16) async throws {
    let attachment = try requireLiveAttachment()
    guard let controlEpoch = heldControlEpoch else {
      throw GhostteaAttachmentControlRejection(phase: phase, reason: .noControl)
    }
    self.cols = cols
    self.rows = rows
    resizeSequence &+= 1
    try await write(sequence: resizeSequence, to: attachment) { attachment, sequence in
      try await attachment.resize(
        cols: cols, rows: rows, controlEpoch: controlEpoch, sequence: sequence)
    }
  }

  /// Ask for a fresh authoritative snapshot — after a rejected patch, or on
  /// foreground when the retained frame may be stale. Returns whether the
  /// request reached a live attachment; a session that is reconnecting gets a
  /// snapshot from the resume itself, so a `false` here is not a failure.
  @discardableResult
  public func requestSnapshot() async -> Bool {
    guard case .live = phase, current != nil else { return false }
    await requestSnapshotOnCurrentAttachment()
    return true
  }

  /// Authoritative selection extraction, resolved with the host's answer.
  ///
  /// The bound is the connection's own liveness rather than a timer: the
  /// heartbeat declares a silent host dead within `heartbeatFailMs`, and the
  /// teardown that follows fails every pending request. A request outliving
  /// its attachment therefore throws rather than hanging.
  public func selectionText(_ selection: GhostteaSelectionRequest) async throws -> String {
    let attachment = try requireLiveAttachment()
    let requestID = UUID().uuidString
    ghostteaTraceSelection(
      "request id=\(requestID) view=\(attachment.viewID) selection=(\(selection.startColumn),\(selection.startRow))->(\(selection.endColumn),\(selection.endRow)) all=\(selection.selectAll) minor=\(attachment.info.negotiatedMinor)"
    )
    // Register *before* sending. Writing first opens a window in which the
    // answer — or a teardown — arrives while no waiter is installed: the
    // answer finds nothing to resume and is dropped, and the continuation
    // registered a moment later waits for a reply that already came and went.
    return try await withCheckedThrowingContinuation { continuation in
      selectionWaiters[requestID] = continuation
      Task { await self.sendSelectionRequest(selection, requestID: requestID, to: attachment) }
    }
  }

  /// The send half of ``selectionText``, split out so the waiter can be
  /// installed first. A write that fails rolls the waiter back rather than
  /// leaving the caller suspended on a request that never left.
  private func sendSelectionRequest(
    _ selection: GhostteaSelectionRequest,
    requestID: String,
    to attachment: GhostteaTruffleAttachment
  ) async {
    let sentGeneration = generation
    let sentIncarnation = incarnation
    do {
      _ = try await attachment.requestSelectionText(selection, requestID: requestID)
      ghostteaTraceSelection("request sent id=\(requestID)")
    } catch {
      ghostteaTraceSelection(
        "request send failed id=\(requestID) error=\(String(describing: error))"
      )
      commitDisconnect(generation: sentGeneration, incarnation: sentIncarnation)
      if let waiter = selectionWaiters.removeValue(forKey: requestID) {
        waiter.resume(
          throwing: GhostteaAttachmentControlRejection(phase: phase, reason: .writeFailed))
      }
    }
  }

  /// §8.2: backgrounding is an explicit, orderly suspend — stop the heartbeat,
  /// close the connection, record why. The retained last frame stays on screen.
  public func suspendForBackground() {
    guard !phase.isTerminal else { return }
    backgrounded = true
    // Advance the generation so an attempt already in flight is superseded by
    // the same mechanism everything else is, and drop the transport it is
    // waiting on — cancelling its task cannot unblock a socket read.
    generation &+= 1
    abandonAnyAttempt()
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
    generation &+= 1
    abandonAnyAttempt()
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

  /// Whether the attempt that started under `generation` may still act.
  ///
  /// Invariant (b) of §4.2.1 applied to this engine: a stalled attempt
  /// re-checks that it is still its lineage's current one immediately before
  /// it acts, rather than trusting the world it was started in. Suspension and
  /// cancellation count as superseding it, which is why they are here and not
  /// only in the generation.
  private func attemptIsCurrent(_ generation: UInt64) -> Bool {
    self.generation == generation && !phase.isTerminal && !backgrounded && !Task.isCancelled
  }

  /// Bounds an attempt that would otherwise wait forever: no read in the
  /// handshake carries a deadline of its own, and until an attachment exists
  /// there is no heartbeat to notice. Closing the connection is what unblocks
  /// them — cancellation cannot reach a socket read.
  private func armAttemptWatchdog(_ generation: UInt64) {
    let clock = self.clock
    let bound = config.attemptTimeoutMs
    attemptWatchdog?.cancel()
    attemptWatchdog = Task { [weak self] in
      do { try await clock.sleep(millis: bound) } catch { return }
      await self?.abandonAttempt(generation)
    }
  }

  /// Close whatever the attempt is waiting on. Safe to call from anywhere: it
  /// compares the generation at commit like every other liveness effect.
  private func abandonAttempt(_ generation: UInt64) {
    guard self.generation == generation, let connection = attemptConnection else { return }
    attemptConnection = nil
    Task { await connection.close() }
  }

  /// Drop the in-flight attempt's transport whatever generation it belongs to.
  /// Used by suspension and local close, where the point is that *nothing*
  /// continues, not that a particular attempt does not.
  private func abandonAnyAttempt() {
    attemptWatchdog?.cancel()
    attemptWatchdog = nil
    if let connection = attemptConnection {
      attemptConnection = nil
      Task { await connection.close() }
    }
  }

  private func runAttempt() async -> AttemptOutcome {
    // Activation is early and Live is late (§4.2.2). The moment this advances,
    // every in-flight reader is stale and its late publishes drop — before any
    // replacement has read a byte.
    generation &+= 1
    let attemptGeneration = generation
    teardownCurrent()

    armAttemptWatchdog(attemptGeneration)
    defer {
      attemptWatchdog?.cancel()
      attemptWatchdog = nil
      attemptConnection = nil
    }

    let verdict = await listingVerdict()
    // The verdict is only actionable if this attempt still speaks for the
    // session: backgrounding during a listing must not end the session behind
    // the user's back.
    guard attemptIsCurrent(attemptGeneration) else { return .retry }
    if let verdict {
      commitEnded(verdict)
      return .ended
    }

    let connection: any MeshConnection
    do {
      connection = try await dialer.dial()
    } catch {
      return .retry
    }
    guard attemptIsCurrent(attemptGeneration) else {
      await connection.close()
      return .retry
    }
    attemptConnection = connection

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
        plan: planner,
        offeredMinor: offeredMinor)
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
    guard attemptIsCurrent(attemptGeneration) else {
      await attachment.detach()
      return .retry
    }
    lastAttachGeneration = info.supportsReconnect ? lineageGeneration : 0
    lastAttachCarriedResume = info.supportsReconnect && hint != nil
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

    // The attach is done, so the watchdog's job is over: from here the
    // heartbeat is the bound.
    attemptWatchdog?.cancel()
    attemptWatchdog = nil
    attemptConnection = nil
    guard await awaitFirstSnapshot(generation: attemptGeneration) else {
      // Leaving this attempt's reader alive under the current generation would
      // let it mutate a replica the user has already been told is frozen.
      teardownCurrent()
      return .retry
    }
    guard attemptIsCurrent(attemptGeneration) else { return .retry }

    attempt = 0
    absentSinceMs = nil
    lastContactMs = clock.nowMs
    advance(to: .live)
    // Only against a host that negotiated the reconnect minor. A `Ping` below
    // it is not ignored — it reaches the compact host's catch-all and closes
    // the connection — so probing a legacy host would manufacture the very
    // outage the heartbeat exists to detect. There, detection falls back to
    // the transport's own idle timeout (§5).
    if info.supportsReconnect {
      startHeartbeat(attachment: attachment, incarnation: attemptIncarnation)
    }

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
    let listing: GhostteaSessionListing?
    do {
      listing = try await dialer.listSessions()
    } catch {
      return nil
    }
    guard let listing else { return nil }
    // Evidence order, §4.2 step 2 before step 4: a different host instance is
    // a new world, and every absence it reports is a consequence of the
    // restart rather than evidence about the session. Comparing identity
    // second would end a recoverable session as "unavailable".
    if let recorded = hostInstanceID, recorded != listing.hostInstanceID {
      return .hostRestarted
    }
    guard let entry = listing.sessions.first(where: { $0.sessionID == sessionID }) else {
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
      //
      // Gated on the negotiated minor for the same reason the probe itself is:
      // below it, a liveness frame is not ignored but closes the connection.
      // A legacy host cannot have sent this, so answering could only be a
      // reply to something that is not a probe at all.
      guard incarnation == self.incarnation, let attachment = current,
        attachment.info.supportsReconnect
      else { return true }
      try? await attachment.pong(nonce: nonce)
      return true
    case .selectionText(let requestID, let text):
      // Answers are matched by request id and are not fenced by generation:
      // the caller awaiting one asked on this incarnation, and a stale answer
      // simply finds no waiter.
      if let waiter = selectionWaiters.removeValue(forKey: requestID) {
        ghostteaTraceSelection("response id=\(requestID) bytes=\(text.utf8.count)")
        waiter.resume(returning: text)
      } else {
        ghostteaTraceSelection("orphan response id=\(requestID) bytes=\(text.utf8.count)")
      }
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
      case .selectionChanged(let selection):
        if let selection {
          ghostteaTraceSelection(
            "state selection=(\(selection.anchor.column),\(selection.anchor.row))->(\(selection.focus.column),\(selection.focus.row)) generation=\(generation)"
          )
        } else {
          ghostteaTraceSelection("state selection=nil generation=\(generation)")
        }
      case .activityChanged, .configurationChanged:
        break
      }
      do {
        try await sink?.apply(
          message,
          from: GhostteaAttachmentStateToken(generation: generation, incarnation: incarnation))
      } catch GhostteaAttachmentApplyFailure.needsSnapshot {
        // A discontinuity is recoverable only through an authoritative
        // snapshot. The rejected frame is neither applied nor acknowledged.
        guard generation == self.generation, incarnation == self.incarnation else { return true }
        await requestSnapshotOnCurrentAttachment()
        return true
      } catch {
        commitDisconnect(generation: generation, incarnation: incarnation)
        return false
      }
      // Re-checked after the sink's await: applying is a suspension point, and
      // a snapshot that finished under a generation that has since been
      // retired must not be the one that unblocks input — nor the one this
      // connection acknowledges.
      guard generation == self.generation, incarnation == self.incarnation else { return true }
      await acknowledge(message)
      if case .snapshot = message { signalSynchronized(generation: generation) }
      return true
    }
  }

  /// The token frames are currently published under. A consumer holding an
  /// older one is looking at a session this attachment has moved past.
  public var currentStateToken: GhostteaAttachmentStateToken {
    GhostteaAttachmentStateToken(generation: generation, incarnation: incarnation)
  }

  /// What the last attach announced: the lineage generation and whether it
  /// carried resume evidence. Internal so the interop rows can assert the
  /// client half of a takeover, which is the half a client can actually see.
  var lastAttachOnTheWire: (generation: UInt64, carriedResume: Bool) {
    (lastAttachGeneration, lastAttachCarriedResume)
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
    resolveClaim(against: controller, revision: revision)
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

  /// Reads a claim's fate off the announcement that answers it. The host
  /// announces current state whether it accepted or rejected — the
  /// `ResizeRejected` pattern — so the announcement *is* the reply, and which
  /// of §4.2.3's asymmetric outcomes it is depends only on who holds control
  /// now and at which revision.
  private func resolveClaim(against controller: GhostteaControllerInfo?, revision: UInt64) {
    guard let claimedAgainst = claimedAgainstRevision, revision >= claimedAgainst else { return }
    guard let attachment = current else { return }
    if let controller {
      if controller.controllerViewID == attachment.viewID {
        claimOutcome = .claimed(controlEpoch: controller.controlEpoch, revision: revision)
      } else {
        // Another view holds it. Retrying here is the fight the CAS exists to
        // prevent, so the reclaim ends.
        claimOutcome = .lostToAnotherView(
          controllerViewID: controller.controllerViewID, revision: revision)
      }
    } else if revision > claimedAgainst {
      claimOutcome = .clearedAtNewerRevision(revision: revision)
    } else {
      return
    }
    claimedAgainstRevision = nil
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
    // Nothing can answer these now. Failing them is what keeps the liveness
    // bound honest: a caller awaiting a selection is released by the same
    // teardown that would have detected the silence.
    let pending = selectionWaiters
    selectionWaiters.removeAll()
    for waiter in pending.values {
      waiter.resume(
        throwing: GhostteaAttachmentControlRejection(phase: phase, reason: .attachmentEnded))
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
