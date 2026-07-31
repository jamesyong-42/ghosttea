import Foundation
import GhostteaCore
import GhostteaPerformance
import Truffle

public enum GhostteaCompactChannel: UInt8, Sendable {
  case control = 1
  case state = 2
}

public struct GhostteaLogicalSnapshot: Codable, Equatable, Sendable {
  public let sessionEpoch: UInt64
  public let layoutEpoch: UInt64
  public let terminalRevision: UInt64
  public let cols: UInt16
  public let rows: [GhostteaLogicalRow]
  public let cursor: GhostteaLogicalCursor
  public let mouseTracking: Bool
  public let scrollbar: GhostteaLogicalScrollbar
  public let title: String?
  public let cwd: String?

  public init(
    sessionEpoch: UInt64, layoutEpoch: UInt64, terminalRevision: UInt64, cols: UInt16,
    rows: [GhostteaLogicalRow], cursor: GhostteaLogicalCursor, mouseTracking: Bool,
    scrollbar: GhostteaLogicalScrollbar, title: String?, cwd: String?
  ) {
    self.sessionEpoch = sessionEpoch
    self.layoutEpoch = layoutEpoch
    self.terminalRevision = terminalRevision
    self.cols = cols
    self.rows = rows
    self.cursor = cursor
    self.mouseTracking = mouseTracking
    self.scrollbar = scrollbar
    self.title = title
    self.cwd = cwd
  }
}

public struct GhostteaLogicalPatch: Codable, Equatable, Sendable {
  public let sessionEpoch: UInt64
  public let layoutEpoch: UInt64
  public let patchSequence: UInt64
  public let terminalRevision: UInt64
  public let rowReplacements: [GhostteaRowReplacement]
  public let cursor: GhostteaLogicalCursor?
  public let mouseTracking: Bool?
  public let scrollbar: GhostteaLogicalScrollbar?

  public init(
    sessionEpoch: UInt64, layoutEpoch: UInt64, patchSequence: UInt64,
    terminalRevision: UInt64, rowReplacements: [GhostteaRowReplacement],
    cursor: GhostteaLogicalCursor?, mouseTracking: Bool?, scrollbar: GhostteaLogicalScrollbar?
  ) {
    self.sessionEpoch = sessionEpoch
    self.layoutEpoch = layoutEpoch
    self.patchSequence = patchSequence
    self.terminalRevision = terminalRevision
    self.rowReplacements = rowReplacements
    self.cursor = cursor
    self.mouseTracking = mouseTracking
    self.scrollbar = scrollbar
  }
}

public struct GhostteaRowReplacement: Codable, Equatable, Sendable {
  public let rowIndex: UInt16
  public let rowRevision: UInt64
  public let row: GhostteaLogicalRow

  public init(rowIndex: UInt16, rowRevision: UInt64, row: GhostteaLogicalRow) {
    self.rowIndex = rowIndex
    self.rowRevision = rowRevision
    self.row = row
  }
}

public struct GhostteaLogicalScrollbar: Codable, Equatable, Sendable {
  public let total: UInt64
  public let offset: UInt64
  public let len: UInt64

  public init(total: UInt64, offset: UInt64, len: UInt64) {
    self.total = total
    self.offset = offset
    self.len = len
  }
}

public struct GhostteaLogicalRow: Codable, Equatable, Sendable {
  public let text: String
  public let cells: [GhostteaLogicalCell]

  public init(text: String, cells: [GhostteaLogicalCell]) {
    self.text = text
    self.cells = cells
  }
}

public struct GhostteaLogicalCell: Codable, Equatable, Sendable {
  public let column: UInt16
  public let span: UInt16
  public let text: String
  public let style: GhostteaLogicalCellStyle

  public init(column: UInt16, span: UInt16, text: String, style: GhostteaLogicalCellStyle) {
    self.column = column
    self.span = span
    self.text = text
    self.style = style
  }
}

public struct GhostteaLogicalCellStyle: Codable, Equatable, Sendable {
  public let bold: Bool
  public let italic: Bool
  public let faint: Bool
  public let inverse: Bool
  public let invisible: Bool
  public let strikethrough: Bool
  public let underline: Bool
  public let foreground: [UInt8]?
  public let background: [UInt8]?

  public init(
    bold: Bool, italic: Bool, faint: Bool, inverse: Bool, invisible: Bool,
    strikethrough: Bool, underline: Bool, foreground: [UInt8]?, background: [UInt8]?
  ) {
    self.bold = bold
    self.italic = italic
    self.faint = faint
    self.inverse = inverse
    self.invisible = invisible
    self.strikethrough = strikethrough
    self.underline = underline
    self.foreground = foreground
    self.background = background
  }
}

public struct GhostteaLogicalCursor: Codable, Equatable, Sendable {
  public let x: UInt16
  public let y: UInt16
  public let visible: Bool
  public let style: UInt8
  public let blinking: Bool

  public init(x: UInt16, y: UInt16, visible: Bool, style: UInt8, blinking: Bool) {
    self.x = x
    self.y = y
    self.visible = visible
    self.style = style
    self.blinking = blinking
  }
}

