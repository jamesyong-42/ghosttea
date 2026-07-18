import Foundation
import GhostteaCore

public enum GhostteaSoftwareInputEvent: Equatable, Sendable {
  case text(String)
  case enter
  case deleteBackward
  case paste(String)
  case key(GhostteaHardwareKeyEvent)
}

public struct GhostteaMarkedTextState: Equatable, Sendable {
  public let text: String
  public let selectionLocation: Int
  public let selectionLength: Int

  public init(text: String, selectionLocation: Int, selectionLength: Int) {
    self.text = text
    self.selectionLocation = selectionLocation
    self.selectionLength = selectionLength
  }
}

extension GhostteaTerminalInputEncoder {
  public func encode(_ event: GhostteaSoftwareInputEvent) async throws -> GhostteaInputEncoding {
    switch event {
    case .text(let text):
      return encodeCommittedText(text)
    case .enter:
      return .bytes(try await terminal.encodeKey(Self.softwareKey(hidUsage: 0x28)))
    case .deleteBackward:
      return .bytes(try await terminal.encodeKey(Self.softwareKey(hidUsage: 0x2a)))
    case .paste(let text):
      guard !text.isEmpty else { return .ignored }
      return .bytes(try await terminal.encodePaste(text))
    case .key(let key):
      return try await encode(key)
    }
  }

  private static func softwareKey(hidUsage: UInt16) -> GhostteaKeyEvent {
    guard
      let event = GhostteaHardwareKeyEvent(
        hidUsage: hidUsage,
        characters: "",
        charactersIgnoringModifiers: "",
        action: .down
      )
    else {
      preconditionFailure("Missing known software-key HID usage \(hidUsage)")
    }
    return event.coreEvent
  }
}

struct GhostteaCompositionBuffer: Equatable, Sendable {
  private(set) var text = ""
  private(set) var selection = NSRange(location: 0, length: 0)
  private(set) var isMarked = false

  var utf16Count: Int { (text as NSString).length }

  var markedState: GhostteaMarkedTextState? {
    guard isMarked else { return nil }
    return GhostteaMarkedTextState(
      text: text,
      selectionLocation: selection.location,
      selectionLength: selection.length
    )
  }

  mutating func setMarkedText(
    _ markedText: String?,
    selectedRange: NSRange
  ) -> [GhostteaSoftwareInputEvent] {
    guard let markedText else { return unmarkText() }
    text = markedText
    isMarked = !markedText.isEmpty
    selection = Self.clamp(selectedRange, length: utf16Count)
    return []
  }

  mutating func setSelectedRange(_ range: NSRange) {
    selection = Self.clamp(range, length: utf16Count)
  }

  mutating func insertText(_ insertedText: String) -> [GhostteaSoftwareInputEvent] {
    clear()
    return Self.committedEvents(insertedText)
  }

  mutating func unmarkText() -> [GhostteaSoftwareInputEvent] {
    guard isMarked else { return [] }
    let committed = text
    clear()
    return Self.committedEvents(committed)
  }

  mutating func replace(_ range: NSRange, with replacement: String) -> [GhostteaSoftwareInputEvent]
  {
    guard isMarked else { return Self.committedEvents(replacement) }
    let range = Self.clamp(range, length: utf16Count)
    text = (text as NSString).replacingCharacters(in: range, with: replacement)
    let location = range.location + (replacement as NSString).length
    selection = NSRange(location: location, length: 0)
    isMarked = !text.isEmpty
    return []
  }

  mutating func deleteBackward() -> [GhostteaSoftwareInputEvent] {
    guard isMarked else { return [.deleteBackward] }
    let source = text as NSString
    let deletion: NSRange
    if selection.length > 0 {
      deletion = Self.clamp(selection, length: source.length)
    } else if selection.location > 0 {
      deletion = source.rangeOfComposedCharacterSequence(at: selection.location - 1)
    } else {
      return []
    }
    text = source.replacingCharacters(in: deletion, with: "")
    selection = NSRange(location: deletion.location, length: 0)
    isMarked = !text.isEmpty
    return []
  }

  func text(in range: NSRange) -> String {
    (text as NSString).substring(with: Self.clamp(range, length: utf16Count))
  }

  func composedCharacterRange(adjoining offset: Int, towardStart: Bool) -> NSRange {
    let source = text as NSString
    let offset = max(0, min(source.length, offset))
    if towardStart {
      guard offset > 0 else { return NSRange(location: 0, length: 0) }
      return source.rangeOfComposedCharacterSequence(at: offset - 1)
    }
    guard offset < source.length else { return NSRange(location: offset, length: 0) }
    return source.rangeOfComposedCharacterSequence(at: offset)
  }

  static func committedEvents(_ text: String) -> [GhostteaSoftwareInputEvent] {
    var events: [GhostteaSoftwareInputEvent] = []
    var current = ""
    func flush() {
      guard !current.isEmpty else { return }
      events.append(.text(current))
      current = ""
    }
    for character in text {
      if character == "\n" || character == "\r" || character == "\r\n" {
        flush()
        events.append(.enter)
      } else {
        current.append(character)
      }
    }
    flush()
    return events
  }

  private mutating func clear() {
    text = ""
    selection = NSRange(location: 0, length: 0)
    isMarked = false
  }

  private static func clamp(_ range: NSRange, length: Int) -> NSRange {
    let location = max(0, min(length, range.location))
    return NSRange(location: location, length: max(0, min(length - location, range.length)))
  }
}
