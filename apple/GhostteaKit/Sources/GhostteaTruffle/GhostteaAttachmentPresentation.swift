import Foundation

/// The visual treatment a banner asks for. The copy is already resolved; a
/// scene picks an icon and a colour from the kind and renders `title`/`detail`
/// verbatim.
public enum GhostteaAttachmentBannerKind: Equatable, Sendable {
  case reconnecting
  case synchronizing
  /// The brief acknowledgement that the session came back (§8.1).
  case resumed
  case suspended
  case ended
}

/// What a banner offers the user. `resume` and `retryNow` both re-enter
/// Reconnecting; they are separate cases because the copy that earns the tap
/// differs, and a scene may place them differently.
public enum GhostteaAttachmentBannerAction: Hashable, Sendable {
  case retryNow
  case resume
  case browseSessions
  case close
}

public struct GhostteaAttachmentBanner: Equatable, Sendable {
  public let kind: GhostteaAttachmentBannerKind
  public let title: String
  public let detail: String?
  public let actions: [GhostteaAttachmentBannerAction]
  /// Whether the retained frame should render "cooled" — visible and copyable,
  /// but plainly not live (§8.1).
  public let coolsTerminal: Bool

  public init(
    kind: GhostteaAttachmentBannerKind,
    title: String,
    detail: String? = nil,
    actions: [GhostteaAttachmentBannerAction] = [],
    coolsTerminal: Bool
  ) {
    self.kind = kind
    self.title = title
    self.detail = detail
    self.actions = actions
    self.coolsTerminal = coolsTerminal
  }
}

/// A transient, non-blocking note that a keystroke was dropped (§4.3). It is
/// never a queue receipt: the keystroke is gone.
public struct GhostteaAttachmentInputCue: Equatable, Sendable {
  public let text: String
}

/// Turns ``GhostteaAttachmentLifecycleEvent``s into the §8.1 banner vocabulary.
///
/// Pure and synchronous by design: every time-dependent answer is a function of
/// a caller-supplied `nowMs`, so the grace window, the resumed flash and the
/// honest "last contact" clock are all testable without waiting for them. The
/// scene drives redisplay from ``nextRefreshMs(at:)`` rather than a free-running
/// ticker.
public struct GhostteaAttachmentBannerPresenter: Sendable {
  /// How long a dropped-keystroke note stays up. Long enough to read once,
  /// short enough that a second dropped keystroke is a fresh signal.
  public static let inputCueMs: UInt64 = 2_500
  /// How long `✓ Reconnected` stays up before the banner clears (§8.1).
  public static let resumedFlashMs: UInt64 = 2_000

  public var deviceName: String

  private let graceMs: UInt64
  private var snapshot: GhostteaAttachmentSnapshot?
  /// When the last snapshot arrived, so the ages it carries keep counting up
  /// between events instead of freezing at whatever the actor measured.
  private var snapshotAtMs: UInt64 = 0
  /// When the current outage began, or `nil` while live. Held across
  /// reconnecting → synchronizing → reconnecting so a flapping resume does not
  /// keep restarting the grace window and hiding a real outage.
  private var outageBeganMs: UInt64?
  private var hasBeenLive = false
  private var resumedAtMs: UInt64?
  private var cue: PendingCue?

  private struct PendingCue: Equatable, Sendable {
    let text: String
    let atMs: UInt64
  }

  public init(
    deviceName: String,
    config: GhostteaReconnectConfig = GhostteaReconnectConfig()
  ) {
    self.deviceName = deviceName
    graceMs = config.bannerGraceMs
  }

  /// Whether the scene should let keystrokes through. Read from the lifecycle's
  /// own verdict rather than re-derived here: the actor rejects on the same
  /// rule, and a second opinion could only ever disagree with it.
  public var acceptsInput: Bool { snapshot?.acceptsInput ?? false }

  public var phase: GhostteaAttachmentPhase? { snapshot?.phase }

  // MARK: - Ingest

  public mutating func apply(_ event: GhostteaAttachmentLifecycleEvent, at nowMs: UInt64) {
    switch event {
    case .state(let next):
      applyState(next, at: nowMs)
    case .inputRejected(let rejection):
      cue = PendingCue(text: Self.cueText(for: rejection), atMs: nowMs)
    }
  }

  /// Raise a cue the scene decided on itself. Offline copy is the case this
  /// exists for: it is answered from the retained screen without touching the
  /// wire, so the lifecycle has no event to report and the scene would
  /// otherwise have no way to say what happened.
  public mutating func noteCue(_ text: String, at nowMs: UInt64) {
    cue = PendingCue(text: text, atMs: nowMs)
  }

