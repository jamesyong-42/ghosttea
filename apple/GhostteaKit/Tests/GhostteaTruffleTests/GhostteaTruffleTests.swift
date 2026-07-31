import Foundation
import GhostteaCore
import GhostteaTruffle
import Testing
import Truffle

private struct ConnectionControlFixture: Decodable {
  let clientHello: GhostteaConnectionMessage
  let serverHello: GhostteaConnectionMessage
  let sessions: GhostteaConnectionMessage
}

private func presentation(
  revision: String = "presentation-1",
  fontSize: Float = 17
) -> GhostteaTerminalPresentationConfig {
  GhostteaTerminalPresentationConfig(
    schemaVersion: 1,
    revision: revision,
    foreground: [0xee, 0xee, 0xee],
    background: [0x11, 0x22, 0x33],
    cursor: [0xaa, 0xbb, 0xcc],
    selectionBackground: [0x44, 0x55, 0x66],
    selectionForeground: [0xff, 0xff, 0xff],
    fontSize: fontSize,
    fontFamilies: ["JetBrains Mono"],
    paddingX: [3, 4],
    paddingY: [5, 6],
    postProcess: .none,
    customShaderCount: 0
  )
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
    case .clientHello(let major, let minor, let host, let device, let nonce, let stateCodecs) =
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
  #expect(stateCodecs == nil)

  guard case .sessions(let requestID, let sessions) = fixture.sessions else {
    Issue.record("expected sessions")
    return
  }
  #expect(requestID == "request-1")
  #expect(sessions.first?.sessionID == "session-1")
  #expect(sessions.first?.readWrite == true)
  #expect(sessions.first?.activity == .unknown)
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
    nonce: "nonce-1",
    stateCodecs: [.compactJSONV1]
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
  #expect(object["stateCodecs"] as? [String] == ["compact-json-v1"])
  #expect(
    try GhostteaTerminalProtocolCodec.decodeFrame(
      GhostteaConnectionMessage.self,
      from: frame
    ) == message
  )
}

@Test func compactStateFixtureMatchesTheCanonicalRustTupleSchema() throws {
  let url = try #require(
    Bundle.module.url(
      forResource: "compact-state-v1",
      withExtension: "json",
      subdirectory: "Fixtures"
    )
  )
  let fixture = try #require(
    JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any]
  )
  func payload(_ key: String) throws -> Data {
    try JSONSerialization.data(withJSONObject: try #require(fixture[key]))
  }

  let snapshot = try GhostteaTerminalStateCodec.decode(
    payload("snapshot"), codec: .compactJSONV1)
  guard case .snapshot(let value) = snapshot else {
    Issue.record("expected compact snapshot")
    return
  }
  #expect(value.sessionEpoch == 7)
  #expect(value.terminalRevision == 11)
  #expect(value.cols == 3)
  #expect(value.rows.first?.text == "a界́")
  #expect(value.rows.first?.cells.first?.style.bold == true)
  #expect(value.rows.first?.cells.first?.style.underline == true)
  #expect(value.rows.first?.cells.first?.style.foreground == [1, 2, 3])
  #expect(value.rows.first?.cells.last?.style.strikethrough == true)
  #expect(value.rows.first?.cells.last?.span == 2)
  #expect(value.rows.first?.cells.last?.text == "界́")
  #expect(
    value.cursor == GhostteaLogicalCursor(x: 1, y: 0, visible: true, style: 2, blinking: true))
  #expect(value.scrollbar == GhostteaLogicalScrollbar(total: 20, offset: 10, len: 1))
  #expect(value.title == "title")
  #expect(value.cwd == "/cwd")

  let patch = try GhostteaTerminalStateCodec.decode(payload("patch"), codec: .compactJSONV1)
  guard case .patch(let value) = patch else {
    Issue.record("expected compact patch")
    return
  }
  #expect(value.patchSequence == 1)
  #expect(value.terminalRevision == 12)
  #expect(value.rowReplacements.first?.rowRevision == 12)
  #expect(value.mouseTracking == false)

  let control = try GhostteaTerminalStateCodec.decode(
    payload("controlChanged"), codec: .compactJSONV1)
  #expect(
    control
      == .controlChanged(
        controllerViewID: "view",
        controlEpoch: 9,
        cols: 2,
        rows: 1,
        layoutEpoch: 3
      ))
}

