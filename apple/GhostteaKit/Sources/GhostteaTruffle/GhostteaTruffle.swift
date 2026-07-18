import Foundation
import Truffle

/// The versioned boundary between Ghosttea's terminal semantics and Truffle's
/// authenticated device mesh.
public enum GhostteaTruffleContract {
  public static let appID = "ghosttea-terminal"
  public static let serviceName = "terminal.v1"

  /// Raw-stream binding for Apple clients. The desktop QUIC listener remains
  /// on 9420 while the compact full-duplex binding is introduced separately.
  public static let compactTerminalPort: UInt16 = 9421

  public static let protocolMajor: UInt16 = 1
  public static let protocolMinor: UInt16 = 3
  public static let maximumControlMessageBytes = 1 * 1024 * 1024
  public static let maximumStateMessageBytes = 16 * 1024 * 1024
  public static let maximumPrefaceMetadataBytes = 4 * 1024
}

/// A host identity safe to persist across launches. Truffle `PeerRef`,
/// hostname, Tailscale ID, IP, and registry generation are deliberately absent.
public struct GhostteaTruffleHostReference: Codable, Hashable, Sendable {
  public let deviceID: String

  public init(deviceID: String) throws {
    guard !deviceID.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
      throw GhostteaTruffleError.invalidPersistentReference
    }
    self.deviceID = deviceID
  }
}

public struct GhostteaTruffleSessionReference: Codable, Hashable, Sendable {
  public let host: GhostteaTruffleHostReference
  public let sessionID: String

  public init(host: GhostteaTruffleHostReference, sessionID: String) throws {
    guard !sessionID.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
      throw GhostteaTruffleError.invalidPersistentReference
    }
    self.host = host
    self.sessionID = sessionID
  }
}

public struct GhostteaTruffleHostCandidate: Identifiable, Sendable {
  public let peer: Peer

  public var id: PeerRef { peer.ref }
  public var displayName: String { peer.displayName }
  public var isOnline: Bool { peer.online }

  /// Nil until Truffle's hello has confirmed the peer's durable app identity.
  public var persistentReference: GhostteaTruffleHostReference? {
    guard let deviceID = peer.deviceId else { return nil }
    return try? GhostteaTruffleHostReference(deviceID: deviceID)
  }

  public init(peer: Peer) {
    self.peer = peer
  }
}

public enum GhostteaTruffleError: Error, Equatable, Sendable {
  case invalidPersistentReference
  case hostUnavailable(String)
  case malformedPreface
  case malformedMessage
  case messageTooLarge(limit: Int)
  case unexpectedEndOfStream
  case unsupportedProtocol(major: UInt16, minor: UInt16)
  case handshakeRejected(String)
  case mismatchedResponse
}

/// Resolves generation-checked live peers while ensuring only durable Truffle
/// device IDs cross the workspace-restoration boundary.
public actor GhostteaTrufflePeerDirectory {
  private let node: MeshNode

  public init(node: MeshNode) {
    self.node = node
  }

  public func candidates() async -> [GhostteaTruffleHostCandidate] {
    await node.peers()
      .filter(\.online)
      .map(GhostteaTruffleHostCandidate.init(peer:))
      .sorted {
        $0.displayName.localizedCaseInsensitiveCompare($1.displayName) == .orderedAscending
      }
  }

  public func resolve(
    _ reference: GhostteaTruffleHostReference
  ) async throws -> GhostteaTruffleHostCandidate {
    guard let peer = try await node.peer(reference.deviceID), peer.online else {
      throw GhostteaTruffleError.hostUnavailable(reference.deviceID)
    }
    return GhostteaTruffleHostCandidate(peer: peer)
  }

  public func connect(
    to candidate: GhostteaTruffleHostCandidate
  ) async throws -> GhostteaTruffleHostClient {
    let connection = try await node.dial(
      to: candidate.peer,
      port: GhostteaTruffleContract.compactTerminalPort
    )
    let localPeer = await node.localPeer
    guard let localDeviceID = localPeer.deviceId else {
      await connection.close()
      throw GhostteaTruffleError.handshakeRejected("local Truffle device ID is unavailable")
    }
    return try await GhostteaTruffleHostClient.connect(
      over: connection,
      localDeviceID: localDeviceID
    )
  }
}