public enum GhostteaTerminalStateMessage: Codable, Equatable, Sendable {
  case snapshot(GhostteaLogicalSnapshot)
  case patch(GhostteaLogicalPatch)
  case controlChanged(
    controllerViewID: String,
    controlEpoch: UInt64,
    cols: UInt16,
    rows: UInt16,
    layoutEpoch: UInt64
  )
  case activityChanged(GhostteaSessionActivity)
  case configurationChanged(GhostteaTerminalPresentationConfig)
  /// The revisioned replacement for ``controlChanged``, which structurally
  /// cannot say "no controller" — its controller id is required. Hosts send
  /// this at the reconnect minor and above, clears included; this client keeps
  /// accepting ``controlChanged`` from legacy hosts.
  case controlState(
    controller: GhostteaControllerInfo?,
    controlRevision: UInt64,
    cols: UInt16,
    rows: UInt16,
    layoutEpoch: UInt64
  )
  case sessionEnded(GhostteaSessionEndReason)
  case hostShutdown

  private enum CodingKeys: String, CodingKey {
    case type
    case controllerViewID = "controllerViewId"
    case controlEpoch, cols, rows, layoutEpoch
    case activity
    case presentation
    case controller, controlRevision
    case reason
  }

  public init(from decoder: Decoder) throws {
    let values = try decoder.container(keyedBy: CodingKeys.self)
    switch try values.decode(String.self, forKey: .type) {
    case "snapshot": self = .snapshot(try GhostteaLogicalSnapshot(from: decoder))
    case "patch": self = .patch(try GhostteaLogicalPatch(from: decoder))
    case "control-changed":
      self = try .controlChanged(
        controllerViewID: values.decode(String.self, forKey: .controllerViewID),
        controlEpoch: values.decode(UInt64.self, forKey: .controlEpoch),
        cols: values.decode(UInt16.self, forKey: .cols),
        rows: values.decode(UInt16.self, forKey: .rows),
        layoutEpoch: values.decode(UInt64.self, forKey: .layoutEpoch)
      )
    case "activity-changed":
      self = try .activityChanged(values.decode(GhostteaSessionActivity.self, forKey: .activity))
    case "configuration-changed":
      let presentation = try values.decode(
        GhostteaTerminalPresentationConfig.self, forKey: .presentation)
      guard presentation.isValid else { throw GhostteaTruffleError.malformedMessage }
      self = .configurationChanged(presentation)
    case "control-state":
      self = try .controlState(
        controller: values.decodeIfPresent(GhostteaControllerInfo.self, forKey: .controller),
        controlRevision: values.decode(UInt64.self, forKey: .controlRevision),
        cols: values.decode(UInt16.self, forKey: .cols),
        rows: values.decode(UInt16.self, forKey: .rows),
        layoutEpoch: values.decode(UInt64.self, forKey: .layoutEpoch)
      )
    case "session-ended":
      self = try .sessionEnded(values.decode(GhostteaSessionEndReason.self, forKey: .reason))
    case "host-shutdown":
      self = .hostShutdown
    default: throw GhostteaTruffleError.malformedMessage
    }
  }

  public func encode(to encoder: Encoder) throws {
    switch self {
    case .snapshot(let snapshot):
      try snapshot.encode(to: encoder)
      var values = encoder.container(keyedBy: CodingKeys.self)
      try values.encode("snapshot", forKey: .type)
    case .patch(let patch):
      try patch.encode(to: encoder)
      var values = encoder.container(keyedBy: CodingKeys.self)
      try values.encode("patch", forKey: .type)
    case .controlChanged(let viewID, let epoch, let cols, let rows, let layout):
      var values = encoder.container(keyedBy: CodingKeys.self)
      try values.encode("control-changed", forKey: .type)
      try values.encode(viewID, forKey: .controllerViewID)
      try values.encode(epoch, forKey: .controlEpoch)
      try values.encode(cols, forKey: .cols)
      try values.encode(rows, forKey: .rows)
      try values.encode(layout, forKey: .layoutEpoch)
    case .activityChanged(let activity):
      var values = encoder.container(keyedBy: CodingKeys.self)
      try values.encode("activity-changed", forKey: .type)
      try values.encode(activity, forKey: .activity)
    case .configurationChanged(let presentation):
      var values = encoder.container(keyedBy: CodingKeys.self)
      try values.encode("configuration-changed", forKey: .type)
      try values.encode(presentation, forKey: .presentation)
    case .controlState(let controller, let revision, let cols, let rows, let layout):
      var values = encoder.container(keyedBy: CodingKeys.self)
      try values.encode("control-state", forKey: .type)
      try values.encodeIfPresent(controller, forKey: .controller)
      try values.encode(revision, forKey: .controlRevision)
      try values.encode(cols, forKey: .cols)
      try values.encode(rows, forKey: .rows)
      try values.encode(layout, forKey: .layoutEpoch)
    case .sessionEnded(let reason):
      var values = encoder.container(keyedBy: CodingKeys.self)
      try values.encode("session-ended", forKey: .type)
      try values.encode(reason, forKey: .reason)
    case .hostShutdown:
      var values = encoder.container(keyedBy: CodingKeys.self)
      try values.encode("host-shutdown", forKey: .type)
    }
  }
}

public struct GhostteaKeyInput: Codable, Equatable, Sendable {
  public let type: String
  public let key: String
  public let code: String
  public let `repeat`: Bool
  public let shift: Bool
  public let control: Bool
  public let alt: Bool
  public let meta: Bool
  public let unshiftedCodepoint: UInt32

  public init(
    type: String, key: String, code: String, repeat: Bool, shift: Bool, control: Bool,
    alt: Bool, meta: Bool, unshiftedCodepoint: UInt32
  ) {
    self.type = type
    self.key = key
    self.code = code
    self.repeat = `repeat`
    self.shift = shift
    self.control = control
    self.alt = alt
    self.meta = meta
    self.unshiftedCodepoint = unshiftedCodepoint
  }
}

