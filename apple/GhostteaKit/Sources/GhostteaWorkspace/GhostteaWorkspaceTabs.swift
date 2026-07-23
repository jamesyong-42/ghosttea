import Foundation

public let ghostteaWorkspaceTabsSchemaVersion = 1

public struct GhostteaWorkspaceTab: Equatable, Sendable, Codable {
  public let id: String
  public let workspace: GhostteaWorkspaceDocument

  public init(id: String, workspace: GhostteaWorkspaceDocument) {
    self.id = id
    self.workspace = workspace
  }
}

public struct GhostteaWorkspaceTabsDocument: Equatable, Sendable, Codable {
  public let version: Int
  public let selectedTabID: String
  public let tabs: [GhostteaWorkspaceTab]

  public var sessionIDs: [String] { tabs.flatMap { $0.workspace.sessionIDs } }
  /// Resource identities in stable pane order, with mirrored panes collapsed.
  public var uniqueSessionIDs: [String] {
    var seen = Set<String>()
    return sessionIDs.filter { seen.insert($0).inserted }
  }
  public var selectedTabSessionIDs: [String] {
    tabs.first(where: { $0.id == selectedTabID })?.workspace.sessionIDs ?? []
  }
  public var selectedTabUniqueSessionIDs: [String] {
    var seen = Set<String>()
    return selectedTabSessionIDs.filter { seen.insert($0).inserted }
  }
  /// One geometry controller per selected-tab session; the focused mirror wins.
  public var selectedTabSessionControllerPaneIDs: [String] {
    guard let workspace = tabs.first(where: { $0.id == selectedTabID })?.workspace else { return [] }
    let panes = workspace.root.panes
    var controllerBySessionID = [String: String]()
    for pane in panes where controllerBySessionID[pane.sessionID] == nil {
      controllerBySessionID[pane.sessionID] = pane.id
    }
    let focusedPaneID = workspace.zoomedPaneID ?? workspace.activePaneID
    if let focusedPane = panes.first(where: { $0.id == focusedPaneID }) {
      controllerBySessionID[focusedPane.sessionID] = focusedPane.id
    }
    return panes.compactMap { pane in
      controllerBySessionID[pane.sessionID] == pane.id ? pane.id : nil
    }
  }
  public var inactiveSessionIDs: [String] {
    let selected = Set(selectedTabUniqueSessionIDs)
    return uniqueSessionIDs.filter { !selected.contains($0) }
  }

  private enum CodingKeys: String, CodingKey {
    case version
    case selectedTabID = "selectedTabId"
    case tabs
  }

  public init(
    version: Int = ghostteaWorkspaceTabsSchemaVersion,
    selectedTabID: String,
    tabs: [GhostteaWorkspaceTab]
  ) throws {
    guard version == ghostteaWorkspaceTabsSchemaVersion else {
      throw GhostteaWorkspaceValidationError.unsupportedVersion(version)
    }
    guard !tabs.isEmpty else { throw GhostteaWorkspaceValidationError.emptyTabCollection }
    var tabIDs = Set<String>()
    var sessionIDs = Set<String>()
    for tab in tabs {
      guard !tab.id.isEmpty else { throw GhostteaWorkspaceValidationError.emptyIdentity }
      guard tabIDs.insert(tab.id).inserted else {
        throw GhostteaWorkspaceValidationError.duplicateTabID(tab.id)
      }
      let tabSessionIDs = Set(tab.workspace.sessionIDs)
      guard sessionIDs.isDisjoint(with: tabSessionIDs) else {
        let duplicate = tabSessionIDs.first(where: { sessionIDs.contains($0) })!
        throw GhostteaWorkspaceValidationError.duplicateSessionID(duplicate)
      }
      sessionIDs.formUnion(tabSessionIDs)
    }
    guard tabIDs.contains(selectedTabID) else {
      throw GhostteaWorkspaceValidationError.missingSelectedTab(selectedTabID)
    }
    self.version = version
    self.selectedTabID = selectedTabID
    self.tabs = tabs
  }

  public init(from decoder: any Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    try self.init(
      version: container.decode(Int.self, forKey: .version),
      selectedTabID: container.decode(String.self, forKey: .selectedTabID),
      tabs: container.decode([GhostteaWorkspaceTab].self, forKey: .tabs)
    )
  }

  public func restoring(liveSessionIDs: Set<String>) throws -> Self? {
    var restoredTabs: [GhostteaWorkspaceTab] = []
    for tab in tabs {
      if let workspace = try tab.workspace.restoring(liveSessionIDs: liveSessionIDs) {
        restoredTabs.append(GhostteaWorkspaceTab(id: tab.id, workspace: workspace))
      }
    }
    guard !restoredTabs.isEmpty else { return nil }
    let selectedTabID =
      restoredTabs.contains { $0.id == self.selectedTabID }
      ? self.selectedTabID
      : restoredTabs[0].id
    return try Self(selectedTabID: selectedTabID, tabs: restoredTabs)
  }
}