public enum GhostteaTerminalStreamKind: String, Codable, Sendable {
  case connectionControl = "connection-control"
  case sessionControl = "session-control"
  case liveState = "live-state"
  case scrollback
  case asset

  fileprivate var wireByte: UInt8 {
    switch self {
    case .connectionControl: 1
    case .sessionControl: 2
    case .liveState: 3
    case .scrollback: 4
    case .asset: 5
    }
  }
}

public struct GhostteaTerminalStreamPreface: Codable, Equatable, Sendable {
  public var streamKind: GhostteaTerminalStreamKind
  public var sessionID: String?
  public var viewID: String?

  enum CodingKeys: String, CodingKey {
    case streamKind
    case sessionID = "sessionId"
    case viewID = "viewId"
  }

  public init(
    streamKind: GhostteaTerminalStreamKind,
    sessionID: String? = nil,
    viewID: String? = nil
  ) {
    self.streamKind = streamKind
    self.sessionID = sessionID
    self.viewID = viewID
  }
}

public struct GhostteaSharedSessionSummary: Codable, Equatable, Sendable {
  public let sessionID: String
  public let title: String
  public let cwdLabel: String?
  public let running: Bool
  public let attachable: Bool
  public let readWrite: Bool
  public let createdAtMs: UInt64

  enum CodingKeys: String, CodingKey {
    case sessionID = "sessionId"
    case title
    case cwdLabel
    case running
    case attachable
    case readWrite
    case createdAtMs
  }

  public init(
    sessionID: String,
    title: String,
    cwdLabel: String?,
    running: Bool,
    attachable: Bool,
    readWrite: Bool,
    createdAtMs: UInt64
  ) {
    self.sessionID = sessionID
    self.title = title
    self.cwdLabel = cwdLabel
    self.running = running
    self.attachable = attachable
    self.readWrite = readWrite
    self.createdAtMs = createdAtMs
  }
}

public enum GhostteaConnectionMessage: Codable, Equatable, Sendable {
  case clientHello(
    protocolMajor: UInt16,
    protocolMinor: UInt16,
    hostInstanceID: String,
    localDeviceID: String,
    nonce: String
  )
  case serverHello(
    protocolMajor: UInt16,
    protocolMinor: UInt16,
    hostInstanceID: String,
    nonce: String
  )
  case listSessions(requestID: String)
  case sessions(requestID: String, sessions: [GhostteaSharedSessionSummary])
  case error(requestID: String?, code: String, message: String)

  private enum CodingKeys: String, CodingKey {
    case type
    case protocolMajor
    case protocolMinor
    case hostInstanceID = "hostInstanceId"
    case localDeviceID = "localDeviceId"
    case nonce
    case requestID = "requestId"
    case sessions
    case code
    case message
  }

  public init(from decoder: Decoder) throws {
    let values = try decoder.container(keyedBy: CodingKeys.self)
    switch try values.decode(String.self, forKey: .type) {
    case "client-hello":
      self = try .clientHello(
        protocolMajor: values.decode(UInt16.self, forKey: .protocolMajor),
        protocolMinor: values.decode(UInt16.self, forKey: .protocolMinor),
        hostInstanceID: values.decode(String.self, forKey: .hostInstanceID),
        localDeviceID: values.decode(String.self, forKey: .localDeviceID),
        nonce: values.decode(String.self, forKey: .nonce)
      )
    case "server-hello":
      self = try .serverHello(
        protocolMajor: values.decode(UInt16.self, forKey: .protocolMajor),
        protocolMinor: values.decode(UInt16.self, forKey: .protocolMinor),
        hostInstanceID: values.decode(String.self, forKey: .hostInstanceID),
        nonce: values.decode(String.self, forKey: .nonce)
      )
    case "list-sessions":
      self = try .listSessions(requestID: values.decode(String.self, forKey: .requestID))
    case "sessions":
      self = try .sessions(
        requestID: values.decode(String.self, forKey: .requestID),
        sessions: values.decode([GhostteaSharedSessionSummary].self, forKey: .sessions)
      )
    case "error":
      self = try .error(
        requestID: values.decodeIfPresent(String.self, forKey: .requestID),
        code: values.decode(String.self, forKey: .code),
        message: values.decode(String.self, forKey: .message)
      )
    default:
      throw GhostteaTruffleError.malformedMessage
    }
  }