public struct GhostteaMouseInput: Codable, Equatable, Sendable {
  public let action: String
  public let button: UInt8
  public let x: Float
  public let y: Float
  public let screenWidth: UInt32
  public let screenHeight: UInt32
  public let cellWidth: UInt32
  public let cellHeight: UInt32
  public let paddingLeft: UInt32
  public let paddingTop: UInt32
  public let shift: Bool
  public let control: Bool
  public let alt: Bool
  public let meta: Bool

  public init(
    action: String, button: UInt8, x: Float, y: Float, screenWidth: UInt32,
    screenHeight: UInt32, cellWidth: UInt32, cellHeight: UInt32,
    paddingLeft: UInt32, paddingTop: UInt32, shift: Bool, control: Bool,
    alt: Bool, meta: Bool
  ) {
    self.action = action
    self.button = button
    self.x = x
    self.y = y
    self.screenWidth = screenWidth
    self.screenHeight = screenHeight
    self.cellWidth = cellWidth
    self.cellHeight = cellHeight
    self.paddingLeft = paddingLeft
    self.paddingTop = paddingTop
    self.shift = shift
    self.control = control
    self.alt = alt
    self.meta = meta
  }
}

public enum GhostteaTunnelInput: Codable, Equatable, Sendable {
  case text(String)
  case paste(String)
  case key(GhostteaKeyInput)
  case mouse(GhostteaMouseInput)
  case scroll(Int64)
  case scrollTo(UInt64)
  case focus(Bool)
  case interrupt

  private enum CodingKeys: String, CodingKey { case type, value }

  public init(from decoder: Decoder) throws {
    let values = try decoder.container(keyedBy: CodingKeys.self)
    switch try values.decode(String.self, forKey: .type) {
    case "text": self = try .text(values.decode(String.self, forKey: .value))
    case "paste": self = try .paste(values.decode(String.self, forKey: .value))
    case "key": self = try .key(values.decode(GhostteaKeyInput.self, forKey: .value))
    case "mouse": self = try .mouse(values.decode(GhostteaMouseInput.self, forKey: .value))
    case "scroll": self = try .scroll(values.decode(Int64.self, forKey: .value))
    case "scroll-to": self = try .scrollTo(values.decode(UInt64.self, forKey: .value))
    case "focus": self = try .focus(values.decode(Bool.self, forKey: .value))
    case "interrupt": self = .interrupt
    default: throw GhostteaTruffleError.malformedMessage
    }
  }

  public func encode(to encoder: Encoder) throws {
    var values = encoder.container(keyedBy: CodingKeys.self)
    switch self {
    case .text(let value):
      try values.encode("text", forKey: .type)
      try values.encode(value, forKey: .value)
    case .paste(let value):
      try values.encode("paste", forKey: .type)
      try values.encode(value, forKey: .value)
    case .key(let value):
      try values.encode("key", forKey: .type)
      try values.encode(value, forKey: .value)
    case .mouse(let value):
      try values.encode("mouse", forKey: .type)
      try values.encode(value, forKey: .value)
    case .scroll(let value):
      try values.encode("scroll", forKey: .type)
      try values.encode(value, forKey: .value)
    case .scrollTo(let value):
      try values.encode("scroll-to", forKey: .type)
      try values.encode(value, forKey: .value)
    case .focus(let value):
      try values.encode("focus", forKey: .type)
      try values.encode(value, forKey: .value)
    case .interrupt:
      try values.encode("interrupt", forKey: .type)
    }
  }
}

public enum GhostteaSessionControlMessage: Codable, Equatable, Sendable {
  /// `attachGeneration` is monotonic per wire-view lineage across **every**
  /// attempt, initial retries included — the ordering mechanism a reconnect
  /// host fences takeover with. `0` declares a client that does not order its
  /// attempts, which is what a rotating client must say.
  case attachView(
    requestID: String, sessionID: String, viewID: String, accessToken: String?, cols: UInt16,
    rows: UInt16, attachGeneration: UInt64, resume: GhostteaResumeHint?, wantsState: Bool)
  case viewAttached(
    requestID: String, sessionEpoch: UInt64, layoutEpoch: UInt64, attachmentEpoch: UInt64,
    cols: UInt16, rows: UInt16, readWrite: Bool,
    presentation: GhostteaTerminalPresentationConfig?, resumed: Bool,
    controller: GhostteaControllerInfo?, controlRevision: UInt64)
  /// A definitive attach failure. Hosts that predate this variant can only
  /// close the stream, which reads as an ambiguous transport fault.
  case attachRejected(requestID: String, code: GhostteaAttachRejectCode, retryable: Bool)
  /// Compact-transport liveness: a compact connection carries exactly one view
  /// on one control channel, so heartbeats ride it directly.
  case ping(nonce: UInt64)
  case pong(nonce: UInt64)
  case focusAndResize(
    viewID: String, attachmentEpoch: UInt64, cols: UInt16, rows: UInt16, clientSequence: UInt64)
  case resize(
    viewID: String, attachmentEpoch: UInt64, controlEpoch: UInt64, resizeSequence: UInt64,
    cols: UInt16, rows: UInt16)
  case input(
    viewID: String, attachmentEpoch: UInt64, inputSequence: UInt64, operation: GhostteaTunnelInput)
  case stateAck(
    sessionEpoch: UInt64, layoutEpoch: UInt64, patchSequence: UInt64, terminalRevision: UInt64)
  case requestSnapshot
  case selectionText(
    requestID: String, viewID: String, attachmentEpoch: UInt64, startColumn: UInt16,
    startRow: UInt32, endColumn: UInt16, endRow: UInt32, selectAll: Bool)
  case selectionTextResult(requestID: String, text: String)
  case detach(viewID: String, attachmentEpoch: UInt64)

