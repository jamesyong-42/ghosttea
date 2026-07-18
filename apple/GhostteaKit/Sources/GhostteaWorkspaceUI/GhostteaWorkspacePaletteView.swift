import GhostteaWorkspace
import SwiftUI

public struct GhostteaWorkspacePaletteView: View {
  private let entries: [GhostteaWorkspacePaletteEntry]
  private let onDismiss: () -> Void
  private let onInvoke: (GhostteaWorkspacePaletteInvocation) -> Void

  @State private var query = ""
  @State private var selectedEntryID: String?
  @FocusState private var searchFocused: Bool

  public init(
    entries: [GhostteaWorkspacePaletteEntry],
    onDismiss: @escaping () -> Void,
    onInvoke: @escaping (GhostteaWorkspacePaletteInvocation) -> Void
  ) {
    self.entries = entries
    self.onDismiss = onDismiss
    self.onInvoke = onInvoke
  }

  public var body: some View {
    VStack(spacing: 0) {
      HStack(spacing: 10) {
        Image(systemName: "command")
          .foregroundStyle(.secondary)
        TextField("Commands and connections", text: $query)
          .focused($searchFocused)
          .autocorrectionDisabled()
          .accessibilityLabel("Filter commands and connections")
      }
      .padding(.horizontal, 14)
      .frame(minHeight: 50)

      Divider()

      if snapshot.entries.isEmpty {
        ContentUnavailableView.search(text: query)
          .frame(maxWidth: .infinity, maxHeight: .infinity)
      } else {
        ScrollViewReader { proxy in
          List(snapshot.entries) { entry in
            Button {
              invoke(entry)
            } label: {
              HStack(spacing: 12) {
                Image(systemName: entry.category == .connections ? "server.rack" : "command")
                  .frame(width: 22)
                  .foregroundStyle(.secondary)
                VStack(alignment: .leading, spacing: 2) {
                  Text(entry.title)
                    .foregroundStyle(.primary)
                  Text(entry.subtitle)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                }
                Spacer()
                Text(entry.category.rawValue)
                  .font(.caption2)
                  .foregroundStyle(.tertiary)
              }
              .padding(.vertical, 3)
              .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .listRowBackground(
              entry.id == snapshot.selectedEntryID
                ? Color.accentColor.opacity(0.15)
                : Color.clear
            )
            .id(entry.id)
            .accessibilityIdentifier("ghosttea.palette.\(entry.id)")
          }
          .listStyle(.plain)
          .onChange(of: selectedEntryID) { _, selected in
            if let selected { proxy.scrollTo(selected, anchor: .center) }
          }
        }
      }

      Divider()
      HStack(spacing: 14) {
        Text("↑↓ Navigate")
        Text("↵ Open")
        Text("esc Close")
      }
      .font(.caption2)
      .foregroundStyle(.tertiary)
      .frame(maxWidth: .infinity, alignment: .trailing)
      .padding(.horizontal, 12)
      .frame(height: 32)
    }
    .frame(minWidth: 320, idealWidth: 560, minHeight: 300, idealHeight: 520)
    .onAppear {
      selectedEntryID = snapshot.selectedEntryID
      searchFocused = true
    }
    .onChange(of: query) { _, _ in
      selectedEntryID = snapshot.selectedEntryID
    }
    .onKeyPress(.downArrow) {
      selectedEntryID = snapshot.movingSelection(by: 1)
      return .handled
    }
    .onKeyPress(.upArrow) {
      selectedEntryID = snapshot.movingSelection(by: -1)
      return .handled
    }
    .onKeyPress(.return) {
      if let entry = snapshot.selectedEntry { invoke(entry) }
      return .handled
    }
    .onKeyPress(.escape) {
      onDismiss()
      return .handled
    }
    .onKeyPress("o", phases: .down) { press in
      guard
        press.modifiers.contains(.command),
        press.modifiers.contains(.shift),
        !press.modifiers.contains(.option),
        !press.modifiers.contains(.control)
      else { return .ignored }
      onDismiss()
      return .handled
    }
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("ghosttea.command-palette")
  }

  private var snapshot: GhostteaWorkspacePaletteSnapshot {
    GhostteaWorkspacePaletteSnapshot(
      entries: entries,
      query: query,
      preferredSelectionID: selectedEntryID
    )
  }

  private func invoke(_ entry: GhostteaWorkspacePaletteEntry) {
    onDismiss()
    onInvoke(entry.invocation)
  }
}
