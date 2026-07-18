import Foundation

public let ghostteaWorkspaceSchemaVersion = 1

public enum GhostteaWorkspaceSplitAxis: String, Codable, Sendable {
  case horizontal
  case vertical
}

public enum GhostteaWorkspaceFocusDirection: String, Codable, Sendable {
  case left
  case right
  case up
  case down
}

public struct GhostteaWorkspacePane: Equatable, Sendable {
  public let id: String
  public let sessionID: String

  public init(id: String, sessionID: String) {
    self.id = id
    self.sessionID = sessionID
  }
}

public struct GhostteaWorkspaceSplit: Equatable, Sendable {
  public let id: String
  public let axis: GhostteaWorkspaceSplitAxis
  public let ratio: Double
  public let first: GhostteaWorkspaceNode
  public let second: GhostteaWorkspaceNode

  public init(
    id: String,
    axis: GhostteaWorkspaceSplitAxis,
    ratio: Double,
    first: GhostteaWorkspaceNode,
    second: GhostteaWorkspaceNode
  ) {
    self.id = id
    self.axis = axis
    self.ratio = Self.clamp(ratio)
    self.first = first
    self.second = second
  }

  fileprivate static func clamp(_ ratio: Double) -> Double {
    guard ratio.isFinite else { return 0.5 }
    return min(0.9, max(0.1, ratio))
  }
}

public indirect enum GhostteaWorkspaceNode: Equatable, Sendable, Codable {
  case pane(GhostteaWorkspacePane)
  case split(GhostteaWorkspaceSplit)

  private enum CodingKeys: String, CodingKey {
    case kind
    case id
    case sessionId
    case axis
    case ratio
    case first
    case second
  }

  private enum Kind: String, Codable {
    case pane
    case split
  }

  public init(from decoder: any Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    switch try container.decode(Kind.self, forKey: .kind) {
    case .pane:
      self = .pane(
        GhostteaWorkspacePane(
          id: try container.decode(String.self, forKey: .id),
          sessionID: try container.decode(String.self, forKey: .sessionId)
        )
      )
    case .split:
      self = .split(
        GhostteaWorkspaceSplit(
          id: try container.decode(String.self, forKey: .id),
          axis: try container.decode(GhostteaWorkspaceSplitAxis.self, forKey: .axis),
          ratio: try container.decodeIfPresent(Double.self, forKey: .ratio) ?? 0.5,
          first: try container.decode(GhostteaWorkspaceNode.self, forKey: .first),
          second: try container.decode(GhostteaWorkspaceNode.self, forKey: .second)
        )
      )
    }
  }

  public func encode(to encoder: any Encoder) throws {
    var container = encoder.container(keyedBy: CodingKeys.self)
    switch self {
    case .pane(let pane):
      try container.encode(Kind.pane, forKey: .kind)
      try container.encode(pane.id, forKey: .id)
      try container.encode(pane.sessionID, forKey: .sessionId)
    case .split(let split):
      try container.encode(Kind.split, forKey: .kind)
      try container.encode(split.id, forKey: .id)
      try container.encode(split.axis, forKey: .axis)
      try container.encode(split.ratio, forKey: .ratio)
      try container.encode(split.first, forKey: .first)
      try container.encode(split.second, forKey: .second)
    }
  }

  fileprivate var id: String {
    switch self {
    case .pane(let pane): pane.id
    case .split(let split): split.id
    }
  }

  fileprivate var panes: [GhostteaWorkspacePane] {
    switch self {
    case .pane(let pane): [pane]
    case .split(let split): split.first.panes + split.second.panes
    }
  }

  fileprivate func contains(paneID: String) -> Bool {
    switch self {
    case .pane(let pane): pane.id == paneID
    case .split(let split):
      split.first.contains(paneID: paneID) || split.second.contains(paneID: paneID)
    }
  }

  fileprivate func replacing(paneID: String, with replacement: Self) -> Self {
    switch self {
    case .pane(let pane): pane.id == paneID ? replacement : self
    case .split(let split):
      .split(
        GhostteaWorkspaceSplit(
          id: split.id,
          axis: split.axis,
          ratio: split.ratio,
          first: split.first.replacing(paneID: paneID, with: replacement),
          second: split.second.replacing(paneID: paneID, with: replacement)
        )
      )
    }
  }

  fileprivate func removing(paneID: String) -> Self? {
    switch self {
    case .pane(let pane): return pane.id == paneID ? nil : self
    case .split(let split):
      let first = split.first.removing(paneID: paneID)
      let second = split.second.removing(paneID: paneID)
      guard let first else { return second }
      guard let second else { return first }
      return .split(
        GhostteaWorkspaceSplit(
          id: split.id,
          axis: split.axis,
          ratio: split.ratio,
          first: first,
          second: second
        )
      )
    }
  }

  fileprivate func equalized() -> Self {
    switch self {
    case .pane: self
    case .split(let split):
      .split(
        GhostteaWorkspaceSplit(
          id: split.id,
          axis: split.axis,
          ratio: 0.5,
          first: split.first.equalized(),
          second: split.second.equalized()
        )
      )
    }
  }

  fileprivate func resized(
    paneID: String,
    axis: GhostteaWorkspaceSplitAxis,
    delta: Double
  ) -> (node: Self, changed: Bool) {
    guard case .split(let split) = self else { return (self, false) }
    let inFirst = split.first.contains(paneID: paneID)
    let inSecond = split.second.contains(paneID: paneID)
    if inFirst {
      let result = split.first.resized(paneID: paneID, axis: axis, delta: delta)
      if result.changed {
        return (
          .split(
            GhostteaWorkspaceSplit(
              id: split.id,
              axis: split.axis,
              ratio: split.ratio,
              first: result.node,
              second: split.second
            )
          ),
          true
        )
      }
    }
    if inSecond {
      let result = split.second.resized(paneID: paneID, axis: axis, delta: delta)
      if result.changed {
        return (
          .split(
            GhostteaWorkspaceSplit(
              id: split.id,
              axis: split.axis,
              ratio: split.ratio,
              first: split.first,
              second: result.node
            )
          ),
          true
        )
      }
    }
    guard split.axis == axis, inFirst || inSecond else { return (self, false) }
    return (
      .split(
        GhostteaWorkspaceSplit(
          id: split.id,
          axis: split.axis,
          ratio: split.ratio + delta,
          first: split.first,
          second: split.second
        )
      ),
      true
    )
  }

  fileprivate func retaining(sessionIDs: Set<String>) -> Self? {
    switch self {
    case .pane(let pane): return sessionIDs.contains(pane.sessionID) ? self : nil
    case .split(let split):
      let first = split.first.retaining(sessionIDs: sessionIDs)
      let second = split.second.retaining(sessionIDs: sessionIDs)
      guard let first else { return second }
      guard let second else { return first }
      return .split(
        GhostteaWorkspaceSplit(
          id: split.id,
          axis: split.axis,
          ratio: split.ratio,
          first: first,
          second: second
        )
      )
    }
  }
}