  private enum CodingKeys: String, CodingKey {
    case type
    case requestID = "requestId"
    case sessionID = "sessionId"
    case viewID = "viewId"
    case accessToken, cols, rows, sessionEpoch,
      layoutEpoch, attachmentEpoch, readWrite, controlEpoch, clientSequence,
      resizeSequence, inputSequence, operation, patchSequence, terminalRevision,
      startColumn, startRow, endColumn, endRow, selectAll, text, presentation
    case attachGeneration, resume, wantsState
    case resumed, controller, controlRevision
    case code, retryable, nonce
  }

  public init(from decoder: Decoder) throws {
    let v = try decoder.container(keyedBy: CodingKeys.self)
    switch try v.decode(String.self, forKey: .type) {
    case "attach-view":
      self = try .attachView(
        requestID: v.decode(String.self, forKey: .requestID),
        sessionID: v.decode(String.self, forKey: .sessionID),
        viewID: v.decode(String.self, forKey: .viewID),
        accessToken: v.decodeIfPresent(String.self, forKey: .accessToken),
        cols: v.decode(UInt16.self, forKey: .cols), rows: v.decode(UInt16.self, forKey: .rows),
        attachGeneration: v.decodeIfPresent(UInt64.self, forKey: .attachGeneration) ?? 0,
        resume: v.decodeIfPresent(GhostteaResumeHint.self, forKey: .resume),
        wantsState: v.decodeIfPresent(Bool.self, forKey: .wantsState) ?? true)
    case "view-attached":
      // Every reconnect field carries a default: a client at the reconnect
      // minor must still decode a legacy host's `ViewAttached`, which omits
      // all of them.
      self = try .viewAttached(
        requestID: v.decode(String.self, forKey: .requestID),
        sessionEpoch: v.decode(UInt64.self, forKey: .sessionEpoch),
        layoutEpoch: v.decode(UInt64.self, forKey: .layoutEpoch),
        attachmentEpoch: v.decode(UInt64.self, forKey: .attachmentEpoch),
        cols: v.decode(UInt16.self, forKey: .cols), rows: v.decode(UInt16.self, forKey: .rows),
        readWrite: v.decode(Bool.self, forKey: .readWrite),
        presentation: v.decodeIfPresent(
          GhostteaTerminalPresentationConfig.self, forKey: .presentation),
        resumed: v.decodeIfPresent(Bool.self, forKey: .resumed) ?? false,
        controller: v.decodeIfPresent(GhostteaControllerInfo.self, forKey: .controller),
        controlRevision: v.decodeIfPresent(UInt64.self, forKey: .controlRevision) ?? 0)
    case "attach-rejected":
      self = try .attachRejected(
        requestID: v.decode(String.self, forKey: .requestID),
        code: v.decode(GhostteaAttachRejectCode.self, forKey: .code),
        retryable: v.decodeIfPresent(Bool.self, forKey: .retryable) ?? false)
    case "ping": self = try .ping(nonce: v.decode(UInt64.self, forKey: .nonce))
    case "pong": self = try .pong(nonce: v.decode(UInt64.self, forKey: .nonce))
    case "focus-and-resize":
      self = try .focusAndResize(
        viewID: v.decode(String.self, forKey: .viewID),
        attachmentEpoch: v.decode(UInt64.self, forKey: .attachmentEpoch),
        cols: v.decode(UInt16.self, forKey: .cols), rows: v.decode(UInt16.self, forKey: .rows),
        clientSequence: v.decode(UInt64.self, forKey: .clientSequence))
    case "resize":
      self = try .resize(
        viewID: v.decode(String.self, forKey: .viewID),
        attachmentEpoch: v.decode(UInt64.self, forKey: .attachmentEpoch),
        controlEpoch: v.decode(UInt64.self, forKey: .controlEpoch),
        resizeSequence: v.decode(UInt64.self, forKey: .resizeSequence),
        cols: v.decode(UInt16.self, forKey: .cols), rows: v.decode(UInt16.self, forKey: .rows))
    case "input":
      self = try .input(
        viewID: v.decode(String.self, forKey: .viewID),
        attachmentEpoch: v.decode(UInt64.self, forKey: .attachmentEpoch),
        inputSequence: v.decode(UInt64.self, forKey: .inputSequence),
        operation: v.decode(GhostteaTunnelInput.self, forKey: .operation))
    case "state-ack":
      self = try .stateAck(
        sessionEpoch: v.decode(UInt64.self, forKey: .sessionEpoch),
        layoutEpoch: v.decode(UInt64.self, forKey: .layoutEpoch),
        patchSequence: v.decode(UInt64.self, forKey: .patchSequence),
        terminalRevision: v.decode(UInt64.self, forKey: .terminalRevision))
    case "request-snapshot": self = .requestSnapshot
    case "selection-text":
      self = try .selectionText(
        requestID: v.decode(String.self, forKey: .requestID),
        viewID: v.decode(String.self, forKey: .viewID),
        attachmentEpoch: v.decode(UInt64.self, forKey: .attachmentEpoch),
        startColumn: v.decode(UInt16.self, forKey: .startColumn),
        startRow: v.decode(UInt32.self, forKey: .startRow),
        endColumn: v.decode(UInt16.self, forKey: .endColumn),
        endRow: v.decode(UInt32.self, forKey: .endRow),
        selectAll: v.decode(Bool.self, forKey: .selectAll))
    case "selection-text-result":
      self = try .selectionTextResult(
        requestID: v.decode(String.self, forKey: .requestID),
        text: v.decode(String.self, forKey: .text))
    case "detach":
      self = try .detach(
        viewID: v.decode(String.self, forKey: .viewID),
        attachmentEpoch: v.decode(UInt64.self, forKey: .attachmentEpoch))
    default: throw GhostteaTruffleError.malformedMessage
    }
  }

