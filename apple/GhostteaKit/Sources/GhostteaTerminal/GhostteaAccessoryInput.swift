import Foundation

public enum GhostteaAccessoryKey: Equatable, Sendable {
  case escape
  case tab
  case control
  case option
  case arrowLeft
  case arrowDown
  case arrowUp
  case arrowRight
  case home
  case end
  case pageUp
  case pageDown
  case pipe
  case tilde
  case backquote

  public static let terminalDefaults: [Self] = [
    .escape, .tab, .control, .option,
    .arrowLeft, .arrowDown, .arrowUp, .arrowRight,
    .home, .end, .pageUp, .pageDown,
    .pipe, .tilde, .backquote,
  ]
}

struct GhostteaAccessoryInputState: Equatable, Sendable {
  private(set) var modifiers: GhostteaInputModifiers = []

  mutating func activate(_ key: GhostteaAccessoryKey) -> GhostteaSoftwareInputEvent? {
    switch key {
    case .control:
      modifiers.formSymmetricDifference(.control)
      return nil
    case .option:
      modifiers.formSymmetricDifference(.option)
      return nil
    default:
      defer { modifiers = [] }
      return .key(Self.event(for: key, modifiers: modifiers))
    }
  }

  mutating func consume(_ event: GhostteaSoftwareInputEvent) -> GhostteaSoftwareInputEvent {
    guard !modifiers.isEmpty else { return event }
    defer { modifiers = [] }
    switch event {
    case .text(let text):
      guard let key = Self.event(forCommittedText: text, modifiers: modifiers) else {
        return event
      }
      return .key(key)
    case .enter:
      return .key(Self.event(hidUsage: 0x28, modifiers: modifiers))
    case .deleteBackward:
      return .key(Self.event(hidUsage: 0x2a, modifiers: modifiers))
    case .paste, .key:
      return event
    }
  }

  mutating func clear() {
    modifiers = []
  }

  private static func event(
    for key: GhostteaAccessoryKey,
    modifiers: GhostteaInputModifiers
  ) -> GhostteaHardwareKeyEvent {
    switch key {
    case .escape: return event(hidUsage: 0x29, modifiers: modifiers)
    case .tab: return event(hidUsage: 0x2b, modifiers: modifiers)
    case .arrowRight: return event(hidUsage: 0x4f, modifiers: modifiers)
    case .arrowLeft: return event(hidUsage: 0x50, modifiers: modifiers)
    case .arrowDown: return event(hidUsage: 0x51, modifiers: modifiers)
    case .arrowUp: return event(hidUsage: 0x52, modifiers: modifiers)
    case .home: return event(hidUsage: 0x4a, modifiers: modifiers)
    case .end: return event(hidUsage: 0x4d, modifiers: modifiers)
    case .pageUp: return event(hidUsage: 0x4b, modifiers: modifiers)
    case .pageDown: return event(hidUsage: 0x4e, modifiers: modifiers)
    case .pipe:
      return event(
        hidUsage: 0x31,
        characters: "|",
        charactersIgnoringModifiers: "\\",
        modifiers: modifiers.union(.shift)
      )
    case .tilde:
      return event(
        hidUsage: 0x35,
        characters: "~",
        charactersIgnoringModifiers: "`",
        modifiers: modifiers.union(.shift)
      )
    case .backquote:
      return event(
        hidUsage: 0x35,
        characters: "`",
        charactersIgnoringModifiers: "`",
        modifiers: modifiers
      )
    case .control, .option:
      preconditionFailure("Modifier accessory keys do not produce standalone events")
    }
  }

  private static func event(
    forCommittedText text: String,
    modifiers: GhostteaInputModifiers
  ) -> GhostteaHardwareKeyEvent? {
    guard text.unicodeScalars.count == 1, let scalar = text.unicodeScalars.first else {
      return nil
    }
    let value = scalar.value
    if value >= 65, value <= 90 {
      let lower = String(UnicodeScalar(value + 32)!)
      return event(
        hidUsage: UInt16(0x04 + value - 65),
        characters: text,
        charactersIgnoringModifiers: lower,
        modifiers: modifiers.union(.shift)
      )
    }
    if value >= 97, value <= 122 {
      return event(
        hidUsage: UInt16(0x04 + value - 97),
        characters: text,
        charactersIgnoringModifiers: text,
        modifiers: modifiers
      )
    }
    if value >= 49, value <= 57 {
      return event(
        hidUsage: UInt16(0x1e + value - 49),
        characters: text,
        charactersIgnoringModifiers: text,
        modifiers: modifiers
      )
    }
    if value == 48 {
      return event(
        hidUsage: 0x27,
        characters: text,
        charactersIgnoringModifiers: text,
        modifiers: modifiers
      )
    }
    return nil
  }

  private static func event(
    hidUsage: UInt16,
    characters: String = "",
    charactersIgnoringModifiers: String = "",
    modifiers: GhostteaInputModifiers
  ) -> GhostteaHardwareKeyEvent {
    guard
      let event = GhostteaHardwareKeyEvent(
        hidUsage: hidUsage,
        characters: characters,
        charactersIgnoringModifiers: charactersIgnoringModifiers,
        modifiers: modifiers,
        action: .down
      )
    else {
      preconditionFailure("Missing known accessory-key HID usage \(hidUsage)")
    }
    return event
  }
}

