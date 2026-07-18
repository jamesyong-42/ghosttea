import Foundation
import GhostteaTruffle
import Testing
import Truffle

private struct ConnectionControlFixture: Decodable {
  let clientHello: GhostteaConnectionMessage
  let serverHello: GhostteaConnectionMessage
  let sessions: GhostteaConnectionMessage
}

@Test func connectionControlFixtureIsSharedWithDesktopRust() throws {
  let url = try #require(
    Bundle.module.url(
      forResource: "connection-control-v1",
      withExtension: "json",
      subdirectory: "Fixtures"
    )
  )
  let fixture = try JSONDecoder().decode(
    ConnectionControlFixture.self,
    from: Data(contentsOf: url)
  )

  guard
    case .clientHello(let major, let minor, let host, let device, let nonce) =
      fixture.clientHello
  else {
    Issue.record("expected client hello")
    return
  }
  #expect(major == 1)
  #expect(minor == 3)
  #expect(host == "desktop-instance")
  #expect(device == "01J4K9M2Z8AB3RNYQPW6H5TC0X")
  #expect(nonce == "nonce-1")

  guard case .sessions(let requestID, let sessions) = fixture.sessions else {
    Issue.record("expected sessions")
    return
  }
  #expect(requestID == "request-1")
  #expect(sessions.first?.sessionID == "session-1")
  #expect(sessions.first?.readWrite == true)
}

@Test func persistentReferencesContainOnlyDurableTruffleAndSessionIdentity() throws {
  let host = try GhostteaTruffleHostReference(
    deviceID: "01J4K9M2Z8AB3RNYQPW6H5TC0X"
  )
  let reference = try GhostteaTruffleSessionReference(
    host: host,
    sessionID: "terminal-session-1"
  )
  let data = try JSONEncoder().encode(reference)
  let json = String(decoding: data, as: UTF8.self)

  #expect(json.contains("01J4K9M2Z8AB3RNYQPW6H5TC0X"))
  #expect(json.contains("terminal-session-1"))
  #expect(!json.contains("tailscale"))
  #expect(!json.contains("hostname"))
  #expect(!json.contains("peerRef"))
  #expect(try JSONDecoder().decode(GhostteaTruffleSessionReference.self, from: data) == reference)
}

@Test func connectionMessagesMatchDesktopSerdeShape() throws {
  let message = GhostteaConnectionMessage.clientHello(
    protocolMajor: 1,
    protocolMinor: 3,
    hostInstanceID: "local-host",
    localDeviceID: "device-1",
    nonce: "nonce-1"
  )
  let frame = try GhostteaTerminalProtocolCodec.encodeFrame(message)
  let payload = frame.dropFirst(4)
  let object = try #require(
    JSONSerialization.jsonObject(with: Data(payload)) as? [String: Any]
  )

  #expect(object["type"] as? String == "client-hello")
  #expect(object["protocolMajor"] as? Int == 1)
  #expect(object["protocolMinor"] as? Int == 3)
  #expect(object["hostInstanceId"] as? String == "local-host")
  #expect(object["localDeviceId"] as? String == "device-1")
  #expect(object["nonce"] as? String == "nonce-1")
  #expect(
    try GhostteaTerminalProtocolCodec.decodeFrame(
      GhostteaConnectionMessage.self,
      from: frame
    ) == message
  )
}

@Test func streamPrefaceMatchesTSP1HeaderAndDesktopMetadata() throws {
  let data = try GhostteaTerminalProtocolCodec.encodePreface(
    GhostteaTerminalStreamPreface(
      streamKind: .sessionControl,
      sessionID: "session-1",
      viewID: "view-1"
    )
  )

  #expect(Data(data.prefix(4)) == Data("TSP1".utf8))
  #expect(data[4] == 0 && data[5] == 1)
  #expect(data[6] == 0 && data[7] == 3)
  #expect(data[8] == 2)
  #expect(data[9] == 0 && data[10] == 0 && data[11] == 0)

  let metadataCount = Int(readUInt32(data, at: 12))
  #expect(metadataCount == data.count - 16)
  let metadata = try #require(
    JSONSerialization.jsonObject(with: Data(data.dropFirst(16))) as? [String: Any]
  )
  #expect(metadata["streamKind"] as? String == "session-control")
  #expect(metadata["sessionId"] as? String == "session-1")
  #expect(metadata["viewId"] as? String == "view-1")
}

