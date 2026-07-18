import Foundation
import GhostteaWorkspace
import Testing

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