  public func encode(to encoder: Encoder) throws {
    var v = encoder.container(keyedBy: CodingKeys.self)
    switch self {
    case .attachView(
      let request, let session, let view, let token, let cols, let rows, let generation,
      let resume, let wantsState):
      try v.encode("attach-view", forKey: .type)
      try v.encode(request, forKey: .requestID)
      try v.encode(session, forKey: .sessionID)
      try v.encode(view, forKey: .viewID)
      try v.encodeIfPresent(token, forKey: .accessToken)
      try v.encode(cols, forKey: .cols)
      try v.encode(rows, forKey: .rows)
      try v.encode(generation, forKey: .attachGeneration)
      try v.encodeIfPresent(resume, forKey: .resume)
      try v.encode(wantsState, forKey: .wantsState)
    case .viewAttached(
      let request, let session, let layout, let attachment, let cols, let rows, let write,
      let presentation, let resumed, let controller, let controlRevision):
      try v.encode("view-attached", forKey: .type)
      try v.encode(request, forKey: .requestID)
      try v.encode(session, forKey: .sessionEpoch)
      try v.encode(layout, forKey: .layoutEpoch)
      try v.encode(attachment, forKey: .attachmentEpoch)
      try v.encode(cols, forKey: .cols)
      try v.encode(rows, forKey: .rows)
      try v.encode(write, forKey: .readWrite)
      try v.encodeIfPresent(presentation, forKey: .presentation)
      try v.encode(resumed, forKey: .resumed)
      try v.encodeIfPresent(controller, forKey: .controller)
      try v.encode(controlRevision, forKey: .controlRevision)
    case .attachRejected(let request, let code, let retryable):
      try v.encode("attach-rejected", forKey: .type)
      try v.encode(request, forKey: .requestID)
      try v.encode(code.rawValue, forKey: .code)
      try v.encode(retryable, forKey: .retryable)
    case .ping(let nonce):
      try v.encode("ping", forKey: .type)
      try v.encode(nonce, forKey: .nonce)
    case .pong(let nonce):
      try v.encode("pong", forKey: .type)
      try v.encode(nonce, forKey: .nonce)
    case .focusAndResize(let view, let attachment, let cols, let rows, let sequence):
      try v.encode("focus-and-resize", forKey: .type)
      try v.encode(view, forKey: .viewID)
      try v.encode(attachment, forKey: .attachmentEpoch)
      try v.encode(cols, forKey: .cols)
      try v.encode(rows, forKey: .rows)
      try v.encode(sequence, forKey: .clientSequence)
    case .resize(let view, let attachment, let control, let sequence, let cols, let rows):
      try v.encode("resize", forKey: .type)
      try v.encode(view, forKey: .viewID)
      try v.encode(attachment, forKey: .attachmentEpoch)
      try v.encode(control, forKey: .controlEpoch)
      try v.encode(sequence, forKey: .resizeSequence)
      try v.encode(cols, forKey: .cols)
      try v.encode(rows, forKey: .rows)
    case .input(let view, let attachment, let sequence, let operation):
      try v.encode("input", forKey: .type)
      try v.encode(view, forKey: .viewID)
      try v.encode(attachment, forKey: .attachmentEpoch)
      try v.encode(sequence, forKey: .inputSequence)
      try v.encode(operation, forKey: .operation)
    case .stateAck(let session, let layout, let patch, let revision):
      try v.encode("state-ack", forKey: .type)
      try v.encode(session, forKey: .sessionEpoch)
      try v.encode(layout, forKey: .layoutEpoch)
      try v.encode(patch, forKey: .patchSequence)
      try v.encode(revision, forKey: .terminalRevision)
    case .requestSnapshot: try v.encode("request-snapshot", forKey: .type)
    case .selectionText(
      let request, let view, let attachment, let startColumn, let startRow, let endColumn,
      let endRow, let all):
      try v.encode("selection-text", forKey: .type)
      try v.encode(request, forKey: .requestID)
      try v.encode(view, forKey: .viewID)
      try v.encode(attachment, forKey: .attachmentEpoch)
      try v.encode(startColumn, forKey: .startColumn)
      try v.encode(startRow, forKey: .startRow)
      try v.encode(endColumn, forKey: .endColumn)
      try v.encode(endRow, forKey: .endRow)
      try v.encode(all, forKey: .selectAll)
    case .selectionTextResult(let request, let text):
      try v.encode("selection-text-result", forKey: .type)
      try v.encode(request, forKey: .requestID)
      try v.encode(text, forKey: .text)
    case .detach(let view, let attachment):
      try v.encode("detach", forKey: .type)
      try v.encode(view, forKey: .viewID)
      try v.encode(attachment, forKey: .attachmentEpoch)
    }
  }
}

