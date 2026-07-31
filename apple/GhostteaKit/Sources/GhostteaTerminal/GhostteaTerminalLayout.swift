import Foundation

public struct GhostteaTerminalContentInsets: Equatable, Sendable {
  public var top: Float
  public var left: Float
  public var bottom: Float
  public var right: Float

  public init(top: Float = 0, left: Float = 0, bottom: Float = 0, right: Float = 0) {
    self.top = top
    self.left = left
    self.bottom = bottom
    self.right = right
  }

  public static let zero = Self()
}

public struct GhostteaTerminalGridSize: Equatable, Sendable {
  public let columns: UInt16
  public let rows: UInt16

  public init(columns: UInt16, rows: UInt16) {
    self.columns = columns
    self.rows = rows
  }
}

public enum GhostteaTerminalLayout {
  public static let cellWidth: Float = 7.83
  public static let lineHeight: Float = 19
  public static let horizontalPadding: Float = 2
  public static let verticalPadding: Float = 2

  public static func gridSize(
    width: Float,
    height: Float,
    contentInsets: GhostteaTerminalContentInsets = .zero,
    cellWidth: Float = GhostteaTerminalLayout.cellWidth,
    lineHeight: Float = GhostteaTerminalLayout.lineHeight
  ) -> GhostteaTerminalGridSize {
    let usableWidth = width - contentInsets.left - contentInsets.right - horizontalPadding * 2
    let usableHeight = height - contentInsets.top - contentInsets.bottom - verticalPadding * 2
    return GhostteaTerminalGridSize(
      columns: terminalDimension(usableWidth, step: cellWidth),
      rows: terminalDimension(usableHeight, step: lineHeight)
    )
  }

  private static func terminalDimension(_ available: Float, step: Float) -> UInt16 {
    guard available.isFinite, available > 0, step.isFinite, step > 0 else { return 1 }
    let cells = floor(Double(available) / Double(step) + 0.000_001)
    return UInt16(Int(max(1, min(Double(UInt16.max), cells))))
  }
}
