import Foundation
import GhostteaFrame
import Metal

enum GhostteaMetalError: Error, Equatable, CustomStringConvertible {
  case unavailable
  case commandQueueUnavailable
  case textureUnavailable(String)
  case invalidAtlasSize(String, Int)
  case invalidGlyphDimensions(UInt32)
  case invalidGlyphPixels(UInt32, Int, Int)
  case atlasExhausted(String)

  var description: String {
    switch self {
    case .unavailable:
      "Metal is unavailable"
    case .commandQueueUnavailable:
      "Metal command queue is unavailable"
    case .textureUnavailable(let label):
      "Metal texture is unavailable: \(label)"
    case .invalidAtlasSize(let label, let size):
      "\(label) has invalid size \(size)"
    case .invalidGlyphDimensions(let id):
      "glyph \(id) has invalid atlas dimensions"
    case .invalidGlyphPixels(let id, let expected, let actual):
      "glyph \(id) requires \(expected) pixel bytes but contains \(actual)"
    case .atlasExhausted(let label):
      "\(label) cannot fit the glyphs visible in one frame"
    }
  }
}

struct GhostteaAtlasLocation: Equatable, Sendable {
  let x: Int
  let y: Int
  let width: Int
  let height: Int
  let atlasSize: Int

  var u0: Float { Float(x) / Float(atlasSize) }
  var v0: Float { Float(y) / Float(atlasSize) }
  var u1: Float { Float(x + width) / Float(atlasSize) }
  var v1: Float { Float(y + height) / Float(atlasSize) }
}

private struct GhostteaAtlasShelf: Sendable {
  let size: Int
  private(set) var x = 1
  private(set) var y = 1
  private(set) var rowHeight = 0
  private(set) var locations: [UInt32: GhostteaAtlasLocation] = [:]

  mutating func reset() {
    x = 1
    y = 1
    rowHeight = 0
    locations = [:]
  }

  func location(for id: UInt32) -> GhostteaAtlasLocation? {
    locations[id]
  }

  mutating func allocate(id: UInt32, width: Int, height: Int) -> GhostteaAtlasLocation? {
    if let existing = locations[id] { return existing }
    guard width > 0, height > 0, width + 2 <= size, height + 2 <= size else { return nil }
    if x + width + 1 > size {
      x = 1
      y += rowHeight + 1
      rowHeight = 0
    }
    guard y + height + 1 <= size else { return nil }
    let location = GhostteaAtlasLocation(x: x, y: y, width: width, height: height, atlasSize: size)
    locations[id] = location
    x += width + 1
    rowHeight = max(rowHeight, height)
    return location
  }

  func canAllocate(_ definitions: [TRF1GlyphDefinition]) -> Bool {
    var simulated = self
    return definitions.allSatisfy {
      simulated.allocate(id: $0.id, width: Int($0.width), height: Int($0.height)) != nil
    }
  }
}

final class GhostteaMetalRuntime {
  let device: any MTLDevice
  let commandQueue: any MTLCommandQueue

  init() throws {
    guard let device = MTLCreateSystemDefaultDevice() else { throw GhostteaMetalError.unavailable }
    guard let commandQueue = device.makeCommandQueue() else {
      throw GhostteaMetalError.commandQueueUnavailable
    }
    self.device = device
    self.commandQueue = commandQueue
    commandQueue.label = "Ghosttea terminal command queue"
  }

  func submitResourceBarrier() throws {
    guard let commandBuffer = commandQueue.makeCommandBuffer() else {
      throw GhostteaMetalError.commandQueueUnavailable
    }
    commandBuffer.label = "Ghosttea atlas upload barrier"
    commandBuffer.commit()
    commandBuffer.waitUntilCompleted()
  }
}

final class GhostteaMetalGlyphAtlas {
  let texture: any MTLTexture
  let format: TRF1GlyphFormat
  let label: String
  let size: Int
  let bytesPerPixel: Int
  private var shelf: GhostteaAtlasShelf
  private(set) var uploadedBytes = 0
  private(set) var resetCount = 0

  init(runtime: GhostteaMetalRuntime, format: TRF1GlyphFormat, size: Int, label: String) throws {
    guard size >= 3 else { throw GhostteaMetalError.invalidAtlasSize(label, size) }
    self.format = format
    self.size = size
    self.label = label
    bytesPerPixel = format == .alpha8 ? 1 : 4
    shelf = GhostteaAtlasShelf(size: size)
    let descriptor = MTLTextureDescriptor.texture2DDescriptor(
      pixelFormat: format == .alpha8 ? .r8Unorm : .rgba8Unorm,
      width: size,
      height: size,
      mipmapped: false
    )
    descriptor.storageMode = .shared
    descriptor.usage = [.shaderRead]
    guard let texture = runtime.device.makeTexture(descriptor: descriptor) else {
      throw GhostteaMetalError.textureUnavailable(label)
    }
    self.texture = texture
    texture.label = label
  }

  var residentBytes: Int { size * size * bytesPerPixel }
  var glyphCount: Int { shelf.locations.count }

  func location(for id: UInt32) -> GhostteaAtlasLocation? {
    shelf.location(for: id)
  }

  func needsReset(for definitions: [TRF1GlyphDefinition]) throws -> Bool {
    let definitions = try normalized(definitions)
    let missing = definitions.filter { shelf.location(for: $0.id) == nil }
    if shelf.canAllocate(missing) { return false }
    let empty = GhostteaAtlasShelf(size: size)
    guard empty.canAllocate(definitions) else { throw GhostteaMetalError.atlasExhausted(label) }
    return true
  }

