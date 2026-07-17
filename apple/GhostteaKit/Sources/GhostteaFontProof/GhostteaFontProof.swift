import Foundation
import GhostteaFontFixtureNative
import GhostteaFonts

public enum GhostteaFontProofError: Error, CustomStringConvertible {
  case missingResource(String)
  case nativeFailure(Int32)
  case emptyNativeOutput
  case invalidJSON

  public var description: String {
    switch self {
    case .missingResource(let name): "Missing bundled font proof resource: \(name)"
    case .nativeFailure(let status): "Native font fixture failed with status \(status)"
    case .emptyNativeOutput: "Native font fixture returned an empty buffer"
    case .invalidJSON: "Font fixture output or golden file is not valid JSON"
    }
  }
}

public struct GhostteaFontProofResult: Sendable {
  public let passed: Bool
  public let actualJSON: String

  public init(passed: Bool, actualJSON: String) {
    self.passed = passed
    self.actualJSON = actualJSON
  }
}

public enum GhostteaFontProof {
  public static func run() throws -> GhostteaFontProofResult {
    let fontData = try GhostteaBundledFonts.load().map(\.data)
    let golden = try GhostteaBundledFonts.parityGolden()
    let actual = try generate(fontData)
    let passed = try jsonObject(actual).isEqual(jsonObject(golden))
    guard let actualJSON = String(data: actual, encoding: .utf8) else {
      throw GhostteaFontProofError.invalidJSON
    }
    return GhostteaFontProofResult(passed: passed, actualJSON: actualJSON)
  }

  private static func generate(_ fonts: [Data]) throws -> Data {
    precondition(fonts.count == 5)
    return try withFontBytes(fonts[0]) { regular in
      try withFontBytes(fonts[1]) { bold in
        try withFontBytes(fonts[2]) { italic in
          try withFontBytes(fonts[3]) { boldItalic in
            try withFontBytes(fonts[4]) { emoji in
              var output = ghosttea_owned_bytes_t(data: nil, len: 0, capacity: 0)
              let status = ghosttea_font_fixture_generate(
                regular, bold, italic, boldItalic, emoji, &output)
              guard status == GHOSTTEA_FONT_FIXTURE_OK else {
                throw GhostteaFontProofError.nativeFailure(status)
              }
              defer { ghosttea_font_fixture_free(output) }
              guard let pointer = output.data, output.len > 0 else {
                throw GhostteaFontProofError.emptyNativeOutput
              }
              return Data(bytes: pointer, count: output.len)
            }
          }
        }
      }
    }
  }

  private static func withFontBytes<T>(
    _ data: Data,
    body: (ghosttea_font_bytes_t) throws -> T
  ) rethrows -> T {
    try data.withUnsafeBytes { rawBuffer in
      let bytes = rawBuffer.bindMemory(to: UInt8.self)
      return try body(ghosttea_font_bytes_t(data: bytes.baseAddress, len: bytes.count))
    }
  }

  private static func jsonObject(_ data: Data) throws -> NSObject {
    guard let object = try JSONSerialization.jsonObject(with: data) as? NSObject else {
      throw GhostteaFontProofError.invalidJSON
    }
    return object
  }
}
