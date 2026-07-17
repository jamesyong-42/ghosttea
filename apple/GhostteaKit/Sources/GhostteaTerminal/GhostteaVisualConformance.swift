import Foundation

public struct GhostteaVisualFingerprint: Codable, Equatable, Sendable {
  public let width: Int
  public let height: Int
  public let edgeColumns: Int
  public let edgeRows: Int
  public let horizontalEdges: Data
  public let verticalEdges: Data
  public let meanRed: UInt8
  public let meanGreen: UInt8
  public let meanBlue: UInt8
  public let meanAlpha: UInt8
  public let nonBackgroundPixelCount: Int

  init(
    pixels: [UInt8],
    width: Int,
    height: Int,
    nonBackgroundPixelCount: Int,
    edgeColumns: Int = 96,
    edgeRows: Int = 64
  ) {
    self.width = width
    self.height = height
    self.edgeColumns = edgeColumns
    self.edgeRows = edgeRows
    self.nonBackgroundPixelCount = nonBackgroundPixelCount

    var channelSums = [UInt64](repeating: 0, count: 4)
    for offset in stride(from: 0, to: pixels.count, by: 4) {
      for channel in 0..<4 {
        channelSums[channel] += UInt64(pixels[offset + channel])
      }
    }
    let pixelCount = max(1, width * height)
    meanRed = Self.roundedMean(channelSums[0], count: pixelCount)
    meanGreen = Self.roundedMean(channelSums[1], count: pixelCount)
    meanBlue = Self.roundedMean(channelSums[2], count: pixelCount)
    meanAlpha = Self.roundedMean(channelSums[3], count: pixelCount)

    let sampleColumns = edgeColumns + 1
    let sampleRows = edgeRows + 1
    var luminance = [UInt64](repeating: 0, count: sampleColumns * sampleRows)
    for sampleRow in 0..<sampleRows {
      let y0 = sampleRow * height / sampleRows
      let y1 = max(y0 + 1, (sampleRow + 1) * height / sampleRows)
      for sampleColumn in 0..<sampleColumns {
        let x0 = sampleColumn * width / sampleColumns
        let x1 = max(x0 + 1, (sampleColumn + 1) * width / sampleColumns)
        var sum: UInt64 = 0
        var count: UInt64 = 0
        for y in y0..<min(y1, height) {
          for x in x0..<min(x1, width) {
            let offset = (y * width + x) * 4
            sum +=
              54 * UInt64(pixels[offset])
              + 183 * UInt64(pixels[offset + 1])
              + 19 * UInt64(pixels[offset + 2])
            count += 1
          }
        }
        luminance[sampleRow * sampleColumns + sampleColumn] = sum / max(1, count)
      }
    }

    let edgeBytes = (edgeColumns * edgeRows + 7) / 8
    var horizontal = Data(repeating: 0, count: edgeBytes)
    var vertical = Data(repeating: 0, count: edgeBytes)
    for row in 0..<edgeRows {
      for column in 0..<edgeColumns {
        let index = row * edgeColumns + column
        let sampleIndex = row * sampleColumns + column
        let left = luminance[sampleIndex]
        let right = luminance[sampleIndex + 1]
        if left < right {
          horizontal[index / 8] |= UInt8(1 << (index % 8))
        }
        let top = luminance[sampleIndex]
        let bottom = luminance[sampleIndex + sampleColumns]
        if top < bottom {
          vertical[index / 8] |= UInt8(1 << (index % 8))
        }
      }
    }
    horizontalEdges = horizontal
    verticalEdges = vertical
  }

  private static func roundedMean(_ sum: UInt64, count: Int) -> UInt8 {
    UInt8(clamping: (sum + UInt64(count / 2)) / UInt64(count))
  }
}

public struct GhostteaVisualTolerance: Codable, Equatable, Sendable {
  public let maxEdgeHammingDistance: Int
  public let maxMeanChannelDelta: Int
  public let maxNonBackgroundPixelDelta: Int