  public func encode(to encoder: Encoder) throws {
    var values = encoder.container(keyedBy: CodingKeys.self)
    switch self {
    case .clientHello(let major, let minor, let host, let local, let nonce):
      try values.encode("client-hello", forKey: .type)
      try values.encode(major, forKey: .protocolMajor)
      try values.encode(minor, forKey: .protocolMinor)
      try values.encode(host, forKey: .hostInstanceID)
      try values.encode(local, forKey: .localDeviceID)
      try values.encode(nonce, forKey: .nonce)
    case .serverHello(let major, let minor, let host, let nonce):
      try values.encode("server-hello", forKey: .type)
      try values.encode(major, forKey: .protocolMajor)
      try values.encode(minor, forKey: .protocolMinor)
      try values.encode(host, forKey: .hostInstanceID)
      try values.encode(nonce, forKey: .nonce)
    case .listSessions(let requestID):
      try values.encode("list-sessions", forKey: .type)
      try values.encode(requestID, forKey: .requestID)
    case .sessions(let requestID, let sessions):
      try values.encode("sessions", forKey: .type)
      try values.encode(requestID, forKey: .requestID)
      try values.encode(sessions, forKey: .sessions)
    case .error(let requestID, let code, let message):
      try values.encode("error", forKey: .type)
      try values.encodeIfPresent(requestID, forKey: .requestID)
      try values.encode(code, forKey: .code)
      try values.encode(message, forKey: .message)
    }
  }
}

public enum GhostteaTerminalProtocolCodec {
  public static func encodePreface(
    _ preface: GhostteaTerminalStreamPreface
  ) throws -> Data {
    let metadata = try JSONEncoder().encode(preface)
    guard metadata.count <= GhostteaTruffleContract.maximumPrefaceMetadataBytes else {
      throw GhostteaTruffleError.messageTooLarge(
        limit: GhostteaTruffleContract.maximumPrefaceMetadataBytes
      )
    }

    var encoded = Data("TSP1".utf8)
    encoded.appendBigEndian(GhostteaTruffleContract.protocolMajor)
    encoded.appendBigEndian(GhostteaTruffleContract.protocolMinor)
    encoded.append(preface.streamKind.wireByte)
    encoded.append(contentsOf: [0, 0, 0])
    encoded.appendBigEndian(UInt32(metadata.count))
    encoded.append(metadata)
    return encoded
  }

  public static func encodeFrame<T: Encodable>(
    _ message: T,
    limit: Int = GhostteaTruffleContract.maximumControlMessageBytes
  ) throws -> Data {
    let payload = try JSONEncoder().encode(message)
    guard payload.count <= limit else {
      throw GhostteaTruffleError.messageTooLarge(limit: limit)
    }
    var encoded = Data()
    encoded.appendBigEndian(UInt32(payload.count))
    encoded.append(payload)
    return encoded
  }

  public static func decodeFrame<T: Decodable>(
    _ type: T.Type,
    from data: Data,
    limit: Int = GhostteaTruffleContract.maximumControlMessageBytes
  ) throws -> T {
    guard data.count >= 4 else { throw GhostteaTruffleError.malformedMessage }
    let size = Int(data.readBigEndianUInt32(at: 0))
    guard size <= limit else { throw GhostteaTruffleError.messageTooLarge(limit: limit) }
    guard data.count == 4 + size else { throw GhostteaTruffleError.malformedMessage }
    return try JSONDecoder().decode(T.self, from: data.dropFirst(4))
  }
}

