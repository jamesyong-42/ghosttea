import Foundation
import GhostteaCore

public enum GhostteaMouseAction: UInt8, Equatable, Sendable {
  case press = 0
  case release = 1
  case motion = 2
}

public enum GhostteaMouseButton: UInt8, Equatable, Sendable {
  case none = 0
  case left = 1
  case right = 2
  case middle = 3
  case scrollUp = 4
  case scrollDown = 5
}

public enum GhostteaPointerOwner: Equatable, Sendable {
  case localSelection
  case remoteApplication

  public static func resolve(
    mouseTracking: Bool,
    forceLocalSelection: Bool
  ) -> Self {
    mouseTracking && !forceLocalSelection ? .remoteApplication : .localSelection
  }
}

public struct GhostteaTerminalMouseEvent: Equatable, Sendable {
  public let action: GhostteaMouseAction
  public let button: GhostteaMouseButton
  public let modifiers: GhostteaInputModifiers
  public let x: Float
  public let y: Float
  public let screenWidth: UInt32
  public let screenHeight: UInt32
  public let cellWidth: UInt32
  public let cellHeight: UInt32
  public let paddingLeft: UInt32
  public let paddingTop: UInt32

  public init(
    action: GhostteaMouseAction,
    button: GhostteaMouseButton,
    modifiers: GhostteaInputModifiers = [],
    x: Float,
    y: Float,
    screenWidth: UInt32,
    screenHeight: UInt32,
    cellWidth: UInt32,
    cellHeight: UInt32,
    paddingLeft: UInt32 = 0,
    paddingTop: UInt32 = 0
  ) {
    self.action = action
    self.button = button
    self.modifiers = modifiers
    self.x = x
    self.y = y
    self.screenWidth = max(1, screenWidth)
    self.screenHeight = max(1, screenHeight)
    self.cellWidth = max(1, cellWidth)
    self.cellHeight = max(1, cellHeight)
    self.paddingLeft = paddingLeft
    self.paddingTop = paddingTop
  }

  var coreEvent: GhostteaMouseEvent {
    GhostteaMouseEvent(
      action: action.rawValue,
      button: button.rawValue,
      modifiers: modifiers.rawValue,
      x: x,
      y: y,
      screenWidth: screenWidth,
      screenHeight: screenHeight,
      cellWidth: cellWidth,
      cellHeight: cellHeight,
      paddingLeft: paddingLeft,
      paddingTop: paddingTop
    )
  }
}

public struct GhostteaViewportCellPoint: Equatable, Sendable {
  public let column: UInt16
  public let row: UInt16

  public init(column: UInt16, row: UInt16) {
    self.column = column
    self.row = row
  }
}

public struct GhostteaTerminalCellPoint: Equatable, Sendable {
  public let column: UInt16
  public let row: UInt32

  public init(column: UInt16, row: UInt32) {
    self.column = column
    self.row = row
  }
}

public struct GhostteaTerminalSelection: Equatable, Sendable {
  public let anchor: GhostteaTerminalCellPoint
  public let focus: GhostteaTerminalCellPoint

  public init(anchor: GhostteaTerminalCellPoint, focus: GhostteaTerminalCellPoint) {
    self.anchor = anchor
    self.focus = focus
  }

  public func viewportSelection(
    offset: UInt64,
    columns: UInt16,
    rows: UInt16
  ) -> (anchor: GhostteaViewportCellPoint, focus: GhostteaViewportCellPoint)? {
    guard columns > 0, rows > 0 else { return nil }
    let forward =
      anchor.row < focus.row || (anchor.row == focus.row && anchor.column <= focus.column)
    let start = forward ? anchor : focus
    let end = forward ? focus : anchor
    let viewportEnd = offset + UInt64(rows) - 1
    guard UInt64(end.row) >= offset, UInt64(start.row) <= viewportEnd else { return nil }
    let startBeforeViewport = UInt64(start.row) < offset
    let endAfterViewport = UInt64(end.row) > viewportEnd
    return (
      anchor: GhostteaViewportCellPoint(
        column: startBeforeViewport ? 0 : start.column,
        row: startBeforeViewport ? 0 : UInt16(UInt64(start.row) - offset)
      ),
      focus: GhostteaViewportCellPoint(
        column: endAfterViewport ? columns - 1 : end.column,
        row: endAfterViewport ? rows - 1 : UInt16(UInt64(end.row) - offset)
      )
    )
  }
}

struct GhostteaWheelAccumulator: Equatable, Sendable {
  private(set) var remainder: Double = 0

  mutating func consume(deltaPoints: Double, lineHeight: Double) -> Int {
    guard deltaPoints.isFinite, lineHeight.isFinite, lineHeight > 0 else { return 0 }
    let pixels = remainder + deltaPoints * 2
    let rows = Int(pixels / lineHeight)
    remainder = pixels - Double(rows) * lineHeight
    return rows
  }

  mutating func reset() {
    remainder = 0
  }
}

extension GhostteaTerminalInputEncoder {
  public func encode(_ event: GhostteaTerminalMouseEvent) async throws -> GhostteaInputEncoding {
    .bytes(try await terminal.encodeMouse(event.coreEvent))
  }
}