@Test func hostClientHandshakesAndListsDesktopSessionsOverTruffleConnection() async throws {
  let (clientConnection, serverConnection) = LoopbackConnection.makePair()
  let server = Task {
    let header = try await readExactly(16, from: serverConnection)
    #expect(Data(header.prefix(4)) == Data("TSP1".utf8))
    #expect(header[8] == 1)
    let metadataCount = Int(readUInt32(header, at: 12))
    _ = try await readExactly(metadataCount, from: serverConnection)

    let hello: GhostteaConnectionMessage = try await readFrame(from: serverConnection)
    let nonce: String
    switch hello {
    case .clientHello(let major, let minor, _, let localDeviceID, let value):
      #expect(major == 1)
      #expect(minor == 3)
      #expect(localDeviceID == "ios-device")
      nonce = value
    default:
      Issue.record("expected client hello")
      return
    }

    try await serverConnection.write(
      GhostteaTerminalProtocolCodec.encodeFrame(
        GhostteaConnectionMessage.serverHello(
          protocolMajor: 1,
          protocolMinor: 3,
          hostInstanceID: "desktop-instance",
          nonce: nonce
        )
      )
    )

    let request: GhostteaConnectionMessage = try await readFrame(from: serverConnection)
    let requestID: String
    switch request {
    case .listSessions(let value): requestID = value
    default:
      Issue.record("expected list-sessions")
      return
    }
    try await serverConnection.write(
      GhostteaTerminalProtocolCodec.encodeFrame(
        GhostteaConnectionMessage.sessions(
          requestID: requestID,
          sessions: [
            GhostteaSharedSessionSummary(
              sessionID: "session-1",
              title: "vim",
              cwdLabel: "~/project100",
              running: true,
              attachable: true,
              readWrite: true,
              createdAtMs: 42
            )
          ]
        )
      )
    )
  }

  let client = try await GhostteaTruffleHostClient.connect(
    over: clientConnection,
    localDeviceID: "ios-device",
    nonce: "fixed-nonce"
  )
  #expect(await client.hostInstanceID == "desktop-instance")
  let sessions = try await client.listSessions(requestID: "fixed-request")
  #expect(sessions.count == 1)
  #expect(sessions.first?.sessionID == "session-1")
  #expect(sessions.first?.readWrite == true)
  await client.close()
  try await server.value
}

@Test func hostClientRejectsNonceMismatchAndClosesConnection() async throws {
  let (clientConnection, serverConnection) = LoopbackConnection.makePair()
  let server = Task {
    let header = try await readExactly(16, from: serverConnection)
    _ = try await readExactly(Int(readUInt32(header, at: 12)), from: serverConnection)
    let _: GhostteaConnectionMessage = try await readFrame(from: serverConnection)
    try await serverConnection.write(
      GhostteaTerminalProtocolCodec.encodeFrame(
        GhostteaConnectionMessage.serverHello(
          protocolMajor: 1,
          protocolMinor: 3,
          hostInstanceID: "desktop-instance",
          nonce: "wrong"
        )
      )
    )
  }

  await #expect(throws: GhostteaTruffleError.mismatchedResponse) {
    try await GhostteaTruffleHostClient.connect(
      over: clientConnection,
      localDeviceID: "ios-device",
      nonce: "expected"
    )
  }
  try await server.value
}

