import GhostteaTerminal
import SwiftUI

struct GhostteaSharedTerminalSurface: UIViewRepresentable {
  let frame: Data
  let visible: Bool
  var accessibilityTitle = "Shared terminal"
  var accessibilityConnectionState = "Connected through Truffle"
  let onGridSize: (GhostteaTerminalGridSize) -> Void
  let onHardwareInput: (GhostteaHardwareKeyEvent) -> Bool
  let onSoftwareInput: (GhostteaSoftwareInputEvent) -> Void
  let onMouseInput: (GhostteaTerminalMouseEvent) -> Void
  let onScrollRows: (Int) -> Void
  let onSelectionCommit: (GhostteaTerminalSelection) -> Void
  let onSelectAll: () -> Void

  final class Coordinator {
    var appliedFrame: Data?
  }

  func makeCoordinator() -> Coordinator { Coordinator() }

  func makeUIView(context: Context) -> GhostteaTerminalMetalView {
    do {
      let view = try GhostteaTerminalMetalView(terminalFrame: .zero)
      configure(view)
      return view
    } catch {
      preconditionFailure("Metal terminal unavailable: \(error)")
    }
  }

  func updateUIView(_ view: GhostteaTerminalMetalView, context: Context) {
    configure(view)
    view.setTerminalVisible(visible)
    guard context.coordinator.appliedFrame != frame else { return }
    do {
      try view.apply(frame: frame)
      context.coordinator.appliedFrame = frame
    } catch {
      assertionFailure("Metal terminal rejected shared frame: \(error)")
    }
  }

  static func dismantleUIView(
    _ view: GhostteaTerminalMetalView, coordinator: Coordinator
  ) {
    view.suspendGPU()
  }

  private func configure(_ view: GhostteaTerminalMetalView) {
    view.onGridSizeChange = onGridSize
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
