import Foundation

public enum GhostteaWorkspaceCommandID: String, Codable, Sendable {
  case remoteSessions = "ghosttea.workspace.remote-sessions"
  case newTab = "ghosttea.workspace.new-tab"
  case selectTab = "ghosttea.workspace.select-tab"
  case closeTab = "ghosttea.workspace.close-tab"
  case split = "ghosttea.workspace.split"
  case focusRelative = "ghosttea.workspace.focus-relative"
  case focusDirection = "ghosttea.workspace.focus-direction"
  case resize = "ghosttea.workspace.resize"
  case equalize = "ghosttea.workspace.equalize"
  case toggleZoom = "ghosttea.workspace.toggle-zoom"
  case closePane = "ghosttea.workspace.close-pane"
}

public enum GhostteaWorkspaceTabTarget: Equatable, Sendable {
  case previous
  case next
  case last
  case index(Int)
}

public enum GhostteaWorkspaceCommand: Equatable, Sendable {
  case remoteSessions
  case newTab
  case selectTab(GhostteaWorkspaceTabTarget)
  case closeTab
  case split(GhostteaWorkspaceSplitAxis)
  case focusRelative(offset: Int)
  case focusDirection(GhostteaWorkspaceFocusDirection)
  case resize(axis: GhostteaWorkspaceSplitAxis, delta: Double)
  case equalize
  case toggleZoom
  case closePane

  public var id: GhostteaWorkspaceCommandID {
    switch self {
    case .remoteSessions: .remoteSessions
    case .newTab: .newTab
    case .selectTab: .selectTab
    case .closeTab: .closeTab
    case .split: .split
    case .focusRelative: .focusRelative
    case .focusDirection: .focusDirection
    case .resize: .resize
    case .equalize: .equalize
    case .toggleZoom: .toggleZoom
    case .closePane: .closePane
    }
  }
}

public struct GhostteaWorkspaceKeyChord: Equatable, Sendable {
  public let key: String
  public let command: Bool
  public let shift: Bool
  public let option: Bool
  public let control: Bool

  public init(
    key: String,
    command: Bool = false,
    shift: Bool = false,
    option: Bool = false,
    control: Bool = false
  ) {
    self.key = key
    self.command = command
    self.shift = shift
    self.option = option
    self.control = control
  }

  public init?(
    domCode: String,
    command: Bool = false,
    shift: Bool = false,
    option: Bool = false,
    control: Bool = false
  ) {
    guard let key = Self.key(forDOMCode: domCode) else { return nil }
    self.init(
      key: key,
      command: command,
      shift: shift,
      option: option,
      control: control
    )
  }

  public var workspaceCommand: GhostteaWorkspaceCommand? {
    let key = key.lowercased()
    if !command, control, !option, key == "tab" {
      return .selectTab(shift ? .previous : .next)
    }
    guard command else { return nil }
    if key == "t", !shift, !option, !control { return .newTab }
    if shift, !option, !control, key == "[" || key == "{" {
      return .selectTab(.previous)
    }
    if shift, !option, !control, key == "]" || key == "}" {
      return .selectTab(.next)
    }
    // Ghostty: super+1..8 = goto_tab, super+9 = last_tab
    if let index = Int(key), (1...8).contains(index), !shift, !option, !control {
      return .selectTab(.index(index))
    }
    if key == "9", !shift, !option, !control {
      return .selectTab(.last)
    }
    if key == "w", !shift, option, !control { return .closeTab }
    if key == "o", shift, !option, !control { return .remoteSessions }
    if key == "d", !option, !control { return .split(shift ? .vertical : .horizontal) }
    if key == "[", !shift, !option, !control { return .focusRelative(offset: -1) }
    if key == "]", !shift, !option, !control { return .focusRelative(offset: 1) }
    if option, let direction = Self.direction(for: key) {
      return .focusDirection(direction)
    }
    if control, let direction = Self.direction(for: key) {
      let axis: GhostteaWorkspaceSplitAxis =
        direction == .left || direction == .right ? .horizontal : .vertical
      let delta = direction == .left || direction == .up ? -0.05 : 0.05
      return .resize(axis: axis, delta: delta)
    }
    if control, key == "=" || key == "+" { return .equalize }
    if key == "enter", shift, !option, !control { return .toggleZoom }
    if key == "w", !shift, !option, !control { return .closePane }
    return nil
  }

