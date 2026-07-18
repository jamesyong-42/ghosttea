import Foundation

public enum GhostteaWorkspacePaletteCategory: String, Equatable, Sendable {
  case connections = "Connections"
  case workspace = "Workspace"
}

public enum GhostteaWorkspacePaletteInvocation: Equatable, Sendable {
  case command(GhostteaWorkspaceCommand)
  case connectionProfile(profileID: String)
}

public struct GhostteaWorkspacePaletteEntry: Equatable, Sendable, Identifiable {
  public let id: String
  public let title: String
  public let subtitle: String
  public let category: GhostteaWorkspacePaletteCategory
  public let keywords: [String]
  public let invocation: GhostteaWorkspacePaletteInvocation

  public init(
    id: String,
    title: String,
    subtitle: String,
    category: GhostteaWorkspacePaletteCategory,
    keywords: [String] = [],
    invocation: GhostteaWorkspacePaletteInvocation
  ) {
    self.id = id
    self.title = title
    self.subtitle = subtitle
    self.category = category
    self.keywords = keywords
    self.invocation = invocation
  }

  public static func connectionProfile(
    profileID: String,
    name: String,
    subtitle: String,
    keywords: [String] = []
  ) -> Self {
    Self(
      id: "ghosttea.connection-profile.\(profileID)",
      title: name,
      subtitle: subtitle,
      category: .connections,
      keywords: keywords,
      invocation: .connectionProfile(profileID: profileID)
    )
  }

  public static func workspaceCommands() -> [Self] {
    [
      command(
        id: "new-tab",
        title: "New Tab",
        subtitle: "Open another terminal",
        keywords: ["terminal", "command-t"],
        invocation: .newTab
      ),
      command(
        id: "split-horizontal",
        title: "Split Side by Side",
        subtitle: "Create a terminal to the right",
        keywords: ["horizontal", "command-d"],
        invocation: .split(.horizontal)
      ),
      command(
        id: "split-vertical",
        title: "Split Top and Bottom",
        subtitle: "Create a terminal below",
        keywords: ["vertical", "command-shift-d"],
        invocation: .split(.vertical)
      ),
      command(
        id: "previous-tab",
        title: "Select Previous Tab",
        subtitle: "Move selection left",
        invocation: .selectTab(.previous)
      ),
      command(
        id: "next-tab",
        title: "Select Next Tab",
        subtitle: "Move selection right",
        invocation: .selectTab(.next)
      ),
      command(
        id: "toggle-zoom",
        title: "Toggle Pane Zoom",
        subtitle: "Show or restore the focused pane",
        keywords: ["maximize"],
        invocation: .toggleZoom
      ),
      command(
        id: "equalize",
        title: "Equalize Splits",
        subtitle: "Reset split ratios",
        keywords: ["balance"],
        invocation: .equalize
      ),
      command(
        id: "close-pane",
        title: "Close Pane",
        subtitle: "Close the focused terminal",
        keywords: ["command-w"],
        invocation: .closePane
      ),
      command(
        id: "close-tab",
        title: "Close Tab",
        subtitle: "Close every terminal in this tab",
        keywords: ["command-option-w"],
        invocation: .closeTab
      ),
    ]
  }

  private static func command(
    id: String,
    title: String,
    subtitle: String,
    keywords: [String] = [],
    invocation: GhostteaWorkspaceCommand
  ) -> Self {
    Self(
      id: "ghosttea.workspace.palette.\(id)",
      title: title,
      subtitle: subtitle,
      category: .workspace,
      keywords: keywords,
      invocation: .command(invocation)
    )
  }
}

public struct GhostteaWorkspacePaletteSnapshot: Equatable, Sendable {
  public let entries: [GhostteaWorkspacePaletteEntry]
  public let selectedEntryID: String?

  public init(
    entries sourceEntries: [GhostteaWorkspacePaletteEntry],
    query: String,
    preferredSelectionID: String? = nil
  ) {
    var seenIDs = Set<String>()
    let uniqueEntries = sourceEntries.filter { seenIDs.insert($0.id).inserted }
    let tokens = Self.normalized(query).split(separator: " ").map(String.init)
    let ranked = uniqueEntries.enumerated().compactMap { index, entry -> RankedEntry? in
      guard let score = Self.score(entry, tokens: tokens) else { return nil }
      return RankedEntry(entry: entry, score: score, originalIndex: index)
    }
    let filteredEntries = ranked.sorted {
      $0.score == $1.score ? $0.originalIndex < $1.originalIndex : $0.score < $1.score
    }.map(\.entry)
    entries = filteredEntries
    selectedEntryID =
      preferredSelectionID.flatMap { preferred in
        filteredEntries.contains { $0.id == preferred } ? preferred : nil
      } ?? filteredEntries.first?.id
  }

  public var selectedEntry: GhostteaWorkspacePaletteEntry? {
    selectedEntryID.flatMap { selected in entries.first { $0.id == selected } }
  }

  public func movingSelection(by offset: Int) -> String? {
    guard !entries.isEmpty else { return nil }
    let index =
      selectedEntryID.flatMap { selected in
        entries.firstIndex { $0.id == selected }
      } ?? 0
    let next = ((index + offset) % entries.count + entries.count) % entries.count
    return entries[next].id
  }

  private struct RankedEntry {
    let entry: GhostteaWorkspacePaletteEntry
    let score: Int
    let originalIndex: Int
  }

  private static func score(
    _ entry: GhostteaWorkspacePaletteEntry,
    tokens: [String]
  ) -> Int? {
    guard !tokens.isEmpty else { return 0 }
    let title = normalized(entry.title)
    let subtitle = normalized(entry.subtitle)
    let keywords = normalized(entry.keywords.joined(separator: " "))
    let category = normalized(entry.category.rawValue)
    let haystack = [title, subtitle, keywords, category].joined(separator: " ")
    guard tokens.allSatisfy(haystack.contains) else { return nil }
    return tokens.reduce(0) { score, token in
      if title.hasPrefix(token) { return score }
      if title.contains(token) { return score + 1 }
      if subtitle.contains(token) { return score + 2 }
      return score + 3
    }
  }

  private static func normalized(_ value: String) -> String {
    value.folding(
      options: [.caseInsensitive, .diacriticInsensitive, .widthInsensitive],
      locale: .current
    ).split(whereSeparator: \Character.isWhitespace).joined(separator: " ")
  }
}
