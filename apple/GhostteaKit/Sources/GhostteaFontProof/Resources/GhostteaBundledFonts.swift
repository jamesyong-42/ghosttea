import Foundation

public enum GhostteaBundledFontRole: UInt32, Sendable {
  case regular = 0
  case bold = 1
  case italic = 2
  case boldItalic = 3
  case fallback = 4
}

public struct GhostteaBundledFont: Sendable {
  public let role: GhostteaBundledFontRole
  public let data: Data
  public let faceIndex: UInt32

  public init(role: GhostteaBundledFontRole, data: Data, faceIndex: UInt32 = 0) {
    self.role = role
    self.data = data
    self.faceIndex = faceIndex
  }
}

public enum GhostteaBundledFonts {
  private static let resources: [(String, GhostteaBundledFontRole)] = [
    ("JetBrainsMonoNerdFont-Regular", .regular),
    ("JetBrainsMonoNerdFont-Bold", .bold),
    ("JetBrainsMonoNerdFont-Italic", .italic),
    ("JetBrainsMonoNerdFont-BoldItalic", .boldItalic),
    ("NotoColorEmoji", .fallback),
  ]

  public static func load() throws -> [GhostteaBundledFont] {
    try resources.map { name, role in
      guard
        let url = Bundle.module.url(
          forResource: name, withExtension: "ttf", subdirectory: "Fonts")
          ?? Bundle.module.url(forResource: name, withExtension: "ttf")
      else {
        throw CocoaError(.fileNoSuchFile, userInfo: [NSFilePathErrorKey: "Fonts/\(name).ttf"])
      }
      return GhostteaBundledFont(
        role: role,
        data: try Data(contentsOf: url, options: .mappedIfSafe)
      )
    }
  }

  public static func parityGolden() throws -> Data {
    guard let url = Bundle.module.url(forResource: "font-parity", withExtension: "json") else {
      throw CocoaError(.fileNoSuchFile, userInfo: [NSFilePathErrorKey: "font-parity.json"])
    }
    return try Data(contentsOf: url)
  }
}