@Test func compactStateDecoderRejectsExtensionsFlagsAndMalformedColors() {
  let malformed = [
    #"{"p":[1,1,1,1,[],null,null,null,1]}"#,
    #"{"s":[1,1,1,1,[["x",[[0,1,"x",[128,null,null]]]]],[0,0,true,0,false],false,[1,0,1],null,null]}"#,
    #"{"s":[1,1,1,1,[["x",[[0,1,"x",[0,[1,2],null]]]]],[0,0,true,0,false],false,[1,0,1],null,null]}"#,
  ]
  for value in malformed {
    do {
      _ = try GhostteaTerminalStateCodec.decode(Data(value.utf8), codec: .compactJSONV1)
      Issue.record("accepted malformed compact state")
    } catch {}
  }
}

@Test func sessionControlMessagesUseDesktopCamelCaseIDKeys() throws {
  let attach = GhostteaSessionControlMessage.attachView(
    requestID: "request-1",
    sessionID: "session-1",
    viewID: "view-1",
    accessToken: nil,
    cols: 100,
    rows: 30
  )
  let attachObject = try #require(
    JSONSerialization.jsonObject(with: JSONEncoder().encode(attach)) as? [String: Any]
  )
  #expect(attachObject["requestId"] as? String == "request-1")
  #expect(attachObject["sessionId"] as? String == "session-1")
  #expect(attachObject["viewId"] as? String == "view-1")
  #expect(attachObject["requestID"] == nil)
  #expect(attachObject["sessionID"] == nil)
  #expect(attachObject["viewID"] == nil)

  let control = GhostteaTerminalStateMessage.controlChanged(
    controllerViewID: "view-1",
    controlEpoch: 2,
    cols: 100,
    rows: 30,
    layoutEpoch: 3
  )
  let controlObject = try #require(
    JSONSerialization.jsonObject(with: JSONEncoder().encode(control)) as? [String: Any]
  )
  #expect(controlObject["controllerViewId"] as? String == "view-1")
  #expect(controlObject["controllerViewID"] == nil)

  let activity = GhostteaSessionActivity(
    kind: .foregroundJob,
    source: .processGroup,
    confidence: .heuristic,
    rootProcessGroupID: 42,
    foregroundProcessGroupID: 43,
    observedAtMs: 100
  )
  let activityMessage = GhostteaTerminalStateMessage.activityChanged(activity)
  let activityObject = try #require(
    JSONSerialization.jsonObject(with: JSONEncoder().encode(activityMessage)) as? [String: Any]
  )
  #expect(activityObject["type"] as? String == "activity-changed")
  #expect(activityObject["activity"] as? [String: Any] != nil)
  #expect(
    try JSONDecoder().decode(
      GhostteaTerminalStateMessage.self,
      from: JSONEncoder().encode(activityMessage)
    ) == activityMessage
  )
  let compactActivity = try GhostteaTerminalStateCodec.decode(
    JSONSerialization.data(withJSONObject: [
      "a": [
        "kind": "foreground-job",
        "source": "process-group",
        "confidence": "heuristic",
        "rootProcessGroupId": 42,
        "foregroundProcessGroupId": 43,
        "observedAtMs": 100,
      ]
    ]),
    codec: .compactJSONV1
  )
  #expect(compactActivity == activityMessage)

  let configuration = GhostteaTerminalStateMessage.configurationChanged(presentation())
  let configurationObject = try #require(
    JSONSerialization.jsonObject(with: JSONEncoder().encode(configuration)) as? [String: Any]
  )
  #expect(configurationObject["type"] as? String == "configuration-changed")
  #expect(
    (configurationObject["presentation"] as? [String: Any])?["revision"] as? String
      == "presentation-1")
  #expect(
    try GhostteaTerminalStateCodec.decode(
      JSONEncoder().encode(["g": presentation()]),
      codec: .compactJSONV1
    ) == configuration
  )
}

