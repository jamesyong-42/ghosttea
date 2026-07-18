import GhostteaWorkspace
import SwiftUI

public enum GhostteaWorkspacePresentationMode: Equatable, Sendable {
  case regularSplits
  case compactFocusedPane
}

public struct GhostteaWorkspacePresentation: Equatable, Sendable {
  public let mode: GhostteaWorkspacePresentationMode
  public let selectedTabID: String
  public let visiblePaneIDs: [String]
  public let focusedPaneID: String

  public init(
    document: GhostteaWorkspaceTabsDocument,
    mode: GhostteaWorkspacePresentationMode
  ) {
    let tab = document.tabs.first { $0.id == document.selectedTabID } ?? document.tabs[0]
    let panes = tab.workspace.root.panes
    let focusedPaneID = tab.workspace.zoomedPaneID ?? tab.workspace.activePaneID
    self.mode = mode
    self.selectedTabID = tab.id
    self.focusedPaneID = focusedPaneID
    switch mode {
    case .regularSplits:
      visiblePaneIDs =
        tab.workspace.zoomedPaneID == nil
        ? panes.map(\.id)
        : [focusedPaneID]
    case .compactFocusedPane:
      visiblePaneIDs = [focusedPaneID]
    }
  }
}

public struct GhostteaWorkspaceView<PaneContent: View>: View {
  public let document: GhostteaWorkspaceTabsDocument

  @Environment(\.horizontalSizeClass) private var horizontalSizeClass

  private let tabTitle: (GhostteaWorkspaceTab) -> String
  private let paneTitle: (GhostteaWorkspacePane) -> String
  private let onAction: (GhostteaWorkspaceTabsAction) -> Void
  private let onNewTab: (() -> Void)?
  private let onSplit: ((GhostteaWorkspaceSplitAxis) -> Void)?
  private let paneContent: (String, GhostteaWorkspacePane, Bool) -> PaneContent

  public init(
    document: GhostteaWorkspaceTabsDocument,
    tabTitle: @escaping (GhostteaWorkspaceTab) -> String = { $0.id },
    paneTitle: @escaping (GhostteaWorkspacePane) -> String = { $0.id },
    onAction: @escaping (GhostteaWorkspaceTabsAction) -> Void,
    onNewTab: (() -> Void)? = nil,
    onSplit: ((GhostteaWorkspaceSplitAxis) -> Void)? = nil,
    @ViewBuilder paneContent: @escaping (String, GhostteaWorkspacePane, Bool) -> PaneContent
  ) {
    self.document = document
    self.tabTitle = tabTitle
    self.paneTitle = paneTitle
    self.onAction = onAction
    self.onNewTab = onNewTab
    self.onSplit = onSplit
    self.paneContent = paneContent
  }

  public var body: some View {
    VStack(spacing: 0) {
      tabStrip
      Divider()
      if horizontalSizeClass == .compact {
        compactWorkspace
      } else {
        regularWorkspace
      }
    }
    .accessibilityIdentifier("ghosttea.workspace")
  }

  private var selectedTab: GhostteaWorkspaceTab {
    document.tabs.first { $0.id == document.selectedTabID } ?? document.tabs[0]
  }

