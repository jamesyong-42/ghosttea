import Foundation
import GhostteaWorkspace
import Testing

private func restorationWorkspace() throws -> GhostteaWorkspaceTabsDocument {
  let first = try GhostteaWorkspaceDocument(
    root: .pane(GhostteaWorkspacePane(id: "pane-a", sessionID: "session-a")),
    activePaneID: "pane-a"
  )
  let second = try GhostteaWorkspaceDocument(
    root: .split(
      GhostteaWorkspaceSplit(
        id: "split-b",
        axis: .horizontal,
        ratio: 0.5,
        first: .pane(GhostteaWorkspacePane(id: "pane-b", sessionID: "session-b")),
        second: .pane(GhostteaWorkspacePane(id: "pane-c", sessionID: "session-c"))
      )
    ),
    activePaneID: "pane-c"
  )
  return try GhostteaWorkspaceTabsDocument(
    selectedTabID: "tab-b",
    tabs: [
      GhostteaWorkspaceTab(id: "tab-a", workspace: first),
      GhostteaWorkspaceTab(id: "tab-b", workspace: second),
    ]
  )
}

@Test("Restoration bindings are canonical and never claim unavailable sessions")
func restorationBindingsFilterOnlyAfterAllocation() throws {
  let document = try GhostteaWorkspaceRestorationDocument(
    workspace: restorationWorkspace(),
    sessionProfiles: [
      GhostteaWorkspaceSessionProfileBinding(sessionID: "session-c", profileID: "profile-2"),
      GhostteaWorkspaceSessionProfileBinding(sessionID: "session-a", profileID: "profile-1"),
      GhostteaWorkspaceSessionProfileBinding(sessionID: "session-b", profileID: "profile-2"),
    ]
  )

  #expect(document.sessionProfiles.map(\.sessionID) == ["session-a", "session-b", "session-c"])
  #expect(document.profileIDBySessionID["session-b"] == "profile-2")

  let candidate = try document.restoring(allocatedSessionIDs: ["session-a", "session-c"])
  let restored = try #require(candidate)
  #expect(restored.sessionIDs == ["session-a", "session-c"])
  #expect(restored.selectedTabID == "tab-b")
}

@Test("Restoration requires exactly one nonempty profile binding per session")
func restorationRejectsInvalidBindings() throws {
  let workspace = try restorationWorkspace()
  #expect(throws: GhostteaWorkspaceRestorationError.bindingMismatch) {
    try GhostteaWorkspaceRestorationDocument(
      workspace: workspace,
      sessionProfiles: [
        GhostteaWorkspaceSessionProfileBinding(sessionID: "session-a", profileID: "profile-1")
      ]
    )
  }
  #expect(throws: GhostteaWorkspaceRestorationError.emptyProfileID) {
    try GhostteaWorkspaceRestorationDocument(
      workspace: workspace,
      sessionProfiles: workspace.sessionIDs.map {
        GhostteaWorkspaceSessionProfileBinding(
          sessionID: $0,
          profileID: $0 == "session-b" ? "" : "profile"
        )
      }
    )
  }
}

private struct ConformanceFixture: Decodable {
  let schemaVersion: Int
  let scenarios: [Scenario]

  struct Scenario: Decodable {
    let name: String
    let initial: GhostteaWorkspaceDocument
    let steps: [Step]
  }

  struct Step: Decodable {
    let action: FixtureAction
    let expected: ExpectedTransition
  }

  struct ExpectedTransition: Decodable {
    let document: GhostteaWorkspaceDocument
    let closedSessionID: String?
    let shouldCloseWindow: Bool

    private enum CodingKeys: String, CodingKey {
      case document
      case closedSessionID = "closedSessionId"
      case shouldCloseWindow
    }
  }
}

private struct FixtureAction: Decodable {
  let value: GhostteaWorkspaceAction

  private enum CodingKeys: String, CodingKey {
    case type
    case axis
    case paneID = "paneId"
    case sessionID = "sessionId"
    case splitID = "splitId"
    case offset
    case direction
    case delta
  }