  private mutating func applyState(_ next: GhostteaAttachmentSnapshot, at nowMs: UInt64) {
    // §3: every transition carries a monotonic `lifecycleSeq`, so an event that
    // lost a race is discarded rather than re-applied. Equal sequences are
    // admitted because a fresh subscription is seeded with the current
    // snapshot, which a scene may legitimately see twice.
    if let current = snapshot, next.lifecycleSeq < current.lifecycleSeq { return }
    snapshot = next
    snapshotAtMs = nowMs

    switch next.phase {
    case .live:
      // The flash acknowledges a *visible* outage. Flashing "Reconnected" after
      // a blip nobody saw is itself a blip, and after the very first attach it
      // would claim a recovery that never happened.
      if let began = outageBeganMs, hasBeenLive, nowMs &- began >= graceMs {
        resumedAtMs = nowMs
      }
      outageBeganMs = nil
      hasBeenLive = true
    case .opening, .reconnecting, .synchronizing:
      if outageBeganMs == nil { outageBeganMs = nowMs }
      resumedAtMs = nil
    case .suspended, .ended:
      // Neither is graced: both are states the user must be told about even if
      // they arrive in the first two seconds.
      outageBeganMs = nil
      resumedAtMs = nil
    }
  }

  // MARK: - Presentation

  public func banner(at nowMs: UInt64) -> GhostteaAttachmentBanner? {
    guard let snapshot else { return nil }
    switch snapshot.phase {
    case .live:
      guard let resumedAtMs, nowMs &- resumedAtMs < Self.resumedFlashMs else { return nil }
      return GhostteaAttachmentBanner(
        kind: .resumed, title: "Reconnected", coolsTerminal: false)

    // The scene owns the first-attach progress indicator; a banner here would
    // only say the same thing twice.
    case .opening:
      return nil

    case .reconnecting(let attempt, let nextRetryMs):
      guard graceElapsed(at: nowMs) else { return nil }
      return GhostteaAttachmentBanner(
        kind: .reconnecting,
        title: hasBeenLive
          ? "Connection to \(deviceName) lost — reconnecting…"
          : "Still connecting to \(deviceName)…",
        detail: reconnectingDetail(attempt: attempt, nextRetryMs: nextRetryMs, at: nowMs),
        coolsTerminal: true)

    case .synchronizing:
      guard graceElapsed(at: nowMs) else { return nil }
      return GhostteaAttachmentBanner(
        kind: .synchronizing, title: "Restoring session…", coolsTerminal: true)

    case .suspended(let reason):
      switch reason {
      case .hostAbsent:
        return GhostteaAttachmentBanner(
          kind: .suspended,
          title: "\(deviceName) is offline",
          detail: "Waiting for it to return.",
          actions: [.retryNow, .close],
          coolsTerminal: true)
      case .suspendedByApp:
        return GhostteaAttachmentBanner(
          kind: .suspended,
          title: "Paused while Ghosttea was in the background",
          detail: "The last screen is frozen until this session reconnects.",
          actions: [.resume, .close],
          coolsTerminal: true)
      case .accessDenied:
        // Deliberately no retry: §3 calls this a refusal a redial cannot
        // change, and offering one would invite the user to keep proving it.
        return GhostteaAttachmentBanner(
          kind: .suspended,
          title: "\(deviceName) refused this connection",
          detail: "The session is still running; this device is not allowed to attach.",
          actions: [.close],
          coolsTerminal: true)
      }

    case .ended(let reason):
      return endedBanner(reason, exitCode: snapshot.exitCode)
    }
  }

  /// The dropped-keystroke note, if one is still fresh.
  public func inputCue(at nowMs: UInt64) -> GhostteaAttachmentInputCue? {
    guard let cue, nowMs &- cue.atMs < Self.inputCueMs else { return nil }
    return GhostteaAttachmentInputCue(text: cue.text)
  }

  /// How long until this presenter would render differently on its own, in
  /// milliseconds, or `nil` when nothing is pending. Covers the grace window
  /// opening, the resumed flash closing, a cue expiring, and the one-second
  /// tick of the "last contact"/"retrying in" clocks.
  public func nextRefreshMs(at nowMs: UInt64) -> UInt64? {
    var deadlines: [UInt64] = []
    // A deadline that has already passed is not pending work. Reporting its
    // zero would ask the scene to wake immediately and forever, since waking
    // would not make an expired flash any more expired.
    func pending(_ remainder: UInt64) {
      if remainder > 0 { deadlines.append(remainder) }
    }
    if let cue {
      pending(remaining(from: cue.atMs, span: Self.inputCueMs, at: nowMs))
    }
    switch snapshot?.phase {
    case .live:
      if let resumedAtMs {
        pending(remaining(from: resumedAtMs, span: Self.resumedFlashMs, at: nowMs))
      }
    case .reconnecting, .synchronizing, .opening:
      if let began = outageBeganMs, nowMs &- began < graceMs {
        pending(remaining(from: began, span: graceMs, at: nowMs))
      } else if case .reconnecting = snapshot?.phase {
        // Both clauses of the reconnecting detail are second-resolution
        // clocks, so a second is exactly how often it can change.
        pending(1_000)
      }
    default:
      break
    }
    return deadlines.min()
  }