  private static func direction(for key: String) -> GhostteaWorkspaceFocusDirection? {
    switch key {
    case "arrowleft": .left
    case "arrowright": .right
    case "arrowup": .up
    case "arrowdown": .down
    default: nil
    }
  }

  private static func key(forDOMCode code: String) -> String? {
    if code.hasPrefix("Key"), code.count == 4 { return String(code.suffix(1)).lowercased() }
    if code.hasPrefix("Digit"), code.count == 6 { return String(code.suffix(1)) }
    switch code {
    case "Tab": return "tab"
    case "Enter": return "enter"
    case "BracketLeft": return "["
    case "BracketRight": return "]"
    case "Equal": return "="
    case "ArrowLeft": return "arrowleft"
    case "ArrowRight": return "arrowright"
    case "ArrowUp": return "arrowup"
    case "ArrowDown": return "arrowdown"
    default: return nil
    }
  }
}

public enum GhostteaWorkspaceKeyPhase: Equatable, Sendable {
  case down
  case repeated
  case up
}

public struct GhostteaWorkspaceShortcutResult: Equatable, Sendable {
  public let handled: Bool
  public let command: GhostteaWorkspaceCommand?

  public init(handled: Bool, command: GhostteaWorkspaceCommand? = nil) {
    self.handled = handled
    self.command = command
  }
}

public struct GhostteaWorkspaceShortcutState: Equatable, Sendable {
  private var boundUsages: Set<UInt16> = []

  public init() {}

  public mutating func handle(
    usage: UInt16,
    phase: GhostteaWorkspaceKeyPhase,
    chord: GhostteaWorkspaceKeyChord?
  ) -> GhostteaWorkspaceShortcutResult {
    switch phase {
    case .up:
      return GhostteaWorkspaceShortcutResult(handled: boundUsages.remove(usage) != nil)
    case .repeated:
      return GhostteaWorkspaceShortcutResult(handled: boundUsages.contains(usage))
    case .down:
      guard let command = chord?.workspaceCommand else {
        return GhostteaWorkspaceShortcutResult(handled: false)
      }
      boundUsages.insert(usage)
      return GhostteaWorkspaceShortcutResult(handled: true, command: command)
    }
  }
}

public enum GhostteaWorkspaceCommandRoute: Equatable, Sendable {
  case reducer(GhostteaWorkspaceTabsAction)
  case requestNewTab
  case requestSplit(GhostteaWorkspaceSplitAxis)
  case openRemoteSessions
}

extension GhostteaWorkspaceCommand {
  public func route(in document: GhostteaWorkspaceTabsDocument) -> GhostteaWorkspaceCommandRoute? {
    switch self {
    case .remoteSessions:
      return .openRemoteSessions
    case .newTab:
      return .requestNewTab
    case .selectTab(let target):
      switch target {
      case .previous:
        return .reducer(.selectRelative(offset: -1))
      case .next:
        return .reducer(.selectRelative(offset: 1))
      case .last:
        guard let last = document.tabs.last else { return nil }
        return .reducer(.selectTab(id: last.id))
      case .index(let index):
        // Ghostty goto_tab: if the index is higher than the tab count, go to the last tab.
        guard !document.tabs.isEmpty else { return nil }
        let clamped = min(max(index, 1), document.tabs.count)
        return .reducer(.selectTab(id: document.tabs[clamped - 1].id))
      }
    case .closeTab:
      return .reducer(.closeTab(id: document.selectedTabID))
    case .split(let axis):
      return .requestSplit(axis)
    case .focusRelative(let offset):
      return .reducer(.applyToSelected(.focusRelative(offset: offset)))
    case .focusDirection(let direction):
      return .reducer(.applyToSelected(.focusDirection(direction)))
    case .resize(let axis, let delta):
      return .reducer(.applyToSelected(.resize(axis: axis, delta: delta)))
    case .equalize:
      return .reducer(.applyToSelected(.equalize))
    case .toggleZoom:
      return .reducer(.applyToSelected(.toggleZoom))
    case .closePane:
      return .reducer(.applyToSelected(.close))
    }
  }
}