  public init(
    maxEdgeHammingDistance: Int,
    maxMeanChannelDelta: Int,
    maxNonBackgroundPixelDelta: Int
  ) {
    self.maxEdgeHammingDistance = maxEdgeHammingDistance
    self.maxMeanChannelDelta = maxMeanChannelDelta
    self.maxNonBackgroundPixelDelta = maxNonBackgroundPixelDelta
  }
}

public struct GhostteaVisualGoldenRecord: Codable, Equatable, Sendable {
  public let schemaVersion: Int
  public let fixture: String
  public let referencePixelHash: String
  public let fingerprint: GhostteaVisualFingerprint
  public let tolerance: GhostteaVisualTolerance

  public init(
    schemaVersion: Int = 1,
    fixture: String,
    referencePixelHash: String,
    fingerprint: GhostteaVisualFingerprint,
    tolerance: GhostteaVisualTolerance
  ) {
    self.schemaVersion = schemaVersion
    self.fixture = fixture
    self.referencePixelHash = referencePixelHash
    self.fingerprint = fingerprint
    self.tolerance = tolerance
  }
}

public struct GhostteaVisualDifference: Equatable, Sendable {
  public let dimensionsMatch: Bool
  public let edgeHammingDistance: Int
  public let maxMeanChannelDelta: Int
  public let nonBackgroundPixelDelta: Int
  public let passed: Bool
}

public enum GhostteaVisualGolden {
  public static func bundled() throws -> GhostteaVisualGoldenRecord {
    guard let url = Bundle.module.url(forResource: "terminal-visual-golden", withExtension: "json")
    else {
      throw GhostteaVisualConformanceError.missingGolden
    }
    let record = try JSONDecoder().decode(
      GhostteaVisualGoldenRecord.self, from: Data(contentsOf: url))
    guard record.schemaVersion == 1 else {
      throw GhostteaVisualConformanceError.unsupportedSchema(record.schemaVersion)
    }
    return record
  }

  public static func evaluate(
    _ actual: GhostteaVisualFingerprint,
    against golden: GhostteaVisualGoldenRecord
  ) -> GhostteaVisualDifference {
    let expected = golden.fingerprint
    let dimensionsMatch =
      actual.width == expected.width && actual.height == expected.height
      && actual.edgeColumns == expected.edgeColumns && actual.edgeRows == expected.edgeRows
      && actual.horizontalEdges.count == expected.horizontalEdges.count
      && actual.verticalEdges.count == expected.verticalEdges.count
    let edgeDistance =
      dimensionsMatch
      ? zip(actual.horizontalEdges, expected.horizontalEdges).reduce(0) {
        $0 + Int(($1.0 ^ $1.1).nonzeroBitCount)
      }
        + zip(actual.verticalEdges, expected.verticalEdges).reduce(0) {
          $0 + Int(($1.0 ^ $1.1).nonzeroBitCount)
        } : Int.max
    let channelDelta =
      zip(
        [actual.meanRed, actual.meanGreen, actual.meanBlue, actual.meanAlpha],
        [expected.meanRed, expected.meanGreen, expected.meanBlue, expected.meanAlpha]
      ).map { abs(Int($0.0) - Int($0.1)) }.max() ?? 0
    let nonBackgroundDelta = abs(
      actual.nonBackgroundPixelCount - expected.nonBackgroundPixelCount)
    let tolerance = golden.tolerance
    return GhostteaVisualDifference(
      dimensionsMatch: dimensionsMatch,
      edgeHammingDistance: edgeDistance,
      maxMeanChannelDelta: channelDelta,
      nonBackgroundPixelDelta: nonBackgroundDelta,
      passed: dimensionsMatch && edgeDistance <= tolerance.maxEdgeHammingDistance
        && channelDelta <= tolerance.maxMeanChannelDelta
        && nonBackgroundDelta <= tolerance.maxNonBackgroundPixelDelta
    )
  }

  public static func evaluate(_ actual: GhostteaVisualFingerprint) throws
    -> GhostteaVisualDifference
  {
    evaluate(actual, against: try bundled())
  }
}

public enum GhostteaVisualConformanceError: Error, Equatable, Sendable {
  case missingGolden
  case unsupportedSchema(Int)
}