  // MARK: - Copy

  private func graceElapsed(at nowMs: UInt64) -> Bool {
    guard let began = outageBeganMs else { return true }
    return nowMs &- began >= graceMs
  }

  private func reconnectingDetail(
    attempt: UInt32, nextRetryMs: UInt64?, at nowMs: UInt64
  ) -> String? {
    var clauses: [String] = []
    // §12 measured reality: the first `reconnecting` event carries attempt 0
    // and no delay, because the engine has not decided on a schedule yet.
    // Both clauses are therefore optional, and their absence is not an error.
    if hasBeenLive, let age = snapshot?.lastContactAgeMs {
      clauses.append("last contact \(seconds(age &+ (nowMs &- snapshotAtMs))) s ago")
    }
    if attempt >= 1 {
      clauses.append("attempt \(attempt)")
    }
    if let nextRetryMs {
      let elapsed = nowMs &- snapshotAtMs
      clauses.append(
        elapsed >= nextRetryMs
          ? "retrying now"
          : "retrying in \(secondsRoundedUp(nextRetryMs &- elapsed)) s")
    }
    return clauses.isEmpty ? nil : clauses.joined(separator: " · ")
  }

  private func endedBanner(
    _ reason: GhostteaAttachmentEndReason, exitCode: Int32?
  ) -> GhostteaAttachmentBanner {
    // Every string below is reachable only from the reason the lifecycle
    // actually reported. There is no default arm on purpose: a new reason must
    // be given its own honest sentence rather than inheriting someone else's.
    let frozen = "This is a frozen snapshot of the last screen."
    switch reason {
    case .sessionExited:
      let title =
        exitCode.map { "Process exited (code \($0)) on \(deviceName)." }
        ?? "Process exited on \(deviceName)."
      return ended(title, detail: frozen)
    case .sessionClosed:
      return ended("Session closed on \(deviceName).", detail: frozen)
    case .sessionUnavailable:
      return ended("This session is no longer available on \(deviceName).", detail: frozen)
    case .hostRestarted:
      return ended("Session ended — \(deviceName) restarted.", detail: frozen)
    case .hostShutdown:
      return ended("Session ended — \(deviceName) shut down.", detail: frozen)
    case .closedLocally:
      return GhostteaAttachmentBanner(
        kind: .ended,
        title: "Disconnected from \(deviceName).",
        actions: [.close],
        coolsTerminal: true)
    }
  }

  private func ended(_ title: String, detail: String) -> GhostteaAttachmentBanner {
    GhostteaAttachmentBanner(
      kind: .ended,
      title: title,
      detail: detail,
      actions: [.browseSessions, .close],
      coolsTerminal: true)
  }

  /// Named for the phase the keystroke was *rejected in*, which the rejection
  /// carries, not the phase the session has reached since — the user asked
  /// about the keystroke they just typed.
  private static func cueText(for rejection: GhostteaAttachmentInputRejection) -> String {
    switch rejection.reason {
    case .readOnly:
      return "This session is read-only."
    case .writeFailed:
      return "Keystroke not delivered — reconnecting."
    case .noControl:
      return "Another view controls the terminal size."
    // Deliberately not named for copying, though `selectionText` is its only
    // source today: the reason covers any request whose attachment died before
    // the host answered, and the call site — which knows what it asked for — is
    // where a more specific sentence belongs.
    case .attachmentEnded:
      return "The connection dropped before that finished."
    case .notLive:
      switch rejection.phase {
      case .reconnecting, .opening:
        return "Keystrokes are not delivered while reconnecting."
      case .synchronizing:
        return "Keystrokes are not delivered while the session is restoring."
      case .suspended:
        return "Keystrokes are not delivered while the session is paused."
      case .ended:
        return "This session has ended. Keystrokes are not delivered."
      case .live:
        return "Keystroke not delivered."
      }
    }
  }

  private func remaining(from startMs: UInt64, span: UInt64, at nowMs: UInt64) -> UInt64 {
    let elapsed = nowMs &- startMs
    return elapsed >= span ? 0 : span &- elapsed
  }

  private func seconds(_ ms: UInt64) -> UInt64 { ms / 1_000 }

  private func secondsRoundedUp(_ ms: UInt64) -> UInt64 { (ms &+ 999) / 1_000 }
}