@Test func presentationDecoderRejectsInvalidRemoteMetrics() throws {
  let invalid = """
    {
      "type": "configuration-changed",
      "presentation": {
        "schemaVersion": 1,
        "revision": "bad",
        "foreground": [1, 2, 3],
        "background": [4, 5, 6],
        "cursor": [7, 8, 9],
        "selectionBackground": [10, 11, 12],
        "selectionForeground": [13, 14, 15],
        "fontSize": -1,
        "fontFamilies": [],
        "paddingX": [2, 2],
        "paddingY": [2, 2],
        "postProcess": "none",
        "customShaderCount": 0
      }
    }
    """
  #expect(throws: GhostteaTruffleError.self) {
    try GhostteaTerminalStateCodec.decode(Data(invalid.utf8), codec: .json)
  }
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
  #expect(data[6] == 0 && data[7] == 5)
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
    case .clientHello(let major, let minor, _, let localDeviceID, let value, let codecs):
      #expect(major == 1)
      #expect(minor == GhostteaTruffleContract.protocolMinor)
      #expect(localDeviceID == "ios-device")
      #expect(codecs == [.compactJSONV1])
      nonce = value
    default:
      Issue.record("expected client hello")
      return
    }

    try await serverConnection.write(
      GhostteaTerminalProtocolCodec.encodeFrame(
        GhostteaConnectionMessage.serverHello(
          protocolMajor: 1,
          protocolMinor: 5,
          hostInstanceID: "desktop-instance",
          nonce: nonce,
          stateCodec: .compactJSONV1
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
          nonce: "wrong",
          stateCodec: nil
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

@Test func attachmentReportsWhetherEOFPrecedesTheSessionHello() async throws {
  let (clientConnection, serverConnection) = LoopbackConnection.makePair()
  await serverConnection.close()

  await #expect(
    throws: GhostteaTruffleError.handshakeRejected(
      "session hello failed: unexpectedEndOfStream")
  ) {
    try await GhostteaTruffleAttachment.connect(
      over: clientConnection,
      localDeviceID: "ios-device",
      sessionID: "session-1",
      viewID: "ios-view",
      cols: 100,
      rows: 30
    )
  }
}

@Test func attachmentReportsWhetherEOFPrecedesTheAttachResponse() async throws {
  let (clientConnection, serverConnection) = LoopbackConnection.makePair()
  let server = Task {
    let header = try await readExactly(16, from: serverConnection)
    _ = try await readExactly(Int(readUInt32(header, at: 12)), from: serverConnection)
    let hello: GhostteaConnectionMessage = try await readFrame(from: serverConnection)
    guard case .clientHello(_, _, _, _, let nonce, _) = hello else {
      Issue.record("expected client hello")
      return
    }
    try await serverConnection.write(
      GhostteaTerminalProtocolCodec.encodeFrame(
        GhostteaConnectionMessage.serverHello(
          protocolMajor: 1,
          protocolMinor: 3,
          hostInstanceID: "desktop-instance",
          nonce: nonce,
          stateCodec: nil
        )
      )
    )
    _ = try await readCompact(from: serverConnection)
    await serverConnection.close()
  }

  await #expect(
    throws: GhostteaTruffleError.handshakeRejected(
      "session attach failed: unexpectedEndOfStream")
  ) {
    try await GhostteaTruffleAttachment.connect(
      over: clientConnection,
      localDeviceID: "ios-device",
      sessionID: "session-1",
      viewID: "ios-view",
      cols: 100,
      rows: 30
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
    if case .clientHello(_, _, _, let deviceID, let value, let codecs) = hello {
      #expect(deviceID == "ios-device")
      #expect(codecs == [.compactJSONV1])
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
          nonce: nonce,
          stateCodec: nil
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
          readWrite: true,
          presentation: nil
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
    try await writeCompactJSON(
      """
      {
        "type": "snapshot",
        "sessionEpoch": 7,
        "layoutEpoch": 4,
        "terminalRevision": 13,
        "cols": 120,
        "rows": [{
          "text": "shared",
          "cells": [{
            "column": 0, "span": 1, "text": "shared",
            "style": {
              "bold": false, "italic": false, "faint": false,
              "inverse": false, "invisible": false, "strikethrough": false,
              "underline": false, "foreground": null, "background": null
            }
          }]
        }],
        "cursor": {"x": 6, "y": 0, "visible": true, "style": 0, "blinking": true},
        "mouseTracking": false,
        "scrollbar": {"total": 1, "offset": 0, "len": 1},
        "title": "desktop",
        "cwd": "/shared"
      }
      """,
      channel: .state,
      to: serverConnection
    )

    let (ackChannel, ackPayload) = try await readCompact(from: serverConnection)
    #expect(ackChannel == .control)
    let ack = try JSONDecoder().decode(GhostteaSessionControlMessage.self, from: ackPayload)
    #expect(
      ack
        == .stateAck(
          sessionEpoch: 7,
          layoutEpoch: 4,
          patchSequence: 0,
          terminalRevision: 13
        )
    )
    try await writeCompactJSON(
      """
      {
        "type": "patch",
        "sessionEpoch": 7,
        "layoutEpoch": 4,
        "patchSequence": 2,
        "terminalRevision": 14,
        "rowReplacements": [],
        "cursor": null,
        "mouseTracking": null,
        "scrollbar": null
      }
      """,
      channel: .state,
      to: serverConnection
    )
    let (resyncChannel, resyncPayload) = try await readCompact(from: serverConnection)
    #expect(resyncChannel == .control)
    let resync = try JSONDecoder().decode(GhostteaSessionControlMessage.self, from: resyncPayload)
    #expect(resync == .requestSnapshot)

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
  #expect(await attachment.stateCodec == .json)

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
  let runtime = try GhostteaRuntime()
  let pump = try GhostteaTruffleReplicaPump(
    attachment: attachment,
    runtime: runtime,
    sessionHandle: 91
  )
  switch try await pump.next() {
  case .frame(let update, let fullSnapshot):
    #expect(fullSnapshot)
    let frame = try #require(update.effects.first { $0.kind == .frameReady })
    #expect(frame.payload.starts(with: Data("TRF1".utf8)))
  default:
    Issue.record("expected locally rendered remote snapshot")
  }
  if case .resynchronizing = try await pump.next() {
    // Expected: patch sequence 2 was received while sequence 1 was missing.
  } else {
    Issue.record("expected a snapshot resynchronization request")
  }
  try await attachment.send(.text("echo shared\n"), sequence: 1)
  await attachment.detach()
  try await server.value
}

@Test func attachmentUsesNegotiatedCompactStateAndKeepsControlJSON() async throws {
  let (clientConnection, serverConnection) = LoopbackConnection.makePair()
  let server = Task {
    let header = try await readExactly(16, from: serverConnection)
    _ = try await readExactly(Int(readUInt32(header, at: 12)), from: serverConnection)
    let hello: GhostteaConnectionMessage = try await readFrame(from: serverConnection)
    guard case .clientHello(_, _, _, _, let nonce, let codecs) = hello else {
      Issue.record("expected client hello")
      return
    }
    #expect(codecs == [.compactJSONV1])
    try await serverConnection.write(
      GhostteaTerminalProtocolCodec.encodeFrame(
        GhostteaConnectionMessage.serverHello(
          protocolMajor: 1,
          protocolMinor: 3,
          hostInstanceID: "desktop-instance",
          nonce: nonce,
          stateCodec: .compactJSONV1
        )
      )
    )

    let (_, attachPayload) = try await readCompact(from: serverConnection)
    let attach = try JSONDecoder().decode(GhostteaSessionControlMessage.self, from: attachPayload)
    guard case .attachView(let requestID, _, _, _, _, _) = attach else {
      Issue.record("expected attach-view")
      return
    }
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
          readWrite: true,
          presentation: presentation(revision: "initial", fontSize: 13)
        )
      )
    )
    try await writeCompactJSON(
      String(
        decoding: try JSONEncoder().encode([
          "g": presentation(revision: "live", fontSize: 19)
        ]),
        as: UTF8.self),
      channel: .state,
      to: serverConnection
    )
    try await writeCompactJSON(
      #"{"c":["desktop-view",12,120,40,4]}"#,
      channel: .state,
      to: serverConnection
    )
    _ = try await readCompact(from: serverConnection)
  }

  let attachment = try await GhostteaTruffleAttachment.connect(
    over: clientConnection,
    localDeviceID: "ios-device",
    sessionID: "session-1",
    viewID: "ios-view",
    cols: 100,
    rows: 30,
    nonce: "compact-nonce",
    requestID: "compact-request"
  )
  #expect(await attachment.stateCodec == .compactJSONV1)
  let initial = presentation(revision: "initial", fontSize: 13)
  let live = presentation(revision: "live", fontSize: 19)
  #expect(await attachment.info.presentation == initial)
  let pump = try GhostteaTruffleReplicaPump(
    attachment: attachment,
    runtime: GhostteaRuntime(presentation: initial),
    sessionHandle: 92,
    presentation: initial
  )
  let previousReplica = await pump.replica
  if case .configurationChanged(let received) = try await pump.next() {
    #expect(received == live)
  } else {
    Issue.record("expected live presentation update")
  }
  let currentReplica = await pump.replica
  #expect(currentReplica !== previousReplica)
  switch try await pump.next() {
  case .controlChanged(let viewID, let epoch, let cols, let rows, let layout):
    #expect(viewID == "desktop-view")
    #expect(epoch == 12)
    #expect(cols == 120)
    #expect(rows == 40)
    #expect(layout == 4)
  default:
    Issue.record("expected compact control update")
  }
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

private func writeCompactJSON(
  _ json: String,
  channel: GhostteaCompactChannel,
  to connection: any MeshConnection
) async throws {
  let payload = Data(json.utf8)
  var size = UInt32(payload.count + 1).bigEndian
  var frame = Swift.withUnsafeBytes(of: &size) { Data($0) }
  frame.append(channel.rawValue)
  frame.append(payload)
  try await connection.write(frame)
}

private func readUInt32(_ data: Data, at offset: Int) -> UInt32 {
  data[offset..<offset + 4].reduce(UInt32(0)) { ($0 << 8) | UInt32($1) }
}