@Test func attachmentMultiplexesDesktopControlAndStateWithoutBufferingAStream() async throws {
  let (clientConnection, serverConnection) = LoopbackConnection.makePair()
  let server = Task {
    let header = try await readExactly(16, from: serverConnection)
    #expect(header[8] == 2)
    let metadata = try await readExactly(Int(readUInt32(header, at: 12)), from: serverConnection)
    let preface = try JSONDecoder().decode(GhostteaTerminalStreamPreface.self, from: metadata)
    #expect(preface.sessionID == "session-1")
    #expect(preface.viewID == "ios-view")

    let hello: GhostteaConnectionMessage = try await readFrame(from: serverConnection)
    let nonce: String
    if case .clientHello(_, _, _, let deviceID, let value) = hello {
      #expect(deviceID == "ios-device")
      nonce = value
    } else {
      Issue.record("expected client hello")
      return
    }
    try await serverConnection.write(
      GhostteaTerminalProtocolCodec.encodeFrame(
        GhostteaConnectionMessage.serverHello(
          protocolMajor: 1,
          protocolMinor: 3,
          hostInstanceID: "desktop-instance",
          nonce: nonce
        )
      )
    )

    let (attachChannel, attachPayload) = try await readCompact(from: serverConnection)
    #expect(attachChannel == .control)
    let attach = try JSONDecoder().decode(GhostteaSessionControlMessage.self, from: attachPayload)
    guard case .attachView(let requestID, let sessionID, let viewID, _, let cols, let rows) = attach
    else {
      Issue.record("expected attach-view")
      return
    }
    #expect(sessionID == "session-1")
    #expect(viewID == "ios-view")
    #expect(cols == 100)
    #expect(rows == 30)

    try await serverConnection.write(
      GhostteaTerminalProtocolCodec.encodeCompactFrame(
        .control,
        GhostteaSessionControlMessage.viewAttached(
          requestID: requestID,
          sessionEpoch: 7,
          layoutEpoch: 3,
          attachmentEpoch: 11,
          cols: 100,
          rows: 30,
          readWrite: true
        )
      )
    )
    try await serverConnection.write(
      GhostteaTerminalProtocolCodec.encodeCompactFrame(
        .state,
        GhostteaTerminalStateMessage.controlChanged(
          controllerViewID: "desktop-view",
          controlEpoch: 12,
          cols: 120,
          rows: 40,
          layoutEpoch: 4
        )
      )
    )

    let (inputChannel, inputPayload) = try await readCompact(from: serverConnection)
    #expect(inputChannel == .control)
    let input = try JSONDecoder().decode(GhostteaSessionControlMessage.self, from: inputPayload)
    guard case .input(let inputView, let attachmentEpoch, let sequence, let operation) = input
    else {
      Issue.record("expected terminal input")
      return
    }
    #expect(inputView == "ios-view")
    #expect(attachmentEpoch == 11)
    #expect(sequence == 1)
    #expect(operation == .text("echo shared\n"))

    let (detachChannel, detachPayload) = try await readCompact(from: serverConnection)
    #expect(detachChannel == .control)
    let detach = try JSONDecoder().decode(GhostteaSessionControlMessage.self, from: detachPayload)
    #expect(detach == .detach(viewID: "ios-view", attachmentEpoch: 11))
  }

  let attachment = try await GhostteaTruffleAttachment.connect(
    over: clientConnection,
    localDeviceID: "ios-device",
    sessionID: "session-1",
    viewID: "ios-view",
    cols: 100,
    rows: 30,
    nonce: "fixed-attachment-nonce",
    requestID: "fixed-attachment-request"
  )
  #expect(await attachment.info.hostInstanceID == "desktop-instance")
  #expect(await attachment.info.attachmentEpoch == 11)
  #expect(await attachment.info.readWrite)

  let event = try await attachment.nextEvent()
  #expect(
    event
      == .state(
        .controlChanged(
          controllerViewID: "desktop-view",
          controlEpoch: 12,
          cols: 120,
          rows: 40,
          layoutEpoch: 4
        )
      )
  )
  try await attachment.send(.text("echo shared\n"), sequence: 1)
  await attachment.detach()
  try await server.value
}

private func readExactly(
  _ count: Int,
  from connection: any MeshConnection
) async throws -> Data {
  var result = Data()
  while result.count < count {
    guard let chunk = try await connection.read(count - result.count), !chunk.isEmpty else {
      throw GhostteaTruffleError.unexpectedEndOfStream
    }
    result.append(chunk)
  }
  return result
}

private func readFrame<T: Decodable>(
  from connection: any MeshConnection
) async throws -> T {
  let header = try await readExactly(4, from: connection)
  let size = Int(readUInt32(header, at: 0))
  let payload = try await readExactly(size, from: connection)
  return try JSONDecoder().decode(T.self, from: payload)
}

private func readCompact(
  from connection: any MeshConnection
) async throws -> (GhostteaCompactChannel, Data) {
  let header = try await readExactly(4, from: connection)
  let size = Int(readUInt32(header, at: 0))
  guard size > 0 else { throw GhostteaTruffleError.malformedMessage }
  let framed = try await readExactly(size, from: connection)
  guard let channel = GhostteaCompactChannel(rawValue: framed[0]) else {
    throw GhostteaTruffleError.malformedMessage
  }
  return (channel, Data(framed.dropFirst()))
}

private func readUInt32(_ data: Data, at offset: Int) -> UInt32 {
  data[offset..<offset + 4].reduce(UInt32(0)) { ($0 << 8) | UInt32($1) }
}
