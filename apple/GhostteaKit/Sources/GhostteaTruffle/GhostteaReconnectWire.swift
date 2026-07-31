import CryptoKit
import Foundation

/// Resume evidence. Ordering does *not* live here — that is
/// `AttachView.attachGeneration`, which every attempt carries.
public struct GhostteaResumeHint: Codable, Equatable, Sendable {
  public let previousSessionEpoch: UInt64
  public let previousAttachmentEpoch: UInt64
  public let previousTerminalRevision: UInt64

  public init(
    previousSessionEpoch: UInt64,
    previousAttachmentEpoch: UInt64,
    previousTerminalRevision: UInt64
  ) {
    self.previousSessionEpoch = previousSessionEpoch
    self.previousAttachmentEpoch = previousAttachmentEpoch
    self.previousTerminalRevision = previousTerminalRevision
  }
}

public struct GhostteaControllerInfo: Codable, Equatable, Sendable {
  public let controllerViewID: String
  public let controlEpoch: UInt64

  enum CodingKeys: String, CodingKey {
    case controllerViewID = "controllerViewId"
    case controlEpoch
  }

  public init(controllerViewID: String, controlEpoch: UInt64) {
    self.controllerViewID = controllerViewID
    self.controlEpoch = controlEpoch
  }
}

/// Why a session is over, as the host reports it on the wire.
public enum GhostteaSessionEndReason: Codable, Equatable, Sendable {
  case exited(code: Int32?)
  case closed

  private enum CodingKeys: String, CodingKey { case type, code }

  public init(from decoder: Decoder) throws {
    let values = try decoder.container(keyedBy: CodingKeys.self)
    switch try values.decode(String.self, forKey: .type) {
    case "exited": self = .exited(code: try values.decodeIfPresent(Int32.self, forKey: .code))
    case "closed": self = .closed
    default: throw GhostteaTruffleError.malformedMessage
    }
  }

  public func encode(to encoder: Encoder) throws {
    var values = encoder.container(keyedBy: CodingKeys.self)
    switch self {
    case .exited(let code):
      try values.encode("exited", forKey: .type)
      try values.encodeIfPresent(code, forKey: .code)
    case .closed:
      try values.encode("closed", forKey: .type)
    }
  }
}

/// A closed set the decoder enforces: an unrecognized code decodes to
/// ``unknown``, which takes the ambiguous-failure path (close the connection,
/// advance the generation) rather than guessing at a scope.
public enum GhostteaAttachRejectCode: String, Codable, Equatable, Sendable {
  case staleResume = "stale-resume"
  case viewInvalid = "view-invalid"
  case viewLimit = "view-limit"
  case unknownSession = "unknown-session"
  case sessionEpochMismatch = "session-epoch-mismatch"
  case accessDenied = "access-denied"
  case unknown

  public init(from decoder: Decoder) throws {
    let raw = try decoder.singleValueContainer().decode(String.self)
    self = GhostteaAttachRejectCode(rawValue: raw) ?? .unknown
  }
}

/// What a compact client does about one rejection. A compact connection carries
/// exactly one view, so the §6.2 table collapses: terminal codes end the
/// session, `stale-resume` is discarded, and every other refusal is an attach
/// failure that redials under an advanced generation.
public enum GhostteaAttachRejectAction: Equatable, Sendable {
  /// The response is obsolete — a newer attempt for this lineage superseded
  /// it. Mark nothing; whatever the superseding attempt concludes governs.
  case discard
  /// This attempt failed. Redial under an advanced generation.
  case retry
  /// Terminal for the session.
  case end(GhostteaAttachmentEndReason)
  /// The host refused on grounds a redial cannot change, but the session is
  /// not known to be over. Come to rest rather than burning dials.
  case rest(GhostteaAttachmentSuspendReason)

  /// The §6.2 code/action table, compact scope. `retryable` on the wire is
  /// advisory telemetry: the table is authoritative and a host that
  /// contradicts it does not change what this client does.
  public init(code: GhostteaAttachRejectCode) {
    switch code {
    case .staleResume: self = .discard
    // View-scoped. One view per compact connection means there is nothing to
    // re-elect in place; a fresh generation is a fresh identity, so retry.
    case .viewInvalid: self = .retry
    // Admission control. The cap frees only once the connections pinning the
    // host's fence terminate, which redialing is exactly what does.
    case .viewLimit: self = .retry
    // Absence, with no tombstone lookup on the compact path to improve it.
    // Unavailable is the honest name for what we know.
    case .unknownSession: self = .end(.sessionUnavailable)
    case .sessionEpochMismatch: self = .end(.hostRestarted)
    // Never claim the session ended: it exists, we are not allowed in.
    case .accessDenied: self = .rest(.accessDenied)
    // A code this client predates: the ambiguous path.
    case .unknown: self = .retry
    }
  }
}