public enum GhostteaWorkspaceValidationError: Error, Equatable, Sendable {
  case unsupportedVersion(Int)
  case emptyIdentity
  case duplicateNodeID(String)
  case duplicateSessionID(String)
  case missingActivePane(String)
  case missingZoomedPane(String)
}

public struct GhostteaWorkspaceDocument: Equatable, Sendable, Codable {
  public let version: Int
  public let root: GhostteaWorkspaceNode
  public let activePaneID: String
  public let zoomedPaneID: String?

  private enum CodingKeys: String, CodingKey {
    case version
    case root
    case activePaneID = "activePaneId"
    case zoomedPaneID = "zoomedPaneId"
  }

  public init(
    version: Int = ghostteaWorkspaceSchemaVersion,
    root: GhostteaWorkspaceNode,
    activePaneID: String,
    zoomedPaneID: String? = nil
  ) throws {
    guard version == ghostteaWorkspaceSchemaVersion else {
      throw GhostteaWorkspaceValidationError.unsupportedVersion(version)
    }
    var nodeIDs = Set<String>()
    var sessionIDs = Set<String>()
    func validate(_ node: GhostteaWorkspaceNode) throws {
      guard !node.id.isEmpty else { throw GhostteaWorkspaceValidationError.emptyIdentity }
      guard nodeIDs.insert(node.id).inserted else {
        throw GhostteaWorkspaceValidationError.duplicateNodeID(node.id)
      }
      switch node {
      case .pane(let pane):
        guard !pane.sessionID.isEmpty else { throw GhostteaWorkspaceValidationError.emptyIdentity }
        guard sessionIDs.insert(pane.sessionID).inserted else {
          throw GhostteaWorkspaceValidationError.duplicateSessionID(pane.sessionID)
        }
      case .split(let split):
        try validate(split.first)
        try validate(split.second)
      }
    }
    try validate(root)
    guard root.contains(paneID: activePaneID) else {
      throw GhostteaWorkspaceValidationError.missingActivePane(activePaneID)
    }
    if let zoomedPaneID, !root.contains(paneID: zoomedPaneID) {
      throw GhostteaWorkspaceValidationError.missingZoomedPane(zoomedPaneID)
    }
    self.version = version
    self.root = root
    self.activePaneID = activePaneID
    self.zoomedPaneID = zoomedPaneID
  }