public enum GhostteaWorkspaceTabsAction: Equatable, Sendable {
  case createTab(GhostteaWorkspaceTab)
  case selectTab(id: String)
  case selectRelative(offset: Int)
  case moveTab(id: String, offset: Int)
  case closeTab(id: String)
  case applyToSelected(GhostteaWorkspaceAction)
}

public struct GhostteaWorkspaceTabsTransition: Equatable, Sendable {
  public let document: GhostteaWorkspaceTabsDocument
  public let closedTabID: String?
  public let closedSessionIDs: [String]
  public let shouldCloseWindow: Bool

  public init(
    document: GhostteaWorkspaceTabsDocument,
    closedTabID: String? = nil,
    closedSessionIDs: [String] = [],
    shouldCloseWindow: Bool = false
  ) {
    self.document = document
    self.closedTabID = closedTabID
    self.closedSessionIDs = closedSessionIDs
    self.shouldCloseWindow = shouldCloseWindow
  }
}

extension GhostteaWorkspaceTabsDocument {
  public func applying(
    _ action: GhostteaWorkspaceTabsAction
  ) throws -> GhostteaWorkspaceTabsTransition {
    switch action {
    case .applyToSelected(let workspaceAction):
      guard let index = tabs.firstIndex(where: { $0.id == selectedTabID }) else {
        return GhostteaWorkspaceTabsTransition(document: self)
      }
      let selected = tabs[index]
      let paneTransition = try selected.workspace.applying(workspaceAction)
      if paneTransition.shouldCloseWindow {
        return try applying(.closeTab(id: selected.id))
      }
      let otherSessionIDs = Set(
        tabs.filter { $0.id != selected.id }.flatMap { $0.workspace.sessionIDs }
      )
      guard otherSessionIDs.isDisjoint(with: paneTransition.document.sessionIDs) else {
        return GhostteaWorkspaceTabsTransition(document: self)
      }
      var nextTabs = tabs
      nextTabs[index] = GhostteaWorkspaceTab(id: selected.id, workspace: paneTransition.document)
      return GhostteaWorkspaceTabsTransition(
        document: try Self(selectedTabID: selectedTabID, tabs: nextTabs),
        closedSessionIDs: paneTransition.closedSessionID.map { [$0] } ?? []
      )

    case .createTab(let tab):
      guard
        !tab.id.isEmpty,
        !tabs.contains(where: { $0.id == tab.id })
      else { return GhostteaWorkspaceTabsTransition(document: self) }
      let existingSessionIDs = Set(tabs.flatMap { $0.workspace.sessionIDs })
      guard existingSessionIDs.isDisjoint(with: tab.workspace.sessionIDs) else {
        return GhostteaWorkspaceTabsTransition(document: self)
      }
      return GhostteaWorkspaceTabsTransition(
        document: try Self(selectedTabID: tab.id, tabs: tabs + [tab])
      )

    case .selectTab(let id):
      guard tabs.contains(where: { $0.id == id }) else {
        return GhostteaWorkspaceTabsTransition(document: self)
      }
      return GhostteaWorkspaceTabsTransition(
        document: try Self(selectedTabID: id, tabs: tabs)
      )

    case .selectRelative(let offset):
      guard tabs.count > 1, let index = tabs.firstIndex(where: { $0.id == selectedTabID }) else {
        return GhostteaWorkspaceTabsTransition(document: self)
      }
      let normalized = ((index + offset) % tabs.count + tabs.count) % tabs.count
      return GhostteaWorkspaceTabsTransition(
        document: try Self(selectedTabID: tabs[normalized].id, tabs: tabs)
      )

    case .moveTab(let id, let offset):
      guard let index = tabs.firstIndex(where: { $0.id == id }) else {
        return GhostteaWorkspaceTabsTransition(document: self)
      }
      let destination = min(tabs.count - 1, max(0, index + offset))
      guard destination != index else { return GhostteaWorkspaceTabsTransition(document: self) }
      var nextTabs = tabs
      let tab = nextTabs.remove(at: index)
      nextTabs.insert(tab, at: destination)
      return GhostteaWorkspaceTabsTransition(
        document: try Self(selectedTabID: selectedTabID, tabs: nextTabs)
      )

    case .closeTab(let id):
      guard let index = tabs.firstIndex(where: { $0.id == id }) else {
        return GhostteaWorkspaceTabsTransition(document: self)
      }
      guard tabs.count > 1 else {
        return GhostteaWorkspaceTabsTransition(document: self, shouldCloseWindow: true)
      }
      let closed = tabs[index]
      var nextTabs = tabs
      nextTabs.remove(at: index)
      let nextSelectedTabID =
        selectedTabID == closed.id
        ? nextTabs[min(index, nextTabs.count - 1)].id
        : selectedTabID
      return GhostteaWorkspaceTabsTransition(
        document: try Self(selectedTabID: nextSelectedTabID, tabs: nextTabs),
        closedTabID: closed.id,
        closedSessionIDs: closed.workspace.sessionIDs.reduce(into: []) { result, sessionID in
          if !result.contains(sessionID) { result.append(sessionID) }
        }
      )
    }
  }
}
