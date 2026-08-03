import GhostteaCore
import GhostteaTerminal
import SwiftUI

struct GhostteaSharedTerminalSurface: UIViewRepresentable {
  let frame: Data
  let visible: Bool
  let configuration: GhostteaTerminalPresentationConfig
  var controlsGridSize = true
  var accessibilityTitle = "Shared terminal"
  var accessibilityConnectionState = "Connected through Truffle"
  let onGridSize: (GhostteaTerminalGridSize) -> Void
  let onNeedsFullRefresh: () -> Void
  let onHardwareInput: (GhostteaHardwareKeyEvent) -> Bool
  let onSoftwareInput: (GhostteaSoftwareInputEvent) -> Void
  let onMouseInput: (GhostteaTerminalMouseEvent) -> Void
  let onScrollRows: (Int) -> Void
  let onSelectionCommit: (GhostteaTerminalSelection) -> Void
  let onSelectAll: () -> Void

  final class Coordinator {
    var appliedFrame: Data?
    var appliedConfigurationRevision: String?
  }

  func makeCoordinator() -> Coordinator { Coordinator() }

  func makeUIView(context: Context) -> GhostteaTerminalMetalView {
    do {
      let view = try GhostteaTerminalMetalView(terminalFrame: .zero)
      configure(view)
      view.applyConfiguration(configuration)
      context.coordinator.appliedConfigurationRevision = configuration.revision
      return view
    } catch {
      preconditionFailure("Metal terminal unavailable")
    }
  }

  func updateUIView(_ view: GhostteaTerminalMetalView, context: Context) {
    configure(view)
    view.setTerminalVisible(visible)
    if context.coordinator.appliedConfigurationRevision != configuration.revision {
      view.applyConfiguration(configuration)
      context.coordinator.appliedConfigurationRevision = configuration.revision
    }
    guard context.coordinator.appliedFrame != frame else { return }
    do {
      try view.apply(frame: frame)
      context.coordinator.appliedFrame = frame
    } catch {
      assertionFailure("Metal terminal rejected shared frame")
    }
  }

  static func dismantleUIView(
    _ view: GhostteaTerminalMetalView, coordinator: Coordinator
  ) {
    view.suspendGPU()
  }

  private func configure(_ view: GhostteaTerminalMetalView) {
    view.onGridSizeChange = controlsGridSize ? onGridSize : nil
    view.onNeedsFullRefresh = onNeedsFullRefresh
    view.onHardwareKeyEvent = onHardwareInput
    view.onSoftwareInputEvent = onSoftwareInput
    view.onMouseInputEvent = onMouseInput
    view.onScrollRows = onScrollRows
    view.onSelectionCommit = onSelectionCommit
    view.onSelectAll = onSelectAll
    view.accessibilityTerminalTitle = accessibilityTitle
    view.accessibilityConnectionState = accessibilityConnectionState
  }
}

extension GhostteaTerminalPresentationConfig {
  var terminalBackgroundColor: Color {
    color(background, fallback: [0x28, 0x2c, 0x34]).opacity(Double(backgroundOpacity))
  }

  var terminalForegroundColor: Color {
    color(foreground, fallback: [0xff, 0xff, 0xff])
  }

  private func color(_ components: [UInt8], fallback: [UInt8]) -> Color {
    let resolved = components.count == 3 ? components : fallback
    return Color(
      red: Double(resolved[0]) / 255,
      green: Double(resolved[1]) / 255,
      blue: Double(resolved[2]) / 255
    )
  }
}
