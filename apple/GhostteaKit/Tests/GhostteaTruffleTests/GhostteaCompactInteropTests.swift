import Darwin
import Foundation
import GhostteaCore
import Network
import Testing
import Truffle

@testable import GhostteaTruffle

// MARK: - Fixture contract
//
// These rows dial a *real* Rust compact host over loopback TCP through the
// production attachment, dialer, and lifecycle. Nothing here is scripted: every
// frame is one the host actually produced. The driver that starts the fixture
// exports its port, session id, device id, and pid; without the port the whole
// suite is skipped rather than failed, so a plain `swift test` stays green.
//
// What this run cannot prove: the host's accept path resolves peers through
// Tailscale WhoIs, which cannot run off a tailnet, so the fixture substitutes a
// fixed client id for that result. Everything from ClientHello onward is
// production code over a production socket; the identity binding is the gap.

private enum Interop {
  static var port: UInt16? {
    ProcessInfo.processInfo.environment["GHOSTTEA_COMPACT_INTEROP_PORT"].flatMap(UInt16.init)
  }
  static var sessionID: String {
    ProcessInfo.processInfo.environment["GHOSTTEA_COMPACT_INTEROP_SESSION"] ?? "interop-session"
  }
  static var deviceID: String {
    ProcessInfo.processInfo.environment["GHOSTTEA_COMPACT_INTEROP_DEVICE"] ?? "interop-device"
  }
  static var hostPID: pid_t? {
    ProcessInfo.processInfo.environment["GHOSTTEA_COMPACT_INTEROP_PID"].flatMap(Int32.init)
  }
  static var isAvailable: Bool { port != nil }
}

// MARK: - Rows

