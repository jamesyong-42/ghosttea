import Foundation

/// The reconnect timings, in lockstep with Rust.
///
/// This enum is the single source for the Swift side; its counterpart is
/// `MeshReconnectConfig::default()` in `native/ghosttea/src/mesh.rs` together
/// with `REMOTE_RECONNECT_PROTOCOL_MINOR` in
/// `native/ghosttea/src/tunnel_protocol.rs`. A Rust unit test in
/// `ghosttea-truffle` reads *this file* with `include_str!` and asserts each
/// value equals its Rust constant, so the two planes cannot drift without a
/// build failing. Keep the declarations in the literal form
/// `public static let <name>: UInt64 = <digits>` — that test parses them.
public enum GhostteaReconnectDefaults {
  /// Silence on the current connection incarnation before a `Ping` goes out.
  /// Idle-triggered, never a fixed interval: a busy stream never pings.
  public static let heartbeatIdleMs: UInt64 = 3_000
  /// Total silence tolerated before the connection is declared dead. Measured
  /// from the same contact clock as `heartbeatIdleMs`, not an extra wait after
  /// the ping went out.
  public static let heartbeatFailMs: UInt64 = 6_000
  /// Full jitter, AWS definition: `uniform(0, min(cap, base · 2ⁿ))` floored.
  public static let backoffBaseMs: UInt64 = 500
  public static let backoffCapMs: UInt64 = 10_000
  public static let backoffFloorMs: UInt64 = 250
  /// How long a host may stay absent before the engine stops burning dials and
  /// the attachment comes to rest in Suspended, still watching.
  public static let suspendAfterMs: UInt64 = 600_000
  /// How long a synchronizing attachment waits for its recovery snapshot
  /// before abandoning the attempt.
  public static let synchronizeTimeoutMs: UInt64 = 10_000
  /// How long one attempt may spend dialing, listing, and handshaking before
  /// its transport is dropped. Nothing in that stretch has a deadline of its
  /// own — the heartbeat only exists once an attachment does — so without this
  /// a black-holed host parks the engine forever. Mirrors the Rust host's
  /// `HANDSHAKE_TIMEOUT`.
  public static let attemptTimeoutMs: UInt64 = 10_000
  /// The minor that gates every reconnect behaviour: ordered takeover,
  /// heartbeats, `ControlState`, `SessionEnded`/`HostShutdown`. The design doc
  /// calls this family "1.5"; minor 5 was spent by presentation sync.
  public static let remoteReconnectProtocolMinor: UInt64 = 6
}

/// Per-attachment recovery tunables. Defaults come from
/// ``GhostteaReconnectDefaults`` so tests can shorten the clock without
/// touching the pinned constants.
public struct GhostteaReconnectConfig: Sendable, Equatable {
  public var heartbeatIdleMs: UInt64
  public var heartbeatFailMs: UInt64
  public var backoffBaseMs: UInt64
  public var backoffCapMs: UInt64
  public var backoffFloorMs: UInt64
  public var suspendAfterMs: UInt64
  public var synchronizeTimeoutMs: UInt64
  public var attemptTimeoutMs: UInt64
  /// How long a blip may last before the UI is allowed to show a banner
  /// (§12). Purely presentational, and the one knob here with no Rust
  /// counterpart — the daemon never renders anything.
  ///
  /// There is deliberately no `zombiePurge` knob: on compact this client
  /// closes the abandoned connection itself, so the host's own
  /// detach-on-connection-death collects the stranded identity immediately and
  /// there is nothing left for a purge to accelerate.
  public var bannerGraceMs: UInt64

  public init(
    heartbeatIdleMs: UInt64 = GhostteaReconnectDefaults.heartbeatIdleMs,
    heartbeatFailMs: UInt64 = GhostteaReconnectDefaults.heartbeatFailMs,
    backoffBaseMs: UInt64 = GhostteaReconnectDefaults.backoffBaseMs,
    backoffCapMs: UInt64 = GhostteaReconnectDefaults.backoffCapMs,
    backoffFloorMs: UInt64 = GhostteaReconnectDefaults.backoffFloorMs,
    suspendAfterMs: UInt64 = GhostteaReconnectDefaults.suspendAfterMs,
    synchronizeTimeoutMs: UInt64 = GhostteaReconnectDefaults.synchronizeTimeoutMs,
    attemptTimeoutMs: UInt64 = GhostteaReconnectDefaults.attemptTimeoutMs,
    bannerGraceMs: UInt64 = 2_000
  ) {
    self.heartbeatIdleMs = heartbeatIdleMs
    self.heartbeatFailMs = heartbeatFailMs
    self.backoffBaseMs = backoffBaseMs
    self.backoffCapMs = backoffCapMs
    self.backoffFloorMs = backoffFloorMs
    self.suspendAfterMs = suspendAfterMs
    self.synchronizeTimeoutMs = synchronizeTimeoutMs
    self.attemptTimeoutMs = attemptTimeoutMs
    self.bannerGraceMs = bannerGraceMs
  }
}

/// Samples a delay from a backoff window, in milliseconds. Injectable for the
/// same reason Rust's `JitterSource` is: scheduling tests assert exact delays
/// instead of sampling a distribution.
public typealias GhostteaJitterSource = @Sendable (UInt64) -> UInt64

public enum GhostteaBackoff {
  /// Full jitter, AWS definition: the window doubles per attempt up to the cap
  /// and the delay is sampled uniformly inside it, so clients that lost the
  /// same host do not come back in lockstep and re-flood it. `attempt` is
  /// 0-based.
  public static func delayMs(
    _ config: GhostteaReconnectConfig,
    attempt: UInt32,
    jitter: GhostteaJitterSource
  ) -> UInt64 {
    let shift = min(attempt, 31)
    let scaled = config.backoffBaseMs.multipliedReportingOverflow(by: 1 << UInt64(shift))
    let window = min(scaled.overflow ? UInt64.max : scaled.partialValue, config.backoffCapMs)
    return max(min(jitter(window), window), config.backoffFloorMs)
  }

  public static let uniformJitter: GhostteaJitterSource = { window in
    window == 0 ? 0 : UInt64.random(in: 0...window)
  }
}

/// The clock the lifecycle reads and sleeps on. Injectable so heartbeat and
/// backoff tests run in microseconds instead of seconds.
public protocol GhostteaLifecycleClock: Sendable {
  var nowMs: UInt64 { get }
  func sleep(millis: UInt64) async throws
}

public struct GhostteaSystemClock: GhostteaLifecycleClock {
  public init() {}

  public var nowMs: UInt64 {
    UInt64(DispatchTime.now().uptimeNanoseconds / 1_000_000)
  }

  public func sleep(millis: UInt64) async throws {
    try await Task.sleep(nanoseconds: millis.multipliedReportingOverflow(by: 1_000_000).partialValue)
  }
}