  public init(from decoder: any Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    try self.init(
      version: container.decode(Int.self, forKey: .version),
      root: container.decode(GhostteaWorkspaceNode.self, forKey: .root),
      activePaneID: container.decode(String.self, forKey: .activePaneID),
      zoomedPaneID: container.decodeIfPresent(String.self, forKey: .zoomedPaneID)
    )
  }

  public func restoring(liveSessionIDs: Set<String>) throws -> Self? {
    guard let root = root.retaining(sessionIDs: liveSessionIDs) else { return nil }
    let panes = root.panes
    let activePaneID =
      panes.contains { $0.id == self.activePaneID }
      ? self.activePaneID
      : panes[0].id
    let zoomedPaneID = zoomedPaneID.flatMap { candidate in
      panes.contains { $0.id == candidate } ? candidate : nil
    }
    return try Self(root: root, activePaneID: activePaneID, zoomedPaneID: zoomedPaneID)
  }
}

public enum GhostteaWorkspaceAction: Equatable, Sendable {
  case split(
    axis: GhostteaWorkspaceSplitAxis,
    paneID: String,
    sessionID: String,
    splitID: String
  )
  case activate(paneID: String)
  case focusRelative(offset: Int)
  case focusDirection(GhostteaWorkspaceFocusDirection)
  case resize(axis: GhostteaWorkspaceSplitAxis, delta: Double)
  case equalize
  case toggleZoom
  case close
}

public struct GhostteaWorkspaceTransition: Equatable, Sendable {
  public let document: GhostteaWorkspaceDocument
  public let closedSessionID: String?
  public let shouldCloseWindow: Bool

  public init(
    document: GhostteaWorkspaceDocument,
    closedSessionID: String? = nil,
    shouldCloseWindow: Bool = false
  ) {
    self.document = document
    self.closedSessionID = closedSessionID
    self.shouldCloseWindow = shouldCloseWindow
  }
}

