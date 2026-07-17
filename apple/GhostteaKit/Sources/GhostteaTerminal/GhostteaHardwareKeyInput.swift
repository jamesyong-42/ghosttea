import Foundation
import GhostteaCore
#if os(iOS)
  import UIKit
#endif

public struct GhostteaInputModifiers: OptionSet, Equatable, Sendable {
  public let rawValue: UInt16

  public init(rawValue: UInt16) {
    self.rawValue = rawValue
  }

  public static let shift = Self(rawValue: 1 << 0)
  public static let control = Self(rawValue: 1 << 1)
  public static let option = Self(rawValue: 1 << 2)
  public static let command = Self(rawValue: 1 << 3)
}

public enum GhostteaHardwareKeyAction: UInt8, Equatable, Sendable {
  case up = 0
  case down = 1
  case repeated = 2
}

public struct GhostteaHardwareKeyEvent: Equatable, Sendable {
  public let hidUsage: UInt16
  public let code: String
  public let text: String
  public let unshiftedCodepoint: UInt32
  public let modifiers: GhostteaInputModifiers
  public let action: GhostteaHardwareKeyAction

  public init?(
    hidUsage: UInt16,
    characters: String,
    charactersIgnoringModifiers: String,
    modifiers: GhostteaInputModifiers = [],
    action: GhostteaHardwareKeyAction
  ) {
    guard let code = GhostteaHIDKeyCode.domCode(for: hidUsage) else { return nil }
    self.hidUsage = hidUsage
    self.code = code
    let acceptsText = GhostteaHIDKeyCode.acceptsText(for: hidUsage)
    text = action == .up || !acceptsText ? "" : Self.printableScalar(characters)
    unshiftedCodepoint = acceptsText ? Self.scalarValue(charactersIgnoringModifiers) : 0
    self.modifiers = modifiers
    self.action = action
  }

  public var coreEvent: GhostteaKeyEvent {
    GhostteaKeyEvent(
      code: code,
      text: text,
      unshiftedCodepoint: unshiftedCodepoint,
      modifiers: modifiers.rawValue,
      action: action.rawValue
    )
  }

  func replacingAction(_ action: GhostteaHardwareKeyAction) -> Self {
    Self(
      hidUsage: hidUsage,
      code: code,
      text: action == .up ? "" : text,
      unshiftedCodepoint: unshiftedCodepoint,
      modifiers: modifiers,
      action: action
    )
  }

  private init(
    hidUsage: UInt16,
    code: String,
    text: String,
    unshiftedCodepoint: UInt32,
    modifiers: GhostteaInputModifiers,
    action: GhostteaHardwareKeyAction
  ) {
    self.hidUsage = hidUsage
    self.code = code
    self.text = text
    self.unshiftedCodepoint = unshiftedCodepoint
    self.modifiers = modifiers
    self.action = action
  }

  private static func printableScalar(_ text: String) -> String {
    guard scalarValue(text) != 0 else { return "" }
    return text
  }

  private static func scalarValue(_ text: String) -> UInt32 {
    guard text.unicodeScalars.count == 1, let scalar = text.unicodeScalars.first else { return 0 }
    return scalar.value >= 0x20 && scalar.value != 0x7f ? scalar.value : 0
  }
}

public enum GhostteaOptionKeyBehavior: Equatable, Sendable {
  case terminal
  case naturalTextEditing
}

public struct GhostteaTerminalInputConfiguration: Equatable, Sendable {
  public var optionKeyBehavior: GhostteaOptionKeyBehavior

  public init(optionKeyBehavior: GhostteaOptionKeyBehavior = .naturalTextEditing) {
    self.optionKeyBehavior = optionKeyBehavior
  }
}

public enum GhostteaApplicationShortcut: Equatable, Sendable {
  case copy
  case selectAll
  case clearScrollback
  case toggleFullscreen
  case unhandled
}

public enum GhostteaInputEncoding: Equatable, Sendable {
  case bytes(Data)
  case pasteFromClipboard
  case applicationShortcut(GhostteaApplicationShortcut)
  case ignored
}