  private var tabStrip: some View {
    ScrollView(.horizontal) {
      HStack(spacing: 4) {
        ForEach(Array(document.tabs.enumerated()), id: \.element.id) { index, tab in
          HStack(spacing: 2) {
            Button {
              onAction(.selectTab(id: tab.id))
            } label: {
              Text(tabTitle(tab))
                .lineLimit(1)
                .padding(.leading, 10)
                .padding(.vertical, 7)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Select tab \(tabTitle(tab))")

            Button {
              onAction(.closeTab(id: tab.id))
            } label: {
              Image(systemName: "xmark")
                .font(.caption)
                .padding(7)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Close tab \(tabTitle(tab))")
          }
          .background(
            RoundedRectangle(cornerRadius: 7)
              .fill(tab.id == document.selectedTabID ? Color.accentColor.opacity(0.2) : .clear)
          )
          .contextMenu {
            Button("Move Left") { onAction(.moveTab(id: tab.id, offset: -1)) }
              .disabled(index == 0)
            Button("Move Right") { onAction(.moveTab(id: tab.id, offset: 1)) }
              .disabled(index == document.tabs.count - 1)
          }
          .accessibilityIdentifier("ghosttea.tab.\(tab.id)")
        }

        if let onNewTab {
          Button(action: onNewTab) {
            Image(systemName: "plus")
              .padding(8)
          }
          .buttonStyle(.plain)
          .accessibilityLabel("New tab")
          .accessibilityIdentifier("ghosttea.tab.new")
        }

        if let onSplit {
          Menu {
            Button("Split Side by Side") { onSplit(.horizontal) }
            Button("Split Top and Bottom") { onSplit(.vertical) }
          } label: {
            Image(systemName: "rectangle.split.2x1")
              .padding(8)
          }
          .accessibilityLabel("Split terminal")
          .accessibilityIdentifier("ghosttea.pane.split")
        }
      }
      .padding(.horizontal, 6)
      .padding(.vertical, 4)
    }
    .scrollIndicators(.hidden)
  }

  private var regularWorkspace: some View {
    let workspace = selectedTab.workspace
    let node = workspace.zoomedPaneID.flatMap { workspace.root.pane(id: $0) } ?? workspace.root
    return GhostteaWorkspaceNodeView(
      tabID: selectedTab.id,
      node: node,
      activePaneID: workspace.activePaneID,
      onActivate: { paneID in
        onAction(.applyToSelected(.activate(paneID: paneID)))
      },
      paneContent: paneContent
    )
  }

  private var compactWorkspace: some View {
    let workspace = selectedTab.workspace
    let panes = workspace.root.panes
    let focusedID = workspace.zoomedPaneID ?? workspace.activePaneID
    let focused = panes.first { $0.id == focusedID } ?? panes[0]
    return VStack(spacing: 0) {
      if panes.count > 1 {
        HStack {
          if workspace.zoomedPaneID != nil {
            Label(paneTitle(focused), systemImage: "arrow.up.left.and.arrow.down.right")

            Spacer()

            Button("Exit Zoom") {
              onAction(.applyToSelected(.toggleZoom))
            }
            .accessibilityLabel("Exit pane zoom")
          } else {
            Menu {
              ForEach(Array(panes.enumerated()), id: \.element.id) { index, pane in
                Button {
                  onAction(.applyToSelected(.activate(paneID: pane.id)))
                } label: {
                  if pane.id == focused.id {
                    Label(paneTitle(pane), systemImage: "checkmark")
                  } else {
                    Text(paneTitle(pane))
                  }
                }
                .accessibilityLabel("Show pane \(index + 1) of \(panes.count)")
              }
            } label: {
              Label(
                "Pane \((panes.firstIndex { $0.id == focused.id } ?? 0) + 1) of \(panes.count)",
                systemImage: "rectangle.on.rectangle"
              )
            }

            Spacer()

            Button {
              onAction(.applyToSelected(.close))
            } label: {
              Image(systemName: "xmark.square")
            }
            .accessibilityLabel("Close current pane")
          }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 7)
        Divider()
      }

      pane(selectedTab.id, focused, isActive: true)
    }
  }

  private func pane(_ tabID: String, _ pane: GhostteaWorkspacePane, isActive: Bool) -> some View {
    paneContent(tabID, pane, isActive)
      .contentShape(Rectangle())
      .simultaneousGesture(
        TapGesture().onEnded {
          onAction(.applyToSelected(.activate(paneID: pane.id)))
        }
      )
      .overlay {
        Rectangle()
          .stroke(isActive ? Color.accentColor.opacity(0.65) : .clear, lineWidth: 1)
          .allowsHitTesting(false)
      }
      .accessibilityIdentifier("ghosttea.pane.\(pane.id)")
  }
}

private struct GhostteaWorkspaceNodeView<PaneContent: View>: View {
  let tabID: String
  let node: GhostteaWorkspaceNode
  let activePaneID: String
  let onActivate: (String) -> Void
  let paneContent: (String, GhostteaWorkspacePane, Bool) -> PaneContent

  var body: some View { render(node) }

  private func render(_ node: GhostteaWorkspaceNode) -> AnyView {
    switch node {
    case .pane(let pane):
      return AnyView(
        paneContent(tabID, pane, pane.id == activePaneID)
          .contentShape(Rectangle())
          .simultaneousGesture(TapGesture().onEnded { onActivate(pane.id) })
          .overlay {
            Rectangle()
              .stroke(
                pane.id == activePaneID ? Color.accentColor.opacity(0.65) : .clear,
                lineWidth: 1
              )
              .allowsHitTesting(false)
          }
          .accessibilityIdentifier("ghosttea.pane.\(pane.id)")
      )
    case .split(let split):
      return AnyView(
        GeometryReader { geometry in
          let divider: CGFloat = 1
          switch split.axis {
          case .horizontal:
            let width = max(0, geometry.size.width - divider)
            HStack(spacing: 0) {
              render(split.first)
                .frame(width: width * split.ratio)
              Divider().frame(width: divider)
              render(split.second)
                .frame(width: width * (1 - split.ratio))
            }
          case .vertical:
            let height = max(0, geometry.size.height - divider)
            VStack(spacing: 0) {
              render(split.first)
                .frame(height: height * split.ratio)
              Divider().frame(height: divider)
              render(split.second)
                .frame(height: height * (1 - split.ratio))
            }
          }
        }
      )
    }
  }
}

extension GhostteaWorkspaceNode {
  fileprivate func pane(id: String) -> GhostteaWorkspaceNode? {
    switch self {
    case .pane(let pane):
      return pane.id == id ? self : nil
    case .split(let split):
      return split.first.pane(id: id) ?? split.second.pane(id: id)
    }
  }
}