@Suite(.enabled(if: Interop.isAvailable), .serialized)
struct GhostteaCompactInteropTests {
  /// Row 1. The whole minor-6 cycle against the real host, with the outage
  /// staged by stopping the host process — the honest version of the case the
  /// heartbeat exists for, since the socket stays open and the peer stays up
  /// while the host simply stops talking. Recovery is a real takeover: a second
  /// `attach_generation` carrying a `ResumeHint`, ordered by the host's own
  /// authority.
  @Test func aMinorSixPairRecoversFromAFrozenHostByTakingOver() async throws {
    let events = InteropEvents()
    let lifecycle = try interopLifecycle(localViewID: "interop-cycle", events: events)
    await lifecycle.start()
    defer { Task { await lifecycle.close() } }

    let live = try #require(await waitFor(lifecycle, seconds: 30) { $0.phase == .live })
    #expect(live.negotiatedMinor == 6)
    // Real frames from a real PTY: the fixture's shell prints two lines.
    #expect(await waitForFrames(events, atLeast: 1, seconds: 30))

    let pid = try #require(Interop.hostPID)
    #expect(kill(pid, SIGSTOP) == 0)
    var thawed = false
    defer { if !thawed { kill(pid, SIGCONT) } }

    // 6 s of silence is the fail window; bound generously for a slow machine.
    let dropped = await waitFor(lifecycle, seconds: 40) {
      if case .reconnecting = $0.phase { return true }
      return false
    }
    #expect(dropped != nil, "a frozen host must be detected by the heartbeat")

    #expect(kill(pid, SIGCONT) == 0)
    thawed = true
    let resumed = try #require(
      await waitFor(lifecycle, seconds: 60) { $0.phase == .live && $0.lifecycleSeq > live.lifecycleSeq
      })
    #expect(resumed.negotiatedMinor == 6)
  }

  /// Row 2. The pair-level version of `aLegacyHostIsNeverProbed` and the host's
  /// own quiet-legacy pin: neither test can prove the *pair*, because each
  /// asserts against its own expectations. Here the client offers minor 5 and
  /// then says nothing at all. If it probed, the host would answer a
  /// below-minor liveness frame by closing the connection, and this session
  /// would leave Live — so staying Live across several heartbeat windows is the
  /// assertion.
  @Test func aLegacyPairStaysLiveThroughSeveralHeartbeatWindows() async throws {
    let events = InteropEvents()
    let lifecycle = try interopLifecycle(
      localViewID: "interop-legacy", events: events, offeredMinor: 5)
    await lifecycle.start()
    defer { Task { await lifecycle.close() } }

    let live = try #require(await waitFor(lifecycle, seconds: 30) { $0.phase == .live })
    #expect(live.negotiatedMinor == 5)

    // Well past two fail windows of pure silence.
    try await Task.sleep(nanoseconds: 15 * 1_000_000_000)
    let after = await lifecycle.currentSnapshot
    #expect(after.phase == .live, "a legacy pair must survive being quiet")
    #expect(after.lifecycleSeq == live.lifecycleSeq, "nothing should have transitioned")
  }

  /// Row 3. Control CAS across the language boundary: the claim goes out
  /// through the production facade and the grant comes back as the host's own
  /// `ControlState`. The refusal path uses a second *view* rather than a second
  /// client, because control is per view and the fixture's client id is fixed.
  @Test func controlClaimsAndResizesAgreeWithTheHostsAuthority() async throws {
    let events = InteropEvents()
    let lifecycle = try interopLifecycle(localViewID: "interop-control", events: events)
    await lifecycle.start()
    defer { Task { await lifecycle.close() } }
    _ = try #require(await waitFor(lifecycle, seconds: 30) { $0.phase == .live })

    try await lifecycle.claimControl(cols: 100, rows: 30)
    let granted = await waitForValue(seconds: 30) { await lifecycle.heldControlEpoch }
    #expect(granted != nil, "the host must announce this view as the controller")
    try await lifecycle.resize(cols: 110, rows: 32)

    // A second view under the same client takes control; the first must then
    // refuse to resize rather than send an epoch that is no longer its own.
    let rival = try interopLifecycle(localViewID: "interop-control-rival", events: InteropEvents())
    await rival.start()
    defer { Task { await rival.close() } }
    _ = try #require(await waitFor(rival, seconds: 30) { $0.phase == .live })
    try await rival.claimControl(cols: 90, rows: 24)

    let surrendered = await waitForValue(seconds: 30) {
      await lifecycle.heldControlEpoch == nil ? true : nil
    }
    #expect(surrendered == true, "the host's re-announcement must clear this view's control")
    await #expect(throws: GhostteaAttachmentControlRejection.self) {
      try await lifecycle.resize(cols: 120, rows: 40)
    }
  }

  /// Row 4. `SelectionText` matched back to its request id, answered by the
  /// host's own extraction over the fixture's deterministic PTY content.
  @Test func selectionTextRoundTripsAgainstTheHostsExtraction() async throws {
    let events = InteropEvents()
    let lifecycle = try interopLifecycle(localViewID: "interop-selection", events: events)
    await lifecycle.start()
    defer { Task { await lifecycle.close() } }
    _ = try #require(await waitFor(lifecycle, seconds: 30) { $0.phase == .live })
    #expect(await waitForFrames(events, atLeast: 1, seconds: 30))

    let text = try await lifecycle.selectionText(GhostteaSelectionRequest(selectAll: true))
    #expect(text.contains("interop-line-1"))
    #expect(text.contains("interop-line-2"))
  }
}

// MARK: - Wiring

private func interopLifecycle(
  localViewID: String,
  events: InteropEvents,
  offeredMinor: UInt16 = GhostteaTruffleContract.protocolMinor
) throws -> GhostteaAttachmentLifecycle {
  GhostteaAttachmentLifecycle(
    sessionID: Interop.sessionID,
    localViewID: localViewID,
    cols: 100,
    rows: 30,
    dialer: InteropDialer(),
    sink: try GhostteaAttachmentReplicaSink(
      runtime: GhostteaRuntime(),
      sessionHandle: UInt64.random(in: 1...UInt64(UInt32.max)),
      presentation: nil
    ) { event in await events.record(event) },
    offeredMinor: offeredMinor)
}

/// Dials the fixture over real loopback TCP.
///
/// `listSessions` deliberately returns `nil` — "this client cannot ask". The
/// listing-evidence rules have their own unit coverage, and asking here would
/// mean a second connection per attempt whose read would hang for the length of
/// a deliberate freeze, turning row 1's outage into a stall rather than the
/// heartbeat detection it is meant to prove.
private struct InteropDialer: GhostteaAttachmentDialer {
  var localDeviceID: String { Interop.deviceID }

