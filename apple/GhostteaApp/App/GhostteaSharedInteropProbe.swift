#if DEBUG
  import Foundation
  import GhostteaTruffle

  struct GhostteaSharedInteropProbeResult: Sendable {
    let selectionBytes: Int

    var marker: String {
      "GHOSTTEA_SHARED_INTEROP_PASS "
        + "handoff=a,b,a resize=97x31,113x37,101x29 "
        + "snapshot=1 selectionBytes=\(selectionBytes) reconnect=1"
    }
  }

  enum GhostteaSharedInteropProbeError: Error, CustomStringConvertible {
    case readOnlyAttachment
    case missingControl(viewID: String, cols: UInt16, rows: UInt16)
    case missingSnapshot
    case missingSelection(requestID: String)
    case emptySelection
    case timedOut(String)

    var description: String {
      switch self {
      case .readOnlyAttachment:
        "shared interop probe requires read-write access"
      case .missingControl(let viewID, let cols, let rows):
        "did not observe control for \(viewID) at \(cols)x\(rows)"
      case .missingSnapshot:
        "did not observe an authoritative snapshot"
      case .missingSelection(let requestID):
        "did not observe selection result \(requestID)"
      case .emptySelection:
        "select-all returned no terminal text"
      case .timedOut(let operation):
        "timed out waiting for \(operation)"
      }
    }
  }

  enum GhostteaSharedInteropProbe {
    static func run(
      directory: GhostteaTrufflePeerDirectory,
      host: GhostteaTruffleHostCandidate,
      session: GhostteaSharedSessionSummary
    ) async throws -> GhostteaSharedInteropProbeResult {
      let suffix = UUID().uuidString
      let viewA = "ghosttea-probe-a-\(suffix)"
      let viewB = "ghosttea-probe-b-\(suffix)"
      let viewC = "ghosttea-probe-c-\(suffix)"
      let attachmentA = try await directory.attach(
        to: host, sessionID: session.sessionID, viewID: viewA, cols: 97, rows: 31)
      var attachmentB: GhostteaTruffleAttachment?
      var attachmentC: GhostteaTruffleAttachment?

      do {
        guard await attachmentA.info.readWrite else {
          throw GhostteaSharedInteropProbeError.readOnlyAttachment
        }
        let second = try await directory.attach(
          to: host, sessionID: session.sessionID, viewID: viewB, cols: 97, rows: 31)
        attachmentB = second
        guard await second.info.readWrite else {
          throw GhostteaSharedInteropProbeError.readOnlyAttachment
        }

        try await attachmentA.claimControl(cols: 97, rows: 31, sequence: 1)
        try await expectControl(attachmentA, viewID: viewA, cols: 97, rows: 31)
        try await expectControl(second, viewID: viewA, cols: 97, rows: 31)

        try await second.claimControl(cols: 113, rows: 37, sequence: 1)
        try await expectControl(attachmentA, viewID: viewB, cols: 113, rows: 37)
        try await expectControl(second, viewID: viewB, cols: 113, rows: 37)

        try await second.requestSnapshot()
        try await expectSnapshot(second)

        let selectionRequest = "ghosttea-probe-selection-\(suffix)"
        _ = try await second.requestSelectionText(
          GhostteaSelectionRequest(selectAll: true), requestID: selectionRequest)
        let selection = try await expectSelection(second, requestID: selectionRequest)
        guard !selection.isEmpty else {
          throw GhostteaSharedInteropProbeError.emptySelection
        }

        await second.detach()
        attachmentB = nil
        try await attachmentA.claimControl(cols: 101, rows: 29, sequence: 2)
        try await expectControl(attachmentA, viewID: viewA, cols: 101, rows: 29)
        await attachmentA.detach()

        let reconnected = try await directory.attach(
          to: host, sessionID: session.sessionID, viewID: viewC, cols: 101, rows: 29)
        attachmentC = reconnected
        guard await reconnected.info.readWrite else {
          throw GhostteaSharedInteropProbeError.readOnlyAttachment
        }
        try await reconnected.requestSnapshot()
        try await expectSnapshot(reconnected)
        await reconnected.detach()
        attachmentC = nil

        return GhostteaSharedInteropProbeResult(selectionBytes: selection.utf8.count)
      } catch {
        await attachmentB?.detach()
        await attachmentC?.detach()
        await attachmentA.detach()
        throw error
      }
    }

    private static func expectControl(
      _ attachment: GhostteaTruffleAttachment,
      viewID: String,
      cols: UInt16,
      rows: UInt16
    ) async throws {
      for _ in 0..<64 {
        let event = try await nextEvent(
          attachment, operation: "control \(viewID) at \(cols)x\(rows)")
        guard
          case .state(.controlChanged(let controller, _, let actualCols, let actualRows, _)) =
            event
        else { continue }
        if controller == viewID, actualCols == cols, actualRows == rows { return }
      }
      throw GhostteaSharedInteropProbeError.missingControl(
        viewID: viewID, cols: cols, rows: rows)
    }

    private static func expectSnapshot(_ attachment: GhostteaTruffleAttachment) async throws {
      for _ in 0..<64 {
        let event = try await nextEvent(attachment, operation: "authoritative snapshot")
        if case .state(.snapshot) = event { return }
      }
      throw GhostteaSharedInteropProbeError.missingSnapshot
    }

    private static func expectSelection(
      _ attachment: GhostteaTruffleAttachment,
      requestID: String
    ) async throws -> String {
      for _ in 0..<64 {
        let event = try await nextEvent(attachment, operation: "selection \(requestID)")
        if case .selectionText(let responseID, let text) = event, responseID == requestID {
          return text
        }
      }
      throw GhostteaSharedInteropProbeError.missingSelection(requestID: requestID)
    }

    private static func nextEvent(
      _ attachment: GhostteaTruffleAttachment,
      operation: String
    ) async throws -> GhostteaAttachmentEvent {
      try await withThrowingTaskGroup(of: GhostteaAttachmentEvent.self) { group in
        group.addTask { try await attachment.nextEvent() }
        group.addTask {
          try await Task.sleep(for: .seconds(10))
          await attachment.detach()
          throw GhostteaSharedInteropProbeError.timedOut(operation)
        }
        guard let event = try await group.next() else {
          throw GhostteaSharedInteropProbeError.timedOut(operation)
        }
        group.cancelAll()
        return event
      }
    }
  }
#endif