  private enum Kind: String, Decodable {
    case split
    case activate
    case focusRelative = "focus-relative"
    case focusDirection = "focus-direction"
    case resize
    case equalize
    case toggleZoom = "toggle-zoom"
    case close
  }

  init(from decoder: any Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    switch try container.decode(Kind.self, forKey: .type) {
    case .split:
      value = .split(
        axis: try container.decode(GhostteaWorkspaceSplitAxis.self, forKey: .axis),
        paneID: try container.decode(String.self, forKey: .paneID),
        sessionID: try container.decode(String.self, forKey: .sessionID),
        splitID: try container.decode(String.self, forKey: .splitID)
      )
    case .activate:
      value = .activate(paneID: try container.decode(String.self, forKey: .paneID))
    case .focusRelative:
      value = .focusRelative(offset: try container.decode(Int.self, forKey: .offset))
    case .focusDirection:
      value = .focusDirection(
        try container.decode(GhostteaWorkspaceFocusDirection.self, forKey: .direction)
      )
    case .resize:
      value = .resize(
        axis: try container.decode(GhostteaWorkspaceSplitAxis.self, forKey: .axis),
        delta: try container.decode(Double.self, forKey: .delta)
      )
    case .equalize:
      value = .equalize
    case .toggleZoom:
      value = .toggleZoom
    case .close:
      value = .close
    }
  }
}

@Test("Swift workspace mutations match every shared TypeScript vector")
func workspaceConformanceVectors() throws {
  let url = try #require(
    Bundle.module.url(
      forResource: "workspace-conformance-v1",
      withExtension: "json",
      subdirectory: "Fixtures"
    )
  )
  let fixture = try JSONDecoder().decode(ConformanceFixture.self, from: Data(contentsOf: url))
  #expect(fixture.schemaVersion == ghostteaWorkspaceSchemaVersion)
  for scenario in fixture.scenarios {
    var document = scenario.initial
    for (index, step) in scenario.steps.enumerated() {
      let result = try document.applying(step.action.value)
      #expect(
        result.document == step.expected.document,
        "\(scenario.name), step \(index + 1): document mismatch"
      )
      #expect(
        result.closedSessionID == step.expected.closedSessionID,
        "\(scenario.name), step \(index + 1): close result mismatch"
      )
      #expect(
        result.shouldCloseWindow == step.expected.shouldCloseWindow,
        "\(scenario.name), step \(index + 1): window result mismatch"
      )
      document = result.document
    }
  }
}

@Test("Workspace restoration drops stale sessions and stale active claims")
func workspaceRestorationDropsStaleSessions() throws {
  let first = GhostteaWorkspaceNode.pane(
    GhostteaWorkspacePane(id: "pane-1", sessionID: "live")
  )
  let stale = GhostteaWorkspaceNode.pane(
    GhostteaWorkspacePane(id: "pane-2", sessionID: "stale")
  )
  let document = try GhostteaWorkspaceDocument(
    root: .split(
      GhostteaWorkspaceSplit(
        id: "split-1",
        axis: .horizontal,
        ratio: 0.7,
        first: first,
        second: stale
      )
    ),
    activePaneID: "pane-2",
    zoomedPaneID: "pane-2"
  )
  let candidate = try document.restoring(liveSessionIDs: ["live"])
  let restored = try #require(candidate)
  #expect(restored.root == first)
  #expect(restored.activePaneID == "pane-1")
  #expect(restored.zoomedPaneID == nil)
  let empty = try document.restoring(liveSessionIDs: [])
  #expect(empty == nil)
}

@Test("Workspace schema rejects duplicate identities and stale pane references")
func workspaceSchemaValidation() throws {
  let pane = GhostteaWorkspaceNode.pane(
    GhostteaWorkspacePane(id: "pane-1", sessionID: "session-1")
  )
  #expect(throws: GhostteaWorkspaceValidationError.missingActivePane("missing")) {
    try GhostteaWorkspaceDocument(root: pane, activePaneID: "missing")
  }
  #expect(throws: GhostteaWorkspaceValidationError.duplicateSessionID("session-1")) {
    try GhostteaWorkspaceDocument(
      root: .split(
        GhostteaWorkspaceSplit(
          id: "split-1",
          axis: .horizontal,
          ratio: 0.5,
          first: pane,
          second: .pane(
            GhostteaWorkspacePane(id: "pane-2", sessionID: "session-1")
          )
        )
      ),
      activePaneID: "pane-1"
    )
  }
}