  func reset() {
    shelf.reset()
    resetCount += 1
  }

  @discardableResult
  func upload(_ definition: TRF1GlyphDefinition) throws -> GhostteaAtlasLocation {
    guard definition.format == format else { throw GhostteaMetalError.atlasExhausted(label) }
    if let cached = shelf.location(for: definition.id) { return cached }
    try validate(definition)
    guard
      let location = shelf.allocate(
        id: definition.id,
        width: Int(definition.width),
        height: Int(definition.height)
      )
    else {
      throw GhostteaMetalError.atlasExhausted(label)
    }
    definition.pixels.withUnsafeBytes { bytes in
      texture.replace(
        region: MTLRegionMake2D(location.x, location.y, location.width, location.height),
        mipmapLevel: 0,
        withBytes: bytes.baseAddress!,
        bytesPerRow: location.width * bytesPerPixel
      )
    }
    uploadedBytes += definition.pixels.count
    return location
  }

  private func normalized(_ definitions: [TRF1GlyphDefinition]) throws -> [TRF1GlyphDefinition] {
    var byID: [UInt32: TRF1GlyphDefinition] = [:]
    for definition in definitions where definition.format == format {
      try validate(definition)
      byID[definition.id] = definition
    }
    return byID.values.sorted { $0.id < $1.id }
  }

  private func validate(_ definition: TRF1GlyphDefinition) throws {
    guard definition.width > 0, definition.height > 0 else {
      throw GhostteaMetalError.invalidGlyphDimensions(definition.id)
    }
    let expected = Int(definition.width) * Int(definition.height) * bytesPerPixel
    guard definition.pixels.count == expected else {
      throw GhostteaMetalError.invalidGlyphPixels(definition.id, expected, definition.pixels.count)
    }
  }
}

struct GhostteaMetalUploadResult: Equatable, Sendable {
  let uploadedBytes: Int
  let alphaGlyphCount: Int
  let colorGlyphCount: Int
  let alphaReset: Bool
  let colorReset: Bool
}

final class GhostteaMetalAtlasSet {
  let runtime: GhostteaMetalRuntime
  let alpha: GhostteaMetalGlyphAtlas
  let color: GhostteaMetalGlyphAtlas

  init(runtime: GhostteaMetalRuntime, alphaSize: Int = 2048, colorSize: Int = 2048) throws {
    self.runtime = runtime
    alpha = try GhostteaMetalGlyphAtlas(
      runtime: runtime,
      format: .alpha8,
      size: alphaSize,
      label: "Ghosttea alpha glyph atlas"
    )
    color = try GhostteaMetalGlyphAtlas(
      runtime: runtime,
      format: .rgba8Premultiplied,
      size: colorSize,
      label: "Ghosttea color glyph atlas"
    )
  }

  var residentBytes: Int { alpha.residentBytes + color.residentBytes }

  func synchronize(visible definitions: [TRF1GlyphDefinition]) throws -> GhostteaMetalUploadResult {
    let alphaDefinitions = definitions.filter { $0.format == .alpha8 }
    let colorDefinitions = definitions.filter { $0.format == .rgba8Premultiplied }
    let alphaReset = try alpha.needsReset(for: alphaDefinitions)
    let colorReset = try color.needsReset(for: colorDefinitions)
    if alphaReset { alpha.reset() }
    if colorReset { color.reset() }
    let before = alpha.uploadedBytes + color.uploadedBytes
    for definition in alphaDefinitions.sorted(by: { $0.id < $1.id }) {
      try alpha.upload(definition)
    }
    for definition in colorDefinitions.sorted(by: { $0.id < $1.id }) {
      try color.upload(definition)
    }
    try runtime.submitResourceBarrier()
    return GhostteaMetalUploadResult(
      uploadedBytes: alpha.uploadedBytes + color.uploadedBytes - before,
      alphaGlyphCount: alpha.glyphCount,
      colorGlyphCount: color.glyphCount,
      alphaReset: alphaReset,
      colorReset: colorReset
    )
  }
}

public struct GhostteaMetalProofResult: Equatable, Sendable {
  public let deviceName: String
  public let uploadedBytes: Int
  public let cachedUploadBytes: Int
  public let alphaGlyphCount: Int
  public let colorGlyphCount: Int
  public let residentAtlasBytes: Int
}

public enum GhostteaMetalProof {
  public static func run(frame data: Data) throws -> GhostteaMetalProofResult {
    let frame = try decodeTRF1Frame(data)
    let definitions = try frame.sections
      .filter { $0.kind == .glyphDefinitions }
      .flatMap(decodeTRF1GlyphDefinitions)
    let runtime = try GhostteaMetalRuntime()
    let atlases = try GhostteaMetalAtlasSet(runtime: runtime)
    let first = try atlases.synchronize(visible: definitions)
    let cached = try atlases.synchronize(visible: definitions)
    return GhostteaMetalProofResult(
      deviceName: runtime.device.name,
      uploadedBytes: first.uploadedBytes,
      cachedUploadBytes: cached.uploadedBytes,
      alphaGlyphCount: first.alphaGlyphCount,
      colorGlyphCount: first.colorGlyphCount,
      residentAtlasBytes: atlases.residentBytes
    )
  }
}
