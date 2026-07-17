import Foundation
import GhostteaFrame

@MainActor
final class GhostteaCursorBlinkController {
  static let interval = Duration.milliseconds(600)

  private(set) var blinkVisible = true
  private(set) var timerScheduled = false

  private var cursor: TRF1CursorState?
  private var focused = true
  private var surfaceVisible = true
  private var timer: Task<Void, Never>?
  private let onVisibilityChange: (Bool) -> Void

  init(onVisibilityChange: @escaping (Bool) -> Void) {
    self.onVisibilityChange = onVisibilityChange
  }

  deinit {
    timer?.cancel()
  }

  func updateCursor(_ cursor: TRF1CursorState?) {
    let changed = self.cursor != cursor
    self.cursor = cursor
    guard changed else { return }
    reschedule(resetVisible: true)
  }

  func setFocused(_ focused: Bool) {
    guard self.focused != focused else { return }
    self.focused = focused
    reschedule(resetVisible: focused)
  }

  func setSurfaceVisible(_ visible: Bool) {
    guard surfaceVisible != visible else { return }
    surfaceVisible = visible
    reschedule(resetVisible: visible)
  }

  func noteCursorActivity() {
    reschedule(resetVisible: true)
  }

  func handleTimerFired() {
    cancelTimer()
    guard shouldBlink else { return }
    setBlinkVisible(!blinkVisible)
    scheduleTimer()
  }

  private var shouldBlink: Bool {
    surfaceVisible && focused && cursor?.visible == true && cursor?.blinking == true
  }

  private func reschedule(resetVisible: Bool) {
    cancelTimer()
    if resetVisible {
      setBlinkVisible(true)
    }
    if shouldBlink {
      scheduleTimer()
    }
  }

  private func scheduleTimer() {
    timerScheduled = true
    timer = Task { [weak self] in
      do {
        try await Task.sleep(for: Self.interval)
      } catch {
        return
      }
      self?.handleTimerFired()
    }
  }

  private func cancelTimer() {
    timer?.cancel()
    timer = nil
    timerScheduled = false
  }

  private func setBlinkVisible(_ visible: Bool) {
    guard blinkVisible != visible else { return }
    blinkVisible = visible
    onVisibilityChange(visible)
  }
}