#if os(iOS)
  import UIKit

  @MainActor
  final class GhostteaTerminalAccessoryView: UIInputView {
    var onKey: ((GhostteaAccessoryKey) -> Void)?

    private let scrollView = UIScrollView()
    private let stackView = UIStackView()
    private var keys: [GhostteaAccessoryKey] = []
    private var buttons: [UIButton] = []

    init(keys: [GhostteaAccessoryKey]) {
      super.init(frame: CGRect(x: 0, y: 0, width: 0, height: 46), inputViewStyle: .keyboard)
      autoresizingMask = [.flexibleWidth]
      stackView.axis = .horizontal
      stackView.alignment = .fill
      stackView.spacing = 6
      stackView.isLayoutMarginsRelativeArrangement = true
      stackView.directionalLayoutMargins = NSDirectionalEdgeInsets(
        top: 4,
        leading: 8,
        bottom: 4,
        trailing: 8
      )
      scrollView.showsHorizontalScrollIndicator = false
      scrollView.alwaysBounceHorizontal = true
      addSubview(scrollView)
      scrollView.addSubview(stackView)
      scrollView.translatesAutoresizingMaskIntoConstraints = false
      stackView.translatesAutoresizingMaskIntoConstraints = false
      NSLayoutConstraint.activate([
        heightAnchor.constraint(equalToConstant: 46),
        scrollView.leadingAnchor.constraint(equalTo: leadingAnchor),
        scrollView.trailingAnchor.constraint(equalTo: trailingAnchor),
        scrollView.topAnchor.constraint(equalTo: topAnchor),
        scrollView.bottomAnchor.constraint(equalTo: bottomAnchor),
        stackView.leadingAnchor.constraint(equalTo: scrollView.contentLayoutGuide.leadingAnchor),
        stackView.trailingAnchor.constraint(equalTo: scrollView.contentLayoutGuide.trailingAnchor),
        stackView.topAnchor.constraint(equalTo: scrollView.contentLayoutGuide.topAnchor),
        stackView.bottomAnchor.constraint(equalTo: scrollView.contentLayoutGuide.bottomAnchor),
        stackView.heightAnchor.constraint(equalTo: scrollView.frameLayoutGuide.heightAnchor),
      ])
      setKeys(keys)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
      fatalError("init(coder:) has not been implemented")
    }

    func setKeys(_ keys: [GhostteaAccessoryKey]) {
      self.keys = keys
      for button in buttons { button.removeFromSuperview() }
      buttons = keys.enumerated().map { index, key in
        var configuration = UIButton.Configuration.gray()
        configuration.title = key.label
        configuration.cornerStyle = .small
        let button = UIButton(configuration: configuration)
        button.tag = index
        button.accessibilityLabel = key.accessibilityLabel
        button.addTarget(self, action: #selector(buttonPressed(_:)), for: .touchUpInside)
        button.widthAnchor.constraint(greaterThanOrEqualToConstant: key.minimumWidth).isActive =
          true
        stackView.addArrangedSubview(button)
        return button
      }
    }

    func updateModifiers(_ modifiers: GhostteaInputModifiers) {
      for (key, button) in zip(keys, buttons) {
        let selected: Bool
        switch key {
        case .control: selected = modifiers.contains(.control)
        case .option: selected = modifiers.contains(.option)
        default: selected = false
        }
        button.isSelected = selected
        var configuration = button.configuration
        configuration?.baseBackgroundColor = selected ? .systemBlue : .secondarySystemFill
        configuration?.baseForegroundColor = selected ? .white : .label
        button.configuration = configuration
      }
    }

    @objc private func buttonPressed(_ sender: UIButton) {
      guard keys.indices.contains(sender.tag) else { return }
      onKey?(keys[sender.tag])
    }
  }

  extension GhostteaAccessoryKey {
    fileprivate var label: String {
      switch self {
      case .escape: "Esc"
      case .tab: "Tab"
      case .control: "Ctrl"
      case .option: "Alt"
      case .arrowLeft: "←"
      case .arrowDown: "↓"
      case .arrowUp: "↑"
      case .arrowRight: "→"
      case .home: "Home"
      case .end: "End"
      case .pageUp: "PgUp"
      case .pageDown: "PgDn"
      case .pipe: "|"
      case .tilde: "~"
      case .backquote: "`"
      }
    }

    fileprivate var accessibilityLabel: String {
      switch self {
      case .escape: "Escape"
      case .tab: "Tab"
      case .control: "Control modifier"
      case .option: "Alt modifier"
      case .arrowLeft: "Left arrow"
      case .arrowDown: "Down arrow"
      case .arrowUp: "Up arrow"
      case .arrowRight: "Right arrow"
      case .home: "Home"
      case .end: "End"
      case .pageUp: "Page up"
      case .pageDown: "Page down"
      case .pipe: "Pipe"
      case .tilde: "Tilde"
      case .backquote: "Backquote"
      }
    }

    fileprivate var minimumWidth: CGFloat {
      switch self {
      case .control, .option, .home, .pageUp, .pageDown: 52
      default: 42
      }
    }
  }
#endif
