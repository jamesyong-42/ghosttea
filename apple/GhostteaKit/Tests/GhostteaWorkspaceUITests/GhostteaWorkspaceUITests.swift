import GhostteaWorkspace
import GhostteaWorkspaceUI
import Testing

private func presentationDocument(zoomedPaneID: String? = nil) throws
  -> GhostteaWorkspaceTabsDocument
{
  let first = GhostteaWorkspaceNode.pane(
    GhostteaWorkspacePane(id: "pane-1", sessionID: "session-1")
  )
  let second = GhostteaWorkspaceNode.pane(
    GhostteaWorkspacePane(id: "pane-2", sessionID: "session-2")
  )
  let workspace = try GhostteaWorkspaceDocument(
    root: .split(
      GhostteaWorkspaceSplit(
        id: "split-1",
        axis: .horizontal,
        ratio: 0.5,
        first: first,
        second: second
      )
    ),
    activePaneID: "pane-2",
    zoomedPaneID: zoomedPaneID
  )
  let other = try GhostteaWorkspaceDocument(
    root: .pane(GhostteaWorkspacePane(id: "pane-3", sessionID: "session-3")),
    activePaneID: "pane-3"
  )
  return try GhostteaWorkspaceTabsDocument(
    selectedTabID: "tab-1",
    tabs: [
      GhostteaWorkspaceTab(id: "tab-1", workspace: workspace),
      GhostteaWorkspaceTab(id: "tab-2", workspace: other),
    ]
  )
}

@Test("Regular presentation shows every selected-tab pane and no hidden-tab pane")
func regularPresentationUsesTheSelectedTabTree() throws {
  let presentation = GhostteaWorkspacePresentation(
    document: try presentationDocument(),
    mode: .regularSplits
  )
  #expect(presentation.selectedTabID == "tab-1")
  #expect(presentation.visiblePaneIDs == ["pane-1", "pane-2"])
  #expect(presentation.focusedPaneID == "pane-2")
}

@Test("Compact presentation keeps the complete model but exposes only focused pane")
func compactPresentationUsesOnlyTheFocusedPane() throws {
  let presentation = GhostteaWorkspacePresentation(
    document: try presentationDocument(),
    mode: .compactFocusedPane
  )
  #expect(presentation.visiblePaneIDs == ["pane-2"])
  #expect(presentation.focusedPaneID == "pane-2")
}

@Test("Zoom shows one pane in both size classes")
func zoomOverridesRegularAndCompactVisibility() throws {
  let document = try presentationDocument(zoomedPaneID: "pane-1")
  let regular = GhostteaWorkspacePresentation(document: document, mode: .regularSplits)
  let compact = GhostteaWorkspacePresentation(document: document, mode: .compactFocusedPane)
  #expect(regular.visiblePaneIDs == ["pane-1"])
  #expect(compact.visiblePaneIDs == ["pane-1"])
  #expect(regular.focusedPaneID == "pane-1")
  #expect(compact.focusedPaneID == "pane-1")
}