extension GhostteaWorkspaceDocument {
  public func applying(_ action: GhostteaWorkspaceAction) throws -> GhostteaWorkspaceTransition {
    func transition(
      root: GhostteaWorkspaceNode? = nil,
      activePaneID: String? = nil,
      zoomedPaneID: String?? = nil,
      closedSessionID: String? = nil,
      shouldCloseWindow: Bool = false
    ) throws -> GhostteaWorkspaceTransition {
      let document = try Self(
        root: root ?? self.root,
        activePaneID: activePaneID ?? self.activePaneID,
        zoomedPaneID: zoomedPaneID ?? self.zoomedPaneID
      )
      return GhostteaWorkspaceTransition(
        document: document,
        closedSessionID: closedSessionID,
        shouldCloseWindow: shouldCloseWindow
      )
    }

    switch action {
    case .split(let axis, let paneID, let sessionID, let splitID):
      let panes = root.panes
      var nodeIDs = Set<String>()
      func collect(_ node: GhostteaWorkspaceNode) {
        nodeIDs.insert(node.id)
        if case .split(let split) = node {
          collect(split.first)
          collect(split.second)
        }
      }
      collect(root)
      guard
        !paneID.isEmpty,
        !sessionID.isEmpty,
        !splitID.isEmpty,
        !nodeIDs.contains(paneID),
        !nodeIDs.contains(splitID),
        !panes.contains(where: { $0.sessionID == sessionID })
      else { return GhostteaWorkspaceTransition(document: self) }
      let active = panes.first { $0.id == activePaneID } ?? panes[0]
      let next = GhostteaWorkspaceNode.pane(
        GhostteaWorkspacePane(id: paneID, sessionID: sessionID)
      )
      let replacement = GhostteaWorkspaceNode.split(
        GhostteaWorkspaceSplit(
          id: splitID,
          axis: axis,
          ratio: 0.5,
          first: .pane(active),
          second: next
        )
      )
      return try transition(
        root: root.replacing(paneID: active.id, with: replacement),
        activePaneID: paneID,
        zoomedPaneID: .some(nil)
      )
    case .activate(let paneID):
      guard root.contains(paneID: paneID) else {
        return GhostteaWorkspaceTransition(document: self)
      }
      return try transition(activePaneID: paneID)
    case .focusRelative(let offset):
      guard zoomedPaneID == nil else { return GhostteaWorkspaceTransition(document: self) }
      let panes = root.panes
      guard panes.count > 1, let index = panes.firstIndex(where: { $0.id == activePaneID }) else {
        return GhostteaWorkspaceTransition(document: self)
      }
      let normalized = ((index + offset) % panes.count + panes.count) % panes.count
      return try transition(activePaneID: panes[normalized].id)
    case .focusDirection(let direction):
      guard zoomedPaneID == nil, let paneID = focusedPane(direction: direction) else {
        return GhostteaWorkspaceTransition(document: self)
      }
      return try transition(activePaneID: paneID)
    case .resize(let axis, let delta):
      guard delta.isFinite else { return GhostteaWorkspaceTransition(document: self) }
      return try transition(root: root.resized(paneID: activePaneID, axis: axis, delta: delta).node)
    case .equalize:
      return try transition(root: root.equalized())
    case .toggleZoom:
      return try transition(zoomedPaneID: .some(zoomedPaneID == nil ? activePaneID : nil))
    case .close:
      let panes = root.panes
      guard panes.count > 1 else {
        return GhostteaWorkspaceTransition(document: self, shouldCloseWindow: true)
      }
      guard let index = panes.firstIndex(where: { $0.id == activePaneID }) else {
        return GhostteaWorkspaceTransition(document: self)
      }
      let active = panes[index]
      let next = panes[index == panes.count - 1 ? index - 1 : index + 1]
      guard let root = root.removing(paneID: active.id) else {
        return GhostteaWorkspaceTransition(document: self)
      }
      return try transition(
        root: root,
        activePaneID: next.id,
        zoomedPaneID: .some(nil),
        closedSessionID: active.sessionID
      )
    }
  }

  private struct Rect {
    let x: Double
    let y: Double
    let width: Double
    let height: Double
  }

  private func focusedPane(direction: GhostteaWorkspaceFocusDirection) -> String? {
    var rects: [String: Rect] = [:]
    func place(_ node: GhostteaWorkspaceNode, in rect: Rect) {
      switch node {
      case .pane(let pane):
        rects[pane.id] = rect
      case .split(let split):
        switch split.axis {
        case .horizontal:
          let firstWidth = rect.width * split.ratio
          place(
            split.first,
            in: Rect(x: rect.x, y: rect.y, width: firstWidth, height: rect.height)
          )
          place(
            split.second,
            in: Rect(
              x: rect.x + firstWidth,
              y: rect.y,
              width: rect.width - firstWidth,
              height: rect.height
            )
          )
        case .vertical:
          let firstHeight = rect.height * split.ratio
          place(
            split.first,
            in: Rect(x: rect.x, y: rect.y, width: rect.width, height: firstHeight)
          )
          place(
            split.second,
            in: Rect(
              x: rect.x,
              y: rect.y + firstHeight,
              width: rect.width,
              height: rect.height - firstHeight
            )
          )
        }
      }
    }
    place(root, in: Rect(x: 0, y: 0, width: 1, height: 1))
    guard let source = rects[activePaneID] else { return nil }
    let sourceX = source.x + source.width / 2
    let sourceY = source.y + source.height / 2
    var best: (id: String, score: Double)?
    for pane in root.panes where pane.id != activePaneID {
      guard let rect = rects[pane.id] else { continue }
      let dx = rect.x + rect.width / 2 - sourceX
      let dy = rect.y + rect.height / 2 - sourceY
      let forward: Double
      switch direction {
      case .left: forward = -dx
      case .right: forward = dx
      case .up: forward = -dy
      case .down: forward = dy
      }
      guard forward > 0 else { continue }
      let cross = direction == .left || direction == .right ? abs(dy) : abs(dx)
      let score = forward + cross * 2
      if best == nil || score < best!.score {
        best = (pane.id, score)
      }
    }
    return best?.id
  }
}