public actor GhostteaTerminalInputEncoder {
  public let terminal: GhostteaTerminal
  public private(set) var configuration: GhostteaTerminalInputConfiguration

  private var applicationBoundUsages: Set<UInt16> = []

  public init(
    terminal: GhostteaTerminal,
    configuration: GhostteaTerminalInputConfiguration = .init()
  ) {
    self.terminal = terminal
    self.configuration = configuration
  }

  public func setConfiguration(_ configuration: GhostteaTerminalInputConfiguration) {
    self.configuration = configuration
  }

  public func encode(_ event: GhostteaHardwareKeyEvent) async throws -> GhostteaInputEncoding {
    if event.action == .up, applicationBoundUsages.remove(event.hidUsage) != nil {
      return .ignored
    }
    if event.action != .up, let binding = applicationBinding(for: event) {
      applicationBoundUsages.insert(event.hidUsage)
      return binding
    }
    return .bytes(try await terminal.encodeKey(event.coreEvent))
  }

  public func encodeCommittedText(_ text: String) -> GhostteaInputEncoding {
    guard !text.isEmpty else { return .ignored }
    return .bytes(Data(text.utf8))
  }

  public func encodePaste(_ text: String) async throws -> Data {
    try await terminal.encodePaste(text)
  }

  private func applicationBinding(
    for event: GhostteaHardwareKeyEvent
  ) -> GhostteaInputEncoding? {
    let modifiers = event.modifiers
    if modifiers.contains(.command) {
      if !modifiers.contains(.shift) && !modifiers.contains(.control)
        && !modifiers.contains(.option)
      {
        switch event.code {
        case "KeyV": return .pasteFromClipboard
        case "ArrowRight": return .bytes(Data([0x05]))
        case "ArrowLeft": return .bytes(Data([0x01]))
        case "Backspace": return .bytes(Data([0x15]))
        default: break
        }
      }
      switch event.code {
      case "KeyC": return .applicationShortcut(.copy)
      case "KeyA": return .applicationShortcut(.selectAll)
      case "KeyK": return .applicationShortcut(.clearScrollback)
      case "Enter": return .applicationShortcut(.toggleFullscreen)
      case "KeyF" where modifiers.contains(.control):
        return .applicationShortcut(.toggleFullscreen)
      default: return .applicationShortcut(.unhandled)
      }
    }
    if configuration.optionKeyBehavior == .naturalTextEditing
      && modifiers == [.option]
    {
      switch event.code {
      case "ArrowLeft": return .bytes(Data([0x1b, 0x62]))
      case "ArrowRight": return .bytes(Data([0x1b, 0x66]))
      default: break
      }
    }
    return nil
  }
}

public enum GhostteaHIDKeyCode {
  public static func domCode(for usage: UInt16) -> String? {
    switch usage {
    case 0x04...0x1d:
      let scalar = UnicodeScalar(65 + Int(usage - 0x04))!
      return "Key\(Character(scalar))"
    case 0x1e...0x26: return "Digit\(usage - 0x1d)"
    case 0x27: return "Digit0"
    case 0x3a...0x45: return "F\(usage - 0x39)"
    case 0x68...0x73: return "F\(usage - 0x5b)"
    case 0x59...0x61: return "Numpad\(usage - 0x58)"
    default: return namedCodes[usage]
    }
  }

  static func acceptsText(for usage: UInt16) -> Bool {
    switch usage {
    case 0x04...0x27, 0x2c...0x38, 0x54...0x57, 0x59...0x64, 0x67, 0x85, 0x87,
      0x89:
      true
    default:
      false
    }
  }

  private static let namedCodes: [UInt16: String] = [
    0x28: "Enter", 0x29: "Escape", 0x2a: "Backspace", 0x2b: "Tab", 0x2c: "Space",
    0x2d: "Minus", 0x2e: "Equal", 0x2f: "BracketLeft", 0x30: "BracketRight",
    0x31: "Backslash", 0x32: "IntlHash", 0x33: "Semicolon", 0x34: "Quote",
    0x35: "Backquote", 0x36: "Comma", 0x37: "Period", 0x38: "Slash",
    0x39: "CapsLock", 0x46: "PrintScreen", 0x47: "ScrollLock", 0x48: "Pause",
    0x49: "Insert", 0x4a: "Home", 0x4b: "PageUp", 0x4c: "Delete", 0x4d: "End",
    0x4e: "PageDown", 0x4f: "ArrowRight", 0x50: "ArrowLeft", 0x51: "ArrowDown",
    0x52: "ArrowUp", 0x53: "NumLock", 0x54: "NumpadDivide", 0x55: "NumpadMultiply",
    0x56: "NumpadSubtract", 0x57: "NumpadAdd", 0x58: "NumpadEnter",
    0x62: "Numpad0", 0x63: "NumpadDecimal", 0x64: "IntlBackslash",
    0x67: "NumpadEqual", 0x87: "IntlRo", 0x89: "IntlYen", 0x90: "Lang1",
    0x91: "Lang2", 0xe0: "ControlLeft", 0xe1: "ShiftLeft", 0xe2: "AltLeft",
    0xe3: "MetaLeft", 0xe4: "ControlRight", 0xe5: "ShiftRight", 0xe6: "AltRight",
    0xe7: "MetaRight",
  ]
}

#if os(iOS)
  extension GhostteaInputModifiers {
    @MainActor
    init(_ flags: UIKeyModifierFlags) {
      var modifiers: GhostteaInputModifiers = []
      if flags.contains(.shift) { modifiers.insert(.shift) }
      if flags.contains(.control) { modifiers.insert(.control) }
      if flags.contains(.alternate) { modifiers.insert(.option) }
      if flags.contains(.command) { modifiers.insert(.command) }
      self = modifiers
    }
  }
#endif