/// A typed connection-control client. Session attachment is layered next; this
/// slice intentionally proves Truffle composition and exact desktop discovery
/// framing before adding the live-state replica.
public actor GhostteaTruffleHostClient {
  public private(set) var hostInstanceID: String = ""

  private let connection: any MeshConnection
  private var buffer = Data()

  private init(connection: any MeshConnection) {
    self.connection = connection
  }

  public static func connect(
    over connection: any MeshConnection,
    localDeviceID: String,
    nonce: String = UUID().uuidString
  ) async throws -> GhostteaTruffleHostClient {
    let client = GhostteaTruffleHostClient(connection: connection)
    do {
      try await client.performHandshake(localDeviceID: localDeviceID, nonce: nonce)
      return client
    } catch {
      await connection.close()
      throw error
    }
  }

  public func listSessions(
    requestID: String = UUID().uuidString
  ) async throws -> [GhostteaSharedSessionSummary] {
    try await write(.listSessions(requestID: requestID))
    let response: GhostteaConnectionMessage = try await read()
    switch response {
    case .sessions(let responseID, let sessions) where responseID == requestID:
      return sessions
    case .error(let responseID, let code, let message)
      where responseID == nil || responseID == requestID:
      throw GhostteaTruffleError.handshakeRejected("\(code): \(message)")
    default:
      throw GhostteaTruffleError.mismatchedResponse
    }
  }

  public func close() async {
    await connection.close()
  }

  private func performHandshake(localDeviceID: String, nonce: String) async throws {
    let preface = try GhostteaTerminalProtocolCodec.encodePreface(
      GhostteaTerminalStreamPreface(streamKind: .connectionControl)
    )
    try await connection.write(preface)
    try await write(
      .clientHello(
        protocolMajor: GhostteaTruffleContract.protocolMajor,
        protocolMinor: GhostteaTruffleContract.protocolMinor,
        hostInstanceID: "",
        localDeviceID: localDeviceID,
        nonce: nonce
      )
    )

    let response: GhostteaConnectionMessage = try await read()
    switch response {
    case .serverHello(let major, let minor, let host, let echoedNonce):
      guard major == GhostteaTruffleContract.protocolMajor,
        minor >= GhostteaTruffleContract.protocolMinor
      else {
        throw GhostteaTruffleError.unsupportedProtocol(major: major, minor: minor)
      }
      guard echoedNonce == nonce, !host.isEmpty else {
        throw GhostteaTruffleError.mismatchedResponse
      }
      hostInstanceID = host
    case .error(_, let code, let message):
      throw GhostteaTruffleError.handshakeRejected("\(code): \(message)")
    default:
      throw GhostteaTruffleError.mismatchedResponse
    }
  }

  private func write(_ message: GhostteaConnectionMessage) async throws {
    try await connection.write(GhostteaTerminalProtocolCodec.encodeFrame(message))
  }

  private func read<T: Decodable>() async throws -> T {
    let header = try await readExactly(4)
    let size = Int(header.readBigEndianUInt32(at: 0))
    guard size <= GhostteaTruffleContract.maximumControlMessageBytes else {
      throw GhostteaTruffleError.messageTooLarge(
        limit: GhostteaTruffleContract.maximumControlMessageBytes
      )
    }
    let payload = try await readExactly(size)
    return try JSONDecoder().decode(T.self, from: payload)
  }

  private func readExactly(_ count: Int) async throws -> Data {
    while buffer.count < count {
      guard let chunk = try await connection.read(max(4096, count - buffer.count)) else {
        throw GhostteaTruffleError.unexpectedEndOfStream
      }
      guard !chunk.isEmpty else { throw GhostteaTruffleError.unexpectedEndOfStream }
      buffer.append(chunk)
    }
    let result = Data(buffer.prefix(count))
    buffer.removeFirst(count)
    return result
  }
}

private extension Data {
  mutating func appendBigEndian<T: FixedWidthInteger>(_ value: T) {
    var bigEndian = value.bigEndian
    Swift.withUnsafeBytes(of: &bigEndian) { append(contentsOf: $0) }
  }

  func readBigEndianUInt32(at offset: Int) -> UInt32 {
    self[offset ..< offset + 4].reduce(UInt32(0)) { ($0 << 8) | UInt32($1) }
  }
}