/// What one compact connection settled on. `negotiatedMinor` is read from
/// here, never from what the host advertises: the advertisement says what the
/// host offers, only the handshake says what this connection agreed to.
public struct GhostteaCompactHello: Equatable, Sendable {
  public let hostInstanceID: String
  public let negotiatedMinor: UInt16
  public let stateCodec: GhostteaStateCodec

  public init(hostInstanceID: String, negotiatedMinor: UInt16, stateCodec: GhostteaStateCodec) {
    self.hostInstanceID = hostInstanceID
    self.negotiatedMinor = negotiatedMinor
    self.stateCodec = stateCodec
  }

  public var supportsReconnect: Bool {
    UInt64(negotiatedMinor) >= GhostteaReconnectDefaults.remoteReconnectProtocolMinor
  }
}

/// The attach shape for one attempt, chosen once the negotiated minor is known.
public struct GhostteaAttachPlan: Equatable, Sendable {
  public var wireViewID: String
  /// Monotonic per lineage across every attempt. `0` declares a client that
  /// rotates instead of ordering — a host that sees it routes to the plain
  /// attach path rather than takeover.
  public var attachGeneration: UInt64
  public var resume: GhostteaResumeHint?
  public var wantsState: Bool

  public init(
    wireViewID: String, attachGeneration: UInt64 = 0, resume: GhostteaResumeHint? = nil,
    wantsState: Bool = true
  ) {
    self.wireViewID = wireViewID
    self.attachGeneration = attachGeneration
    self.resume = resume
    self.wantsState = wantsState
  }
}

public typealias GhostteaAttachPlanner = @Sendable (GhostteaCompactHello) -> GhostteaAttachPlan

/// The wire identity for one attach attempt.
///
/// Mirrors `wire_view_id`/`stable_wire_view_id` in `ghosttea-truffle`
/// byte for byte. The host caps view ids at 128 bytes, so long local ids are
/// hashed rather than truncated, and the `r:`/`h:` prefixes keep the two
/// namespaces disjoint: without them a short local id equal to another id's
/// hash would produce the same base.
public enum GhostteaWireViewIdentity {
  /// Local ids that still fit under the host's cap once the namespace prefix
  /// and the widest generation suffix are added.
  public static let maximumInlineLocalViewIDBytes = 98

  /// The rotation-free identity, for hosts that order attempts by
  /// `attachGeneration` instead. Reusing the id is the point there: takeover
  /// mints a fresh epoch for it.
  public static func stable(_ localViewID: String) -> String {
    if localViewID.utf8.count <= maximumInlineLocalViewIDBytes {
      return "r:\(localViewID)"
    }
    let digest = SHA256.hash(data: Data(localViewID.utf8))
    let hashed = digest.prefix(16).map { String(format: "%02x", $0) }.joined()
    return "h:\(hashed)"
  }

  /// The rotated identity a legacy host is fenced by: to it, every attempt is
  /// a brand-new view with a fresh epoch that no zombie cleanup can collide
  /// with.
  public static func rotated(_ localViewID: String, generation: UInt64) -> String {
    "\(stable(localViewID))#g\(generation)"
  }

  /// Best-effort inverse, used only for controller ids this client does not
  /// own: a peer's rotated id carries no local meaning, and leaving the
  /// rotation visible would make it compare unequal to itself. A local id that
  /// itself ends in `#g<digits>` is mis-split here — acceptable, because ids
  /// this client owns are resolved by identity before reaching this path.
  public static func localViewID(fromWire wireViewID: String) -> String? {
    var base = wireViewID
    if let separator = wireViewID.range(of: "#g", options: .backwards) {
      let generation = wireViewID[separator.upperBound...]
      if !generation.isEmpty, generation.allSatisfy(\.isASCII), generation.allSatisfy(\.isNumber) {
        base = String(wireViewID[..<separator.lowerBound])
      }
    }
    guard base.hasPrefix("r:") else { return nil }
    return String(base.dropFirst(2))
  }
}
