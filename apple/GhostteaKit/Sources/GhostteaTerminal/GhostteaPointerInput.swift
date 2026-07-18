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

extension GhostteaTerminalInputEncoder {
  public func encode(_ event: GhostteaTerminalMouseEvent) async throws -> GhostteaInputEncoding {
    .bytes(try await terminal.encodeMouse(event.coreEvent))
  }
}