@Test("Workspace encoding contains no live session metadata")
func workspaceEncodingIsIdentityOnly() throws {
  let document = try GhostteaWorkspaceDocument(
    root: .pane(GhostteaWorkspacePane(id: "pane-1", sessionID: "opaque-session")),
    activePaneID: "pane-1"
  )
  let encoded = try JSONEncoder().encode(document)
  let text = try #require(String(data: encoded, encoding: .utf8))
  #expect(text.contains("opaque-session"))
  #expect(!text.contains("executable"))
  #expect(!text.contains("cwd"))
  #expect(!text.contains("host"))
  #expect(!text.contains("connected"))
  #expect(!text.contains("credential"))
}

private struct TabsConformanceFixture: Decodable {
  let schemaVersion: Int
  let initial: GhostteaWorkspaceTabsDocument
  let steps: [Step]

  struct Step: Decodable {
    let action: Action
    let expected: Expected
  }

  struct Action: Decodable {
    let value: GhostteaWorkspaceTabsAction

    private enum CodingKeys: String, CodingKey {
      case type
      case tab
      case tabID = "tabId"
      case offset
      case action
    }

    private enum Kind: String, Decodable {
      case createTab = "create-tab"
      case selectTab = "select-tab"
      case selectRelative = "select-relative"
      case moveTab = "move-tab"
      case closeTab = "close-tab"
      case applyToSelected = "apply-to-selected"
    }

    init(from decoder: any Decoder) throws {
      let container = try decoder.container(keyedBy: CodingKeys.self)
      switch try container.decode(Kind.self, forKey: .type) {
      case .createTab:
        value = .createTab(try container.decode(GhostteaWorkspaceTab.self, forKey: .tab))
      case .selectTab:
        value = .selectTab(id: try container.decode(String.self, forKey: .tabID))
      case .selectRelative:
        value = .selectRelative(offset: try container.decode(Int.self, forKey: .offset))
      case .moveTab:
        value = .moveTab(
          id: try container.decode(String.self, forKey: .tabID),
          offset: try container.decode(Int.self, forKey: .offset)
        )
      case .closeTab:
        value = .closeTab(id: try container.decode(String.self, forKey: .tabID))
      case .applyToSelected:
        value = .applyToSelected(try container.decode(FixtureAction.self, forKey: .action).value)
      }
    }
  }

  struct Expected: Decodable {
    let selectedTabID: String
    let tabIDs: [String]
    let closedTabID: String?
    let closedSessionIDs: [String]
    let shouldCloseWindow: Bool

    private enum CodingKeys: String, CodingKey {
      case selectedTabID = "selectedTabId"
      case tabIDs = "tabIds"
      case closedTabID = "closedTabId"
      case closedSessionIDs = "closedSessionIds"
      case shouldCloseWindow
    }
  }
}

@Test("Swift tab transitions match every shared TypeScript vector")
func workspaceTabsConformanceVectors() throws {
  let url = try #require(
    Bundle.module.url(
      forResource: "workspace-tabs-conformance-v1",
      withExtension: "json",
      subdirectory: "Fixtures"
    )
  )
  let fixture = try JSONDecoder().decode(
    TabsConformanceFixture.self,
    from: Data(contentsOf: url)
  )
  #expect(fixture.schemaVersion == ghostteaWorkspaceTabsSchemaVersion)
  var document = fixture.initial
  for (index, step) in fixture.steps.enumerated() {
    let transition = try document.applying(step.action.value)
    #expect(
      transition.document.selectedTabID == step.expected.selectedTabID,
      "step \(index + 1): selected tab mismatch"
    )
    #expect(
      transition.document.tabs.map(\.id) == step.expected.tabIDs,
      "step \(index + 1): tab order mismatch"
    )
    #expect(transition.closedTabID == step.expected.closedTabID)
    #expect(transition.closedSessionIDs == step.expected.closedSessionIDs)
    #expect(transition.shouldCloseWindow == step.expected.shouldCloseWindow)
    document = transition.document
  }
}