public struct GhostteaAttachmentInfo: Equatable, Sendable {
  public let hostInstanceID: String
  public let sessionEpoch: UInt64
  public let layoutEpoch: UInt64
  public let attachmentEpoch: UInt64
  public let cols: UInt16
  public let rows: UInt16
  public let readWrite: Bool
  public let presentation: GhostteaTerminalPresentationConfig?
  /// The minor this connection negotiated. Every reconnect behaviour reads its
  /// gate from here rather than from what the host advertises: the
  /// advertisement says what the host offers, only the handshake says what
  /// this connection settled on.
  public let negotiatedMinor: UInt16
  /// Whether this attach replaced a live attachment of the same view.
  public let resumed: Bool
  public let controller: GhostteaControllerInfo?
  /// `0` is unreachable for a revisioned host (they initialize at 1) and
  /// therefore means "legacy host, controller state unknown" — never a
  /// compare-and-swappable observation.
  public let controlRevision: UInt64

  public var supportsReconnect: Bool {
    UInt64(negotiatedMinor) >= GhostteaReconnectDefaults.remoteReconnectProtocolMinor
  }
}

public enum GhostteaAttachmentEvent: Equatable, Sendable {
  case state(GhostteaTerminalStateMessage)
  case selectionText(requestID: String, text: String)
  case ping(nonce: UInt64)
  case pong(nonce: UInt64)
}