  func dial() async throws -> any MeshConnection {
    guard let port = Interop.port else {
      throw GhostteaTruffleError.hostUnavailable("interop fixture port is unset")
    }
    return try await TCPMeshConnection(port: port)
  }
}

private actor InteropEvents {
  private(set) var frames = 0
  private(set) var controllers: [GhostteaControllerInfo?] = []

  func record(_ event: GhostteaAttachmentSinkEvent) {
    switch event {
    case .frame: frames += 1
    case .controller(let info): controllers.append(info)
    case .activity, .presentation: break
    }
  }
}

// MARK: - Transport

/// `MeshConnection` over a real TCP socket. The production dialer reaches the
/// host through Truffle; interop reaches the same host through loopback, so the
/// bytes are identical and only the carrier differs.
private final class TCPMeshConnection: MeshConnection, @unchecked Sendable {
  private let connection: NWConnection
  private let queue = DispatchQueue(label: "ghosttea.compact.interop")
  private let lock = NSLock()
  private var settled = false
  private var closed = false

  init(port: UInt16) async throws {
    connection = NWConnection(
      host: .ipv4(.loopback),
      port: NWEndpoint.Port(rawValue: port) ?? .any,
      using: .tcp)
    try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
      connection.stateUpdateHandler = { [self] state in
        switch state {
        case .ready: resumeOnce { continuation.resume() }
        case .failed(let error): resumeOnce { continuation.resume(throwing: error) }
        case .cancelled:
          resumeOnce {
            continuation.resume(throwing: GhostteaTruffleError.unexpectedEndOfStream)
          }
        default: break
        }
      }
      connection.start(queue: queue)
    }
  }

  /// `stateUpdateHandler` fires repeatedly; a continuation may be resumed once.
  private func resumeOnce(_ body: () -> Void) {
    lock.lock()
    guard !settled else {
      lock.unlock()
      return
    }
    settled = true
    lock.unlock()
    body()
  }

  func read(_ max: Int) async throws -> Data? {
    try await withCheckedThrowingContinuation { continuation in
      connection.receive(minimumIncompleteLength: 1, maximumLength: Swift.max(1, max)) {
        data, _, isComplete, error in
        if let error {
          continuation.resume(throwing: error)
        } else if let data, !data.isEmpty {
          continuation.resume(returning: data)
        } else if isComplete {
          continuation.resume(returning: nil)
        } else {
          continuation.resume(returning: Data())
        }
      }
    }
  }

  func write(_ data: Data) async throws {
    try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
      connection.send(
        content: data,
        completion: .contentProcessed { error in
          if let error {
            continuation.resume(throwing: error)
          } else {
            continuation.resume()
          }
        })
    }
  }

  func close() async {
    guard claimClose() else { return }
    connection.cancel()
  }

  private func claimClose() -> Bool {
    lock.lock()
    defer { lock.unlock() }
    guard !closed else { return false }
    closed = true
    return true
  }
}

// MARK: - Waiting on a real clock

/// Polls rather than awaiting an event stream: these rows run against wall time
/// on a machine that may be slow, so every wait is bounded and a miss reads as
/// a failed expectation instead of a hung suite.
private func waitFor(
  _ lifecycle: GhostteaAttachmentLifecycle,
  seconds: Double,
  where predicate: @escaping @Sendable (GhostteaAttachmentSnapshot) -> Bool
) async -> GhostteaAttachmentSnapshot? {
  await waitForValue(seconds: seconds) {
    let snapshot = await lifecycle.currentSnapshot
    return predicate(snapshot) ? snapshot : nil
  }
}

private func waitForValue<T: Sendable>(
  seconds: Double,
  _ probe: @Sendable () async -> T?
) async -> T? {
  let deadline = Date().addingTimeInterval(seconds)
  while Date() < deadline {
    if let value = await probe() { return value }
    try? await Task.sleep(nanoseconds: 50_000_000)
  }
  return nil
}

private func waitForFrames(_ events: InteropEvents, atLeast count: Int, seconds: Double) async
  -> Bool
{
  await waitForValue(seconds: seconds) { await events.frames >= count ? true : nil } ?? false
}