@Test("Tab restoration drops empty tabs and selects the first survivor")
func workspaceTabsRestoration() throws {
  let first = try GhostteaWorkspaceDocument(
    root: .pane(GhostteaWorkspacePane(id: "pane-a", sessionID: "stale")),
    activePaneID: "pane-a"
  )
  let second = try GhostteaWorkspaceDocument(
    root: .pane(GhostteaWorkspacePane(id: "pane-b", sessionID: "live")),
    activePaneID: "pane-b"
  )
  let document = try GhostteaWorkspaceTabsDocument(
    selectedTabID: "tab-a",
    tabs: [
      GhostteaWorkspaceTab(id: "tab-a", workspace: first),
      GhostteaWorkspaceTab(id: "tab-b", workspace: second),
    ]
  )
  let restored = try #require(try document.restoring(liveSessionIDs: ["live"]))
  #expect(restored.selectedTabID == "tab-b")
  #expect(restored.tabs.map(\.id) == ["tab-b"])
  #expect(try document.restoring(liveSessionIDs: []) == nil)
}

@Test("Tab schema rejects duplicate tabs, sessions, and stale selection")
func workspaceTabsSchemaValidation() throws {
  let workspace = try GhostteaWorkspaceDocument(
    root: .pane(GhostteaWorkspacePane(id: "pane", sessionID: "session")),
    activePaneID: "pane"
  )
  let tab = GhostteaWorkspaceTab(id: "tab", workspace: workspace)
  #expect(throws: GhostteaWorkspaceValidationError.emptyTabCollection) {
    try GhostteaWorkspaceTabsDocument(selectedTabID: "tab", tabs: [])
  }
  #expect(throws: GhostteaWorkspaceValidationError.duplicateTabID("tab")) {
    try GhostteaWorkspaceTabsDocument(selectedTabID: "tab", tabs: [tab, tab])
  }
  let otherTab = GhostteaWorkspaceTab(id: "other", workspace: workspace)
  #expect(throws: GhostteaWorkspaceValidationError.duplicateSessionID("session")) {
    try GhostteaWorkspaceTabsDocument(selectedTabID: "tab", tabs: [tab, otherTab])
  }
  #expect(throws: GhostteaWorkspaceValidationError.missingSelectedTab("missing")) {
    try GhostteaWorkspaceTabsDocument(selectedTabID: "missing", tabs: [tab])
  }
}

private struct CommandConformanceFixture: Decodable {
  let vectors: [Vector]

  struct Vector: Decodable {
    let key: String
    let meta: Bool?
    let shift: Bool?
    let alt: Bool?
    let control: Bool?
    let expected: Expected?
    let commandID: GhostteaWorkspaceCommandID?

    private enum CodingKeys: String, CodingKey {
      case key
      case meta
      case shift
      case alt
      case control
      case expected
      case commandID = "commandId"
    }
  }

  struct Expected: Decodable {
    let type: String
    let target: Target?
    let axis: GhostteaWorkspaceSplitAxis?
    let direction: GhostteaWorkspaceFocusDirection?
    let delta: Double?
    let offset: Int?

    enum Target: Decodable {
      case previous
      case next
      case index(Int)

      init(from decoder: any Decoder) throws {
        let container = try decoder.singleValueContainer()
        if let index = try? container.decode(Int.self) {
          self = .index(index)
        } else {
          switch try container.decode(String.self) {
          case "previous": self = .previous
          case "next": self = .next
          default:
            throw DecodingError.dataCorruptedError(
              in: container,
              debugDescription: "Unknown tab target"
            )
          }
        }
      }
    }