/// One remote terminal view over a dedicated Truffle byte stream. Reads are
/// demand-driven so backpressure reaches the mesh connection instead of being
/// hidden in an unbounded AsyncStream buffer.
public actor GhostteaTruffleAttachment {
  public let sessionID: String
  /// The identity this attachment carries on the wire. Against a legacy host
  /// it is rotated per attempt, so it is not the local view id and must not be
  /// used as one.
  public let viewID: String
  /// The stable identity this client knows the pane by, whatever the wire is
  /// currently calling it.
  public let localViewID: String
  public let info: GhostteaAttachmentInfo
  public let stateCodec: GhostteaStateCodec

  private let connection: any MeshConnection
  private var buffer = Data()
  private var detached = false

  private init(
    connection: any MeshConnection, sessionID: String, viewID: String, localViewID: String,
    info: GhostteaAttachmentInfo, stateCodec: GhostteaStateCodec, buffer: Data
  ) {
    self.connection = connection
    self.sessionID = sessionID
    self.viewID = viewID
    self.localViewID = localViewID
    self.info = info
    self.stateCodec = stateCodec
    self.buffer = buffer
  }

  /// One attach attempt over a fresh compact connection.
  ///
  /// `plan` chooses the attach shape *after* the hello, because the fencing
  /// shape depends on the negotiated minor and nothing before the hello knows
  /// it: against a reconnect host the wire identity is stable and ordered by a
  /// real `attachGeneration`, against a legacy host it is rotated per attempt
  /// and the generation stays `0`. Without a plan this attaches the way it
  /// always did — `viewID` verbatim, unordered.
  ///
  /// `offeredMinor` is the minor this attempt announces. It exists so a test
  /// can stage a legacy pair against a current host — the host answers
  /// `min(offered, its own)`, so nothing else can produce that pairing — and
  /// defaults to the contract minor, which is what production always sends.
  public static func connect(
    over connection: any MeshConnection, localDeviceID: String, sessionID: String, viewID: String,
    cols: UInt16, rows: UInt16, accessToken: String? = nil, nonce: String = UUID().uuidString,
    requestID: String = UUID().uuidString, plan: GhostteaAttachPlanner? = nil,
    offeredMinor: UInt16 = GhostteaTruffleContract.protocolMinor
  ) async throws -> GhostteaTruffleAttachment {
    let wire = GhostteaAttachmentHandshake(connection: connection)
    do {
      let hello: GhostteaCompactHello
      do {
        hello = try await wire.handshake(
          localDeviceID: localDeviceID, sessionID: sessionID, viewID: viewID, nonce: nonce,
          offeredMinor: offeredMinor)
      } catch {
        throw GhostteaTruffleError.handshakeRejected(
          "session hello failed: \(String(describing: error))")
      }
      let plan = plan?(hello) ?? GhostteaAttachPlan(wireViewID: viewID)
      try await wire.writeCompact(
        .control,
        GhostteaSessionControlMessage.attachView(
          requestID: requestID, sessionID: sessionID, viewID: plan.wireViewID,
          accessToken: accessToken, cols: cols, rows: rows,
          attachGeneration: plan.attachGeneration, resume: plan.resume,
          wantsState: plan.wantsState))
      let channel: GhostteaCompactChannel
      let payload: Data
      do {
        (channel, payload) = try await wire.readCompact()
      } catch {
        throw GhostteaTruffleError.handshakeRejected(
          "session attach failed: \(String(describing: error))")
      }
      guard channel == .control else { throw GhostteaTruffleError.mismatchedResponse }
      let response = try JSONDecoder().decode(GhostteaSessionControlMessage.self, from: payload)
      // A definitive refusal, distinguished from a closed stream so the caller
      // can act on the code instead of guessing at a transport fault.
      if case .attachRejected(let responseID, let code, _) = response, responseID == requestID {
        throw GhostteaTruffleError.attachRejected(code)
      }
      guard
        case .viewAttached(
          let responseID, let sessionEpoch, let layoutEpoch, let attachmentEpoch, let actualCols,
          let actualRows, let readWrite, let presentation, let resumed, let controller,
          let controlRevision) = response, responseID == requestID,
        presentation?.isValid != false
      else {
        throw GhostteaTruffleError.mismatchedResponse
      }
      let remainder = await wire.takeBuffer()
      return GhostteaTruffleAttachment(
        connection: connection, sessionID: sessionID, viewID: plan.wireViewID,
        localViewID: viewID,
        info: GhostteaAttachmentInfo(
          hostInstanceID: hello.hostInstanceID, sessionEpoch: sessionEpoch,
          layoutEpoch: layoutEpoch,
          attachmentEpoch: attachmentEpoch, cols: actualCols, rows: actualRows,
          readWrite: readWrite,
          presentation: presentation,
          negotiatedMinor: hello.negotiatedMinor,
          resumed: resumed,
          controller: controller,
          controlRevision: controlRevision
        ), stateCodec: hello.stateCodec, buffer: remainder)
    } catch {
      await connection.close()
      throw error
    }
  }

  public func nextEvent() async throws -> GhostteaAttachmentEvent {
    let (channel, payload) = try await readCompact()
    switch channel {
    case .state:
      return try .state(
        GhostteaPerformanceRecorder.shared.measure(
          .truffleStateDecode,
          byteCount: payload.count
        ) {
          try GhostteaTerminalStateCodec.decode(payload, codec: stateCodec)
        }
      )
    case .control:
      let message = try JSONDecoder().decode(GhostteaSessionControlMessage.self, from: payload)
      switch message {
      case .selectionTextResult(let requestID, let text):
        return .selectionText(requestID: requestID, text: text)
      case .ping(let nonce): return .ping(nonce: nonce)
      case .pong(let nonce): return .pong(nonce: nonce)
      default: throw GhostteaTruffleError.mismatchedResponse
      }
    }
  }

  /// Liveness probe on the compact control channel (§5). Answering a host's
  /// own `Ping` costs nothing and keeps the channel symmetric.
  public func ping(nonce: UInt64) async throws { try await write(.ping(nonce: nonce)) }

  public func pong(nonce: UInt64) async throws { try await write(.pong(nonce: nonce)) }

  public func claimControl(cols: UInt16, rows: UInt16, sequence: UInt64) async throws {
    try await write(
      .focusAndResize(
        viewID: viewID, attachmentEpoch: info.attachmentEpoch, cols: cols, rows: rows,
        clientSequence: sequence))
  }

  public func resize(cols: UInt16, rows: UInt16, controlEpoch: UInt64, sequence: UInt64)
    async throws
  {
    try await write(
      .resize(
        viewID: viewID, attachmentEpoch: info.attachmentEpoch, controlEpoch: controlEpoch,
        resizeSequence: sequence, cols: cols, rows: rows))
  }

  public func send(_ operation: GhostteaTunnelInput, sequence: UInt64) async throws {
    try await write(
      .input(
        viewID: viewID, attachmentEpoch: info.attachmentEpoch, inputSequence: sequence,
        operation: operation))
  }

  public func requestSnapshot() async throws { try await write(.requestSnapshot) }

  /// Requests authoritative selection extraction. The matching result is
  /// delivered through `nextEvent()` so the single demand-driven reader keeps
  /// ownership of the connection.
  @discardableResult
  public func requestSelectionText(
    _ selection: GhostteaSelectionRequest,
    requestID: String = UUID().uuidString
  ) async throws -> String {
    try await write(
      .selectionText(
        requestID: requestID,
        viewID: viewID,
        attachmentEpoch: info.attachmentEpoch,
        startColumn: selection.startColumn,
        startRow: selection.startRow,
        endColumn: selection.endColumn,
        endRow: selection.endRow,
        selectAll: selection.selectAll))
    return requestID
  }

  public func acknowledge(_ state: GhostteaLogicalSnapshot, patchSequence: UInt64 = 0) async throws
  {
    try await acknowledge(
      sessionEpoch: state.sessionEpoch,
      layoutEpoch: state.layoutEpoch,
      patchSequence: patchSequence,
      terminalRevision: state.terminalRevision
    )
  }

  public func acknowledge(
    sessionEpoch: UInt64,
    layoutEpoch: UInt64,
    patchSequence: UInt64,
    terminalRevision: UInt64
  ) async throws {
    try await write(
      .stateAck(
        sessionEpoch: sessionEpoch, layoutEpoch: layoutEpoch,
        patchSequence: patchSequence, terminalRevision: terminalRevision))
  }

  public func detach() async {
    guard !detached else { return }
    try? await write(.detach(viewID: viewID, attachmentEpoch: info.attachmentEpoch))
    detached = true
    await connection.close()
  }

  private func write(_ message: GhostteaSessionControlMessage) async throws {
    guard !detached else { throw GhostteaTruffleError.unexpectedEndOfStream }
    try await connection.write(
      try GhostteaTerminalProtocolCodec.encodeCompactFrame(.control, message))
  }

  private func readCompact() async throws -> (GhostteaCompactChannel, Data) {
    let header = try await readExactly(4)
    let size = Int(header.readGhostteaUInt32(at: 0))
    guard size > 0 else { throw GhostteaTruffleError.malformedMessage }
    let framed = try await readExactly(size)
    guard let channel = GhostteaCompactChannel(rawValue: framed[0]) else {
      throw GhostteaTruffleError.malformedMessage
    }
    let limit =
      channel == .control
      ? GhostteaTruffleContract.maximumControlMessageBytes
      : GhostteaTruffleContract.maximumStateMessageBytes
    guard size - 1 <= limit else { throw GhostteaTruffleError.messageTooLarge(limit: limit) }
    return (channel, Data(framed.dropFirst()))
  }

  private func readExactly(_ count: Int) async throws -> Data {
    while buffer.count < count {
      guard let chunk = try await connection.read(max(4096, count - buffer.count)), !chunk.isEmpty
      else { throw GhostteaTruffleError.unexpectedEndOfStream }
      buffer.append(chunk)
    }
    let result = Data(buffer.prefix(count))
    buffer.removeFirst(count)
    return result
  }
}

public struct GhostteaSelectionRequest: Equatable, Sendable {
  public let startColumn: UInt16
  public let startRow: UInt32
  public let endColumn: UInt16
  public let endRow: UInt32
  public let selectAll: Bool

  public init(
    startColumn: UInt16 = 0, startRow: UInt32 = 0, endColumn: UInt16 = 0,
    endRow: UInt32 = 0, selectAll: Bool = false
  ) {
    self.startColumn = startColumn
    self.startRow = startRow
    self.endColumn = endColumn
    self.endRow = endRow
    self.selectAll = selectAll
  }
}

private actor GhostteaAttachmentHandshake {
  let connection: any MeshConnection
  var buffer = Data()
  init(connection: any MeshConnection) { self.connection = connection }

  func handshake(
    localDeviceID: String, sessionID: String, viewID: String, nonce: String, offeredMinor: UInt16
  ) async throws -> GhostteaCompactHello {
    try await connection.write(
      try GhostteaTerminalProtocolCodec.encodePreface(
        .init(streamKind: .sessionControl, sessionID: sessionID, viewID: viewID)))
    try await connection.write(
      try GhostteaTerminalProtocolCodec.encodeFrame(
        GhostteaConnectionMessage.clientHello(
          protocolMajor: GhostteaTruffleContract.protocolMajor,
          protocolMinor: offeredMinor, hostInstanceID: "",
          localDeviceID: localDeviceID, nonce: nonce,
          stateCodecs: [.compactJSONV1])))
    let response: GhostteaConnectionMessage = try await readFrame()
    guard case .serverHello(let major, let minor, let host, let echoed, let stateCodec) = response,
      major == GhostteaTruffleContract.protocolMajor,
      minor > 0, echoed == nonce, !host.isEmpty
    else { throw GhostteaTruffleError.mismatchedResponse }
    return GhostteaCompactHello(
      hostInstanceID: host, negotiatedMinor: minor, stateCodec: stateCodec ?? .json)
  }

  func writeCompact<T: Encodable>(_ channel: GhostteaCompactChannel, _ value: T) async throws {
    try await connection.write(try GhostteaTerminalProtocolCodec.encodeCompactFrame(channel, value))
  }
  func readCompact() async throws -> (GhostteaCompactChannel, Data) {
    let header = try await readExactly(4)
    let size = Int(header.readGhostteaUInt32(at: 0))
    guard size > 0 else { throw GhostteaTruffleError.malformedMessage }
    let frame = try await readExactly(size)
    guard let channel = GhostteaCompactChannel(rawValue: frame[0]) else {
      throw GhostteaTruffleError.malformedMessage
    }
    return (channel, Data(frame.dropFirst()))
  }
  func takeBuffer() -> Data {
    defer { buffer.removeAll() }
    return buffer
  }
  private func readFrame<T: Decodable>() async throws -> T {
    let header = try await readExactly(4)
    let size = Int(header.readGhostteaUInt32(at: 0))
    let payload = try await readExactly(size)
    return try JSONDecoder().decode(T.self, from: payload)
  }
  private func readExactly(_ count: Int) async throws -> Data {
    while buffer.count < count {
      guard let chunk = try await connection.read(max(4096, count - buffer.count)), !chunk.isEmpty
      else { throw GhostteaTruffleError.unexpectedEndOfStream }
      buffer.append(chunk)
    }
    let value = Data(buffer.prefix(count))
    buffer.removeFirst(count)
    return value
  }
}

extension GhostteaTerminalProtocolCodec {
  public static func encodeCompactFrame<T: Encodable>(
    _ channel: GhostteaCompactChannel, _ message: T
  ) throws -> Data {
    let payload = try JSONEncoder().encode(message)
    let limit =
      channel == .control
      ? GhostteaTruffleContract.maximumControlMessageBytes
      : GhostteaTruffleContract.maximumStateMessageBytes
    guard payload.count <= limit else { throw GhostteaTruffleError.messageTooLarge(limit: limit) }
    var result = Data()
    result.appendGhostteaBigEndian(UInt32(payload.count + 1))
    result.append(channel.rawValue)
    result.append(payload)
    return result
  }
}

extension Data {
  fileprivate mutating func appendGhostteaBigEndian<T: FixedWidthInteger>(_ value: T) {
    var value = value.bigEndian
    Swift.withUnsafeBytes(of: &value) { append(contentsOf: $0) }
  }
  fileprivate func readGhostteaUInt32(at offset: Int) -> UInt32 {
    self[offset..<offset + 4].reduce(UInt32(0)) { ($0 << 8) | UInt32($1) }
  }
}