    var command: GhostteaWorkspaceCommand {
      get throws {
        switch type {
        case "remote-sessions": return .remoteSessions
        case "new-tab": return .newTab
        case "select-tab":
          switch try #require(target) {
          case .previous: return .selectTab(.previous)
          case .next: return .selectTab(.next)
          case .index(let index): return .selectTab(.index(index))
          }
        case "close-tab": return .closeTab
        case "split": return .split(try #require(axis))
        case "focus-relative":
          return .focusRelative(offset: try #require(offset))
        case "focus-direction": return .focusDirection(try #require(direction))
        case "resize": return .resize(axis: try #require(axis), delta: try #require(delta))
        case "equalize": return .equalize
        case "toggle-zoom": return .toggleZoom
        case "close-pane": return .closePane
        default: throw CocoaError(.coderReadCorrupt)
        }
      }
    }
  }
}

@Test("Swift command shortcuts match every shared desktop vector")
func workspaceCommandConformance() throws {
  let url = try #require(
    Bundle.module.url(
      forResource: "workspace-command-conformance-v1",
      withExtension: "json",
      subdirectory: "Fixtures"
    )
  )
  let fixture = try JSONDecoder().decode(
    CommandConformanceFixture.self,
    from: Data(contentsOf: url)
  )
  for vector in fixture.vectors {
    let command = GhostteaWorkspaceKeyChord(
      key: vector.key,
      command: vector.meta ?? false,
      shift: vector.shift ?? false,
      option: vector.alt ?? false,
      control: vector.control ?? false
    ).workspaceCommand
    #expect(command == (try vector.expected?.command), "key \(vector.key)")
    #expect(command?.id == vector.commandID, "key \(vector.key) command ID")
  }
}

@Test("Workspace commands route before terminal encoding")
func workspaceCommandsRouteToReducerOrHost() throws {
  let workspace = try GhostteaWorkspaceDocument(
    root: .pane(GhostteaWorkspacePane(id: "pane", sessionID: "session")),
    activePaneID: "pane"
  )
  let document = try GhostteaWorkspaceTabsDocument(
    selectedTabID: "tab",
    tabs: [GhostteaWorkspaceTab(id: "tab", workspace: workspace)]
  )
  #expect(GhostteaWorkspaceCommand.newTab.route(in: document) == .requestNewTab)
  #expect(
    GhostteaWorkspaceCommand.split(.horizontal).route(in: document)
      == .requestSplit(.horizontal)
  )
  #expect(
    GhostteaWorkspaceCommand.closePane.route(in: document)
      == .reducer(.applyToSelected(.close))
  )
  #expect(GhostteaWorkspaceCommand.selectTab(.index(2)).route(in: document) == nil)
}

@Test("Workspace shortcut presses dispatch once and consume their matching release")
func workspaceShortcutPressState() {
  var state = GhostteaWorkspaceShortcutState()
  let chord = GhostteaWorkspaceKeyChord(domCode: "KeyT", command: true)
  let down = state.handle(usage: 0x17, phase: .down, chord: chord)
  let repeated = state.handle(usage: 0x17, phase: .repeated, chord: chord)
  let up = state.handle(usage: 0x17, phase: .up, chord: chord)
  let unmatched = state.handle(
    usage: 0x1b,
    phase: .down,
    chord: GhostteaWorkspaceKeyChord(domCode: "KeyX", command: true)
  )
  #expect(down == GhostteaWorkspaceShortcutResult(handled: true, command: .newTab))
  #expect(repeated == GhostteaWorkspaceShortcutResult(handled: true))
  #expect(up == GhostteaWorkspaceShortcutResult(handled: true))
  #expect(unmatched == GhostteaWorkspaceShortcutResult(handled: false))
}

private actor WorkspaceAllocationProbe {
  private var allocations: [GhostteaWorkspaceSessionAllocation<String>]
  private(set) var requests: [GhostteaWorkspaceSessionRequest] = []
  private(set) var terminated: [(String, String)] = []

  init(_ allocations: [GhostteaWorkspaceSessionAllocation<String>]) {
    self.allocations = allocations
  }

  func allocate(
    _ request: GhostteaWorkspaceSessionRequest
  ) throws -> GhostteaWorkspaceSessionAllocation<String> {
    requests.append(request)
    guard !allocations.isEmpty else { throw CocoaError(.fileNoSuchFile) }
    return allocations.removeFirst()
  }

  func terminate(id: String, session: String) {
    terminated.append((id, session))
  }
}

private func singleSessionTabsDocument() throws -> GhostteaWorkspaceTabsDocument {
  let workspace = try GhostteaWorkspaceDocument(
    root: .pane(GhostteaWorkspacePane(id: "pane-a", sessionID: "session-a")),
    activePaneID: "pane-a"
  )
  return try GhostteaWorkspaceTabsDocument(
    selectedTabID: "tab-a",
    tabs: [GhostteaWorkspaceTab(id: "tab-a", workspace: workspace)]
  )
}

@Test("Session coordinator commits allocations before terminating exact close outputs")
func workspaceSessionCoordinatorLifecycle() async throws {
  let probe = WorkspaceAllocationProbe([
    GhostteaWorkspaceSessionAllocation(sessionID: "session-b", session: "resource-b"),
    GhostteaWorkspaceSessionAllocation(sessionID: "session-c", session: "resource-c"),
  ])
  let coordinator = try GhostteaWorkspaceSessionCoordinator(
    document: singleSessionTabsDocument(),
    sessions: ["session-a": "resource-a"],
    identityPrefix: "fixture",
    allocator: { try await probe.allocate($0) },
    terminator: { await probe.terminate(id: $0, session: $1) }
  )

  _ = try await coordinator.createTab()
  _ = try await coordinator.splitSelected(axis: .vertical)
  #expect(await coordinator.sessionIDs == ["session-a", "session-b", "session-c"])
  #expect(
    await probe.requests == [
      .newTab,
      .split(axis: .vertical, sourceSessionID: "session-b"),
    ]
  )

  _ = try await coordinator.apply(.applyToSelected(.close))
  _ = try await coordinator.apply(.applyToSelected(.close))
  #expect(await coordinator.sessionIDs == ["session-a"])
  #expect(await probe.terminated.map(\.0) == ["session-c", "session-b"])

  await coordinator.closeAll()
  #expect(await coordinator.sessionIDs.isEmpty)
  #expect(await probe.terminated.map(\.0) == ["session-c", "session-b", "session-a"])
  await #expect(throws: GhostteaWorkspaceSessionCoordinatorError.closed) {
    try await coordinator.createTab()
  }
}

@Test("Session coordinator rolls back a duplicate allocation without mutating layout")
func workspaceSessionCoordinatorRollsBackDuplicate() async throws {
  let probe = WorkspaceAllocationProbe([
    GhostteaWorkspaceSessionAllocation(sessionID: "session-a", session: "duplicate-resource")
  ])
  let initial = try singleSessionTabsDocument()
  let coordinator = try GhostteaWorkspaceSessionCoordinator(
    document: initial,
    sessions: ["session-a": "resource-a"],
    identityPrefix: "fixture",
    allocator: { try await probe.allocate($0) },
    terminator: { await probe.terminate(id: $0, session: $1) }
  )
  await #expect(throws: GhostteaWorkspaceSessionCoordinatorError.duplicateSessionID("session-a")) {
    try await coordinator.createTab()
  }
  #expect(await coordinator.document == initial)
  #expect(await probe.terminated.map(\.1) == ["duplicate-resource"])
}

@Test("Session coordinator rejects a registry that does not match the document")
func workspaceSessionCoordinatorRejectsRegistryMismatch() throws {
  #expect(throws: GhostteaWorkspaceSessionCoordinatorError.registryMismatch) {
    try GhostteaWorkspaceSessionCoordinator<String>(
      document: singleSessionTabsDocument(),
      sessions: [:],
      allocator: { _ in throw CocoaError(.fileNoSuchFile) },
      terminator: { _, _ in }
    )
  }
}
