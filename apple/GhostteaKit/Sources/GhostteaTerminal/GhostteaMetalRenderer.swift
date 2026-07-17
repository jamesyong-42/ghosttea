import Foundation
import GhostteaFrame
import Metal

private let ghostteaMetalShaderSource = """
  #include <metal_stdlib>
  using namespace metal;

  struct RectangleInput {
    float2 position [[attribute(0)]];
    float4 color [[attribute(1)]];
  };

  struct RectangleOutput {
    float4 position [[position]];
    float4 color;
  };

  vertex RectangleOutput ghosttea_rectangle_vertex(RectangleInput input [[stage_in]]) {
    return { float4(input.position, 0.0, 1.0), input.color };
  }

  fragment float4 ghosttea_rectangle_fragment(RectangleOutput input [[stage_in]]) {
    return float4(input.color.rgb * input.color.a, input.color.a);
  }

  struct GlyphInput {
    float2 position [[attribute(0)]];
    float2 uv [[attribute(1)]];
    float4 color [[attribute(2)]];
  };

  struct GlyphOutput {
    float4 position [[position]];
    float2 uv;
    float4 color;
  };

  vertex GlyphOutput ghosttea_glyph_vertex(GlyphInput input [[stage_in]]) {
    return { float4(input.position, 0.0, 1.0), input.uv, input.color };
  }

  fragment float4 ghosttea_alpha_glyph_fragment(
    GlyphOutput input [[stage_in]],
    texture2d<float> atlas [[texture(0)]],
    sampler atlas_sampler [[sampler(0)]]) {
    const float coverage = atlas.sample(atlas_sampler, input.uv).r;
    const float alpha = input.color.a * coverage;
    return float4(input.color.rgb * alpha, alpha);
  }

  fragment float4 ghosttea_color_glyph_fragment(
    GlyphOutput input [[stage_in]],
    texture2d<float> atlas [[texture(0)]],
    sampler atlas_sampler [[sampler(0)]]) {
    return atlas.sample(atlas_sampler, input.uv);
  }
  """

struct GhostteaMetalColor: Equatable, Sendable {
  let red: Float
  let green: Float
  let blue: Float
  let alpha: Float

  static let clear = Self(red: 0, green: 0, blue: 0, alpha: 0)

  var components: [Float] { [red, green, blue, alpha] }
}

struct GhostteaMetalTheme: Equatable, Sendable {
  var background = GhostteaMetalColor(red: 40 / 255, green: 44 / 255, blue: 52 / 255, alpha: 1)
  var foreground = GhostteaMetalColor(red: 1, green: 1, blue: 1, alpha: 1)
  var cursor = GhostteaMetalColor(red: 1, green: 1, blue: 1, alpha: 1)
  var selection = GhostteaMetalColor(red: 1, green: 1, blue: 1, alpha: 1)
  var selectionForeground = GhostteaMetalColor(
    red: 40 / 255, green: 44 / 255, blue: 52 / 255, alpha: 1)
}

struct GhostteaMetalCellPoint: Equatable, Sendable {
  let column: UInt16
  let row: UInt16
}

struct GhostteaMetalSelection: Equatable, Sendable {
  let anchor: GhostteaMetalCellPoint
  let focus: GhostteaMetalCellPoint
}

struct GhostteaMetalRenderResult: Equatable, Sendable {
  let width: Int
  let height: Int
  let rectangleVertexCount: Int
  let alphaGlyphVertexCount: Int
  let colorGlyphVertexCount: Int
  let nonBackgroundPixelCount: Int
  let pixelHash: UInt64
  let atlasUpload: GhostteaMetalUploadResult
  let residentBytes: Int
}

struct GhostteaMetalDrawResult: Equatable, Sendable {
  let rectangleVertexCount: Int
  let alphaGlyphVertexCount: Int
  let colorGlyphVertexCount: Int
  let atlasUpload: GhostteaMetalUploadResult
}

private struct GhostteaResolvedMetalStyle {
  let foreground: GhostteaMetalColor
  let background: GhostteaMetalColor?
  let underline: Bool
  let strikethrough: Bool
  let invisible: Bool
}

private struct GhostteaMetalMesh {
  var backgrounds: [Float] = []
  var selection: [Float] = []
  var alphaGlyphs: [Float] = []
  var colorGlyphs: [Float] = []
  var decorations: [Float] = []
  var cursor: [Float] = []
}

final class GhostteaMetalRenderer {
  static let cellWidth = GhostteaTerminalLayout.cellWidth
  static let lineHeight = GhostteaTerminalLayout.lineHeight
  static let originX = GhostteaTerminalLayout.horizontalPadding
  static let originY = GhostteaTerminalLayout.verticalPadding

  let runtime: GhostteaMetalRuntime
  let atlases: GhostteaMetalAtlasSet
  private let rectanglePipeline: any MTLRenderPipelineState
  private let alphaGlyphPipeline: any MTLRenderPipelineState
  private let colorGlyphPipeline: any MTLRenderPipelineState
  private let sampler: any MTLSamplerState

  init(runtime: GhostteaMetalRuntime, alphaAtlasSize: Int = 2048, colorAtlasSize: Int = 2048) throws
  {
    self.runtime = runtime
    atlases = try GhostteaMetalAtlasSet(
      runtime: runtime,
      alphaSize: alphaAtlasSize,
      colorSize: colorAtlasSize
    )
    let library: any MTLLibrary
    do {
      library = try runtime.device.makeLibrary(source: ghostteaMetalShaderSource, options: nil)
    } catch {
      throw GhostteaMetalError.shaderUnavailable(String(describing: error))
    }
    rectanglePipeline = try Self.makeRectanglePipeline(runtime: runtime, library: library)
    alphaGlyphPipeline = try Self.makeGlyphPipeline(
      runtime: runtime,
      library: library,
      fragment: "ghosttea_alpha_glyph_fragment",
      label: "Ghosttea alpha glyph pipeline"
    )
    colorGlyphPipeline = try Self.makeGlyphPipeline(
      runtime: runtime,
      library: library,
      fragment: "ghosttea_color_glyph_fragment",
      label: "Ghosttea color glyph pipeline"
    )
    let samplerDescriptor = MTLSamplerDescriptor()
    samplerDescriptor.minFilter = .linear
    samplerDescriptor.magFilter = .linear
    samplerDescriptor.sAddressMode = .clampToEdge
    samplerDescriptor.tAddressMode = .clampToEdge
    guard let sampler = runtime.device.makeSamplerState(descriptor: samplerDescriptor) else {
      throw GhostteaMetalError.shaderUnavailable("glyph atlas sampler")
    }
    self.sampler = sampler
  }

  func render(
    state: RetainedTRF1State,
    width: Int,
    height: Int,
    scale: Float = 1,
    theme: GhostteaMetalTheme = GhostteaMetalTheme(),
    contentInsets: GhostteaTerminalContentInsets = .zero,
    selection: GhostteaMetalSelection? = nil,
    focused: Bool = true,
    cursorBlinkVisible: Bool = true
  ) throws -> GhostteaMetalRenderResult {
    let textureDescriptor = MTLTextureDescriptor.texture2DDescriptor(
      pixelFormat: .rgba8Unorm,
      width: width,
      height: height,
      mipmapped: false
    )
    textureDescriptor.storageMode = .shared
    textureDescriptor.usage = [.renderTarget]
    guard let target = runtime.device.makeTexture(descriptor: textureDescriptor) else {
      throw GhostteaMetalError.renderTargetUnavailable
    }
    target.label = "Ghosttea offscreen terminal target"
    let draw = try render(
      state: state,
      target: target,
      scale: scale,
      theme: theme,
      contentInsets: contentInsets,
      selection: selection,
      focused: focused,
      cursorBlinkVisible: cursorBlinkVisible
    )
    let pixels = readPixels(texture: target, width: width, height: height)
    return GhostteaMetalRenderResult(
      width: width,
      height: height,
      rectangleVertexCount: draw.rectangleVertexCount,
      alphaGlyphVertexCount: draw.alphaGlyphVertexCount,
      colorGlyphVertexCount: draw.colorGlyphVertexCount,
      nonBackgroundPixelCount: countNonBackgroundPixels(pixels, background: theme.background),
      pixelHash: fnv1a64(pixels),
      atlasUpload: draw.atlasUpload,
      residentBytes: atlases.residentBytes + pixels.count
    )
  }

  func render(
    state: RetainedTRF1State,
    target: any MTLTexture,
    scale: Float = 1,
    theme: GhostteaMetalTheme = GhostteaMetalTheme(),
    contentInsets: GhostteaTerminalContentInsets = .zero,
    selection: GhostteaMetalSelection? = nil,
    focused: Bool = true,
    cursorBlinkVisible: Bool = true,
    presenting drawable: (any MTLDrawable)? = nil
  ) throws -> GhostteaMetalDrawResult {
    let width = target.width
    let height = target.height
    guard width > 0, height > 0, target.pixelFormat == .rgba8Unorm, scale.isFinite, scale > 0 else {
      throw GhostteaMetalError.invalidViewport
    }
    let visibleDefinitions = try visibleGlyphDefinitions(state)
    let atlasUpload = try atlases.synchronize(visible: visibleDefinitions)
    let mesh = try buildMesh(
      state: state,
      width: width,
      height: height,
      scale: scale,
      theme: theme,
      contentInsets: contentInsets,
      selection: selection,
      focused: focused,
      cursorBlinkVisible: cursorBlinkVisible
    )
    try encode(mesh: mesh, target: target, theme: theme, presenting: drawable)
    return GhostteaMetalDrawResult(
      rectangleVertexCount: (mesh.backgrounds.count + mesh.selection.count + mesh.decorations.count
        + mesh.cursor.count) / 6,
      alphaGlyphVertexCount: mesh.alphaGlyphs.count / 8,
      colorGlyphVertexCount: mesh.colorGlyphs.count / 8,
      atlasUpload: atlasUpload
    )
  }

  private func visibleGlyphDefinitions(_ state: RetainedTRF1State) throws -> [TRF1GlyphDefinition] {
    var ids: Set<UInt32> = []
    for row in state.rows {
      for glyph in row.glyphs {
        guard glyph.x.isFinite, glyph.y.isFinite, glyph.width.isFinite, glyph.height.isFinite,
          glyph.width > 0, glyph.height > 0
        else {
          throw GhostteaMetalError.invalidGeometry(glyph.glyphID)
        }
        ids.insert(glyph.glyphID)
      }
    }
    return try ids.sorted().map { id in
      guard let definition = state.glyphDefinitions[id] else {
        throw TRF1DecodingError("row references undefined glyph \(id)")
      }
      return definition
    }
  }

  private func buildMesh(
    state: RetainedTRF1State,
    width: Int,
    height: Int,
    scale: Float,
    theme: GhostteaMetalTheme,
    contentInsets: GhostteaTerminalContentInsets,
    selection: GhostteaMetalSelection?,
    focused: Bool,
    cursorBlinkVisible: Bool
  ) throws -> GhostteaMetalMesh {
    var mesh = GhostteaMetalMesh()
    let originX = Self.originX + contentInsets.left
    let originY = Self.originY + contentInsets.top
    let orderedSelection = ordered(selection)
    for (rowIndex, row) in state.rows.enumerated() {
      for run in row.styles {
        let style = resolveStyle(state.styleDefinitions[run.styleID], theme: theme)
        if let background = style.background {
          pushRectangle(
            into: &mesh.backgrounds,
            x: (originX + Float(run.cellStart) * Self.cellWidth) * scale,
            y: (originY + Float(rowIndex) * Self.lineHeight) * scale,
            width: Float(run.cellSpan) * Self.cellWidth * scale,
            height: Self.lineHeight * scale,
            color: background,
            viewportWidth: width,
            viewportHeight: height
          )
        }
      }
    }
    if let orderedSelection {
      for row in Int(orderedSelection.anchor.row)...Int(orderedSelection.focus.row) {
        guard row < state.rows.count else { break }
        let first =
          row == Int(orderedSelection.anchor.row) ? Int(orderedSelection.anchor.column) : 0
        let last =
          row == Int(orderedSelection.focus.row)
          ? Int(orderedSelection.focus.column)
          : max(0, Int(state.columns) - 1)
        pushRectangle(
          into: &mesh.selection,
          x: (originX + Float(first) * Self.cellWidth) * scale,
          y: (originY + Float(row) * Self.lineHeight) * scale,
          width: Float(max(1, last - first + 1)) * Self.cellWidth * scale,
          height: Self.lineHeight * scale,
          color: theme.selection,
          viewportWidth: width,
          viewportHeight: height
        )
      }
    }
    for (rowIndex, row) in state.rows.enumerated() {
      for instance in row.glyphs {
        guard let definition = state.glyphDefinitions[instance.glyphID] else { continue }
        let style = resolveStyle(state.styleDefinitions[instance.styleID], theme: theme)
        if style.invisible { continue }
        let foreground =
          selectionContains(orderedSelection, row: rowIndex, column: Int(instance.cellStart))
          ? theme.selectionForeground
          : style.foreground
        let atlas = definition.format == .alpha8 ? atlases.alpha : atlases.color
        guard let location = atlas.location(for: definition.id) else {
          throw TRF1DecodingError("visible glyph \(definition.id) is absent from its atlas")
        }
        let output =
          definition.format == .alpha8
          ? \GhostteaMetalMesh.alphaGlyphs : \GhostteaMetalMesh.colorGlyphs
        pushGlyph(
          into: &mesh[keyPath: output],
          x: (originX + instance.x) * scale,
          y: (originY + Float(rowIndex) * Self.lineHeight + instance.y) * scale,
          width: instance.width * scale,
          height: instance.height * scale,
          location: location,
          color: foreground,
          viewportWidth: width,
          viewportHeight: height
        )
      }
      for run in row.styles {
        let style = resolveStyle(state.styleDefinitions[run.styleID], theme: theme)
        if style.invisible { continue }
        let x = (originX + Float(run.cellStart) * Self.cellWidth) * scale
        let rowTop = (originY + Float(rowIndex) * Self.lineHeight) * scale
        let runWidth = Float(run.cellSpan) * Self.cellWidth * scale
        let stroke = max(1, scale.rounded())
        if style.underline {
          pushRectangle(
            into: &mesh.decorations,
            x: x,
            y: (rowTop + 16 * scale).rounded(),
            width: runWidth,
            height: stroke,
            color: style.foreground,
            viewportWidth: width,
            viewportHeight: height
          )
        }
        if style.strikethrough {
          pushRectangle(
            into: &mesh.decorations,
            x: x,
            y: (rowTop + 9 * scale).rounded(),
            width: runWidth,
            height: stroke,
            color: style.foreground,
            viewportWidth: width,
            viewportHeight: height
          )
        }
      }
    }
    if let cursor = state.cursor, cursor.visible, !cursor.blinking || cursorBlinkVisible {
      guard Int(cursor.x) < Int(state.columns), Int(cursor.y) < state.rows.count else {
        throw TRF1DecodingError("cursor exceeds viewport")
      }
      let x = (originX + Float(cursor.x) * Self.cellWidth) * scale
      let y = (originY + Float(cursor.y) * Self.lineHeight) * scale
      let cursorStyle: TRF1CursorStyle = focused ? cursor.style : .hollowBlock
      let cursorWidth = cursorStyle == .bar ? max(2, (2 * scale).rounded()) : Self.cellWidth * scale
      pushRectangle(
        into: &mesh.cursor,
        x: x,
        y: y,
        width: cursorWidth,
        height: Self.lineHeight * scale,
        color: theme.cursor,
        viewportWidth: width,
        viewportHeight: height
      )
    }
    return mesh
  }

  private func encode(
    mesh: GhostteaMetalMesh,
    target: any MTLTexture,
    theme: GhostteaMetalTheme,
    presenting drawable: (any MTLDrawable)?
  ) throws {
    guard let commandBuffer = runtime.commandQueue.makeCommandBuffer() else {
      throw GhostteaMetalError.commandQueueUnavailable
    }
    let descriptor = MTLRenderPassDescriptor()
    descriptor.colorAttachments[0].texture = target
    descriptor.colorAttachments[0].loadAction = .clear
    descriptor.colorAttachments[0].storeAction = .store
    descriptor.colorAttachments[0].clearColor = MTLClearColor(
      red: Double(theme.background.red),
      green: Double(theme.background.green),
      blue: Double(theme.background.blue),
      alpha: Double(theme.background.alpha)
    )
    guard let encoder = commandBuffer.makeRenderCommandEncoder(descriptor: descriptor) else {
      throw GhostteaMetalError.renderTargetUnavailable
    }
    encoder.label = "Ghosttea terminal pass"
    try draw(
      mesh.backgrounds, label: "backgrounds", pipeline: rectanglePipeline, encoder: encoder,
      stride: 6)
    try draw(
      mesh.selection, label: "selection", pipeline: rectanglePipeline, encoder: encoder, stride: 6)
    try drawGlyphs(
      mesh.alphaGlyphs,
      label: "alpha glyphs",
      pipeline: alphaGlyphPipeline,
      texture: atlases.alpha.texture,
      encoder: encoder
    )
    try drawGlyphs(
      mesh.colorGlyphs,
      label: "color glyphs",
      pipeline: colorGlyphPipeline,
      texture: atlases.color.texture,
      encoder: encoder
    )
    try draw(
      mesh.decorations, label: "decorations", pipeline: rectanglePipeline, encoder: encoder,
      stride: 6)
    try draw(mesh.cursor, label: "cursor", pipeline: rectanglePipeline, encoder: encoder, stride: 6)
    encoder.endEncoding()
    if let drawable {
      commandBuffer.present(drawable)
      commandBuffer.commit()
      return
    }
    commandBuffer.commit()
    commandBuffer.waitUntilCompleted()
    guard commandBuffer.status == .completed else {
      throw GhostteaMetalError.commandBufferFailed(
        commandBuffer.error?.localizedDescription ?? "unknown failure")
    }
  }

  private func draw(
    _ vertices: [Float],
    label: String,
    pipeline: any MTLRenderPipelineState,
    encoder: any MTLRenderCommandEncoder,
    stride: Int
  ) throws {
    guard !vertices.isEmpty else { return }
    let buffer = try makeBuffer(vertices, label: label)
    encoder.setRenderPipelineState(pipeline)
    encoder.setVertexBuffer(buffer, offset: 0, index: 0)
    encoder.drawPrimitives(type: .triangle, vertexStart: 0, vertexCount: vertices.count / stride)
  }

  private func drawGlyphs(
    _ vertices: [Float],
    label: String,
    pipeline: any MTLRenderPipelineState,
    texture: any MTLTexture,
    encoder: any MTLRenderCommandEncoder
  ) throws {
    guard !vertices.isEmpty else { return }
    let buffer = try makeBuffer(vertices, label: label)
    encoder.setRenderPipelineState(pipeline)
    encoder.setVertexBuffer(buffer, offset: 0, index: 0)
    encoder.setFragmentTexture(texture, index: 0)
    encoder.setFragmentSamplerState(sampler, index: 0)
    encoder.drawPrimitives(type: .triangle, vertexStart: 0, vertexCount: vertices.count / 8)
  }

  private func makeBuffer(_ vertices: [Float], label: String) throws -> any MTLBuffer {
    let buffer = vertices.withUnsafeBufferPointer { values in
      runtime.device.makeBuffer(
        bytes: values.baseAddress!,
        length: values.count * MemoryLayout<Float>.stride,
        options: .storageModeShared
      )
    }
    guard let buffer else { throw GhostteaMetalError.bufferUnavailable(label) }
    buffer.label = "Ghosttea \(label) vertices"
    return buffer
  }

  private static func makeRectanglePipeline(
    runtime: GhostteaMetalRuntime,
    library: any MTLLibrary
  ) throws -> any MTLRenderPipelineState {
    let descriptor = MTLRenderPipelineDescriptor()
    descriptor.label = "Ghosttea rectangle pipeline"
    descriptor.vertexFunction = library.makeFunction(name: "ghosttea_rectangle_vertex")
    descriptor.fragmentFunction = library.makeFunction(name: "ghosttea_rectangle_fragment")
    let vertex = MTLVertexDescriptor()
    vertex.attributes[0].format = .float2
    vertex.attributes[0].offset = 0
    vertex.attributes[0].bufferIndex = 0
    vertex.attributes[1].format = .float4
    vertex.attributes[1].offset = 2 * MemoryLayout<Float>.stride
    vertex.attributes[1].bufferIndex = 0
    vertex.layouts[0].stride = 6 * MemoryLayout<Float>.stride
    descriptor.vertexDescriptor = vertex
    configureColorAttachment(descriptor.colorAttachments[0])
    do {
      return try runtime.device.makeRenderPipelineState(descriptor: descriptor)
    } catch {
      throw GhostteaMetalError.pipelineUnavailable(String(describing: error))
    }
  }

  private static func makeGlyphPipeline(
    runtime: GhostteaMetalRuntime,
    library: any MTLLibrary,
    fragment: String,
    label: String
  ) throws -> any MTLRenderPipelineState {
    let descriptor = MTLRenderPipelineDescriptor()
    descriptor.label = label
    descriptor.vertexFunction = library.makeFunction(name: "ghosttea_glyph_vertex")
    descriptor.fragmentFunction = library.makeFunction(name: fragment)
    let vertex = MTLVertexDescriptor()
    vertex.attributes[0].format = .float2
    vertex.attributes[0].offset = 0
    vertex.attributes[0].bufferIndex = 0
    vertex.attributes[1].format = .float2
    vertex.attributes[1].offset = 2 * MemoryLayout<Float>.stride
    vertex.attributes[1].bufferIndex = 0
    vertex.attributes[2].format = .float4
    vertex.attributes[2].offset = 4 * MemoryLayout<Float>.stride
    vertex.attributes[2].bufferIndex = 0
    vertex.layouts[0].stride = 8 * MemoryLayout<Float>.stride
    descriptor.vertexDescriptor = vertex
    configureColorAttachment(descriptor.colorAttachments[0])
    do {
      return try runtime.device.makeRenderPipelineState(descriptor: descriptor)
    } catch {
      throw GhostteaMetalError.pipelineUnavailable(String(describing: error))
    }
  }

  private static func configureColorAttachment(
    _ attachment: MTLRenderPipelineColorAttachmentDescriptor?
  ) {
    attachment?.pixelFormat = .rgba8Unorm
    attachment?.isBlendingEnabled = true
    attachment?.rgbBlendOperation = .add
    attachment?.alphaBlendOperation = .add
    attachment?.sourceRGBBlendFactor = .one
    attachment?.sourceAlphaBlendFactor = .one
    attachment?.destinationRGBBlendFactor = .oneMinusSourceAlpha
    attachment?.destinationAlphaBlendFactor = .oneMinusSourceAlpha
  }
}

private func resolveStyle(
  _ style: TRF1StyleDefinition?,
  theme: GhostteaMetalTheme
) -> GhostteaResolvedMetalStyle {
  var foreground = style?.foreground.map(metalColor) ?? theme.foreground
  var background = style?.background.map(metalColor)
  if style?.inverse == true {
    let originalForeground = foreground
    foreground = background ?? theme.background
    background = originalForeground
  }
  if style?.faint == true {
    foreground = GhostteaMetalColor(
      red: foreground.red,
      green: foreground.green,
      blue: foreground.blue,
      alpha: foreground.alpha * 0.55
    )
  }
  return GhostteaResolvedMetalStyle(
    foreground: foreground,
    background: background,
    underline: style?.underline ?? false,
    strikethrough: style?.strikethrough ?? false,
    invisible: style?.invisible ?? false
  )
}

private func metalColor(_ color: TRF1RGB) -> GhostteaMetalColor {
  GhostteaMetalColor(
    red: Float(color.red) / 255,
    green: Float(color.green) / 255,
    blue: Float(color.blue) / 255,
    alpha: 1
  )
}

private func ordered(_ selection: GhostteaMetalSelection?) -> GhostteaMetalSelection? {
  guard let selection else { return nil }
  let anchor = selection.anchor
  let focus = selection.focus
  if anchor.row < focus.row || (anchor.row == focus.row && anchor.column <= focus.column) {
    return selection
  }
  return GhostteaMetalSelection(anchor: focus, focus: anchor)
}

private func selectionContains(_ selection: GhostteaMetalSelection?, row: Int, column: Int) -> Bool
{
  guard let selection, row >= Int(selection.anchor.row), row <= Int(selection.focus.row) else {
    return false
  }
  let first = row == Int(selection.anchor.row) ? Int(selection.anchor.column) : 0
  let last = row == Int(selection.focus.row) ? Int(selection.focus.column) : Int.max
  return column >= first && column <= last
}

private func clipX(_ pixel: Float, width: Int) -> Float {
  pixel / Float(width) * 2 - 1
}

private func clipY(_ pixel: Float, height: Int) -> Float {
  1 - pixel / Float(height) * 2
}

private func pushRectangle(
  into output: inout [Float],
  x: Float,
  y: Float,
  width: Float,
  height: Float,
  color: GhostteaMetalColor,
  viewportWidth: Int,
  viewportHeight: Int
) {
  let left = clipX(x, width: viewportWidth)
  let right = clipX(x + width, width: viewportWidth)
  let top = clipY(y, height: viewportHeight)
  let bottom = clipY(y + height, height: viewportHeight)
  appendRectangleVertex(to: &output, x: left, y: top, color: color)
  appendRectangleVertex(to: &output, x: right, y: top, color: color)
  appendRectangleVertex(to: &output, x: left, y: bottom, color: color)
  appendRectangleVertex(to: &output, x: left, y: bottom, color: color)
  appendRectangleVertex(to: &output, x: right, y: top, color: color)
  appendRectangleVertex(to: &output, x: right, y: bottom, color: color)
}

private func appendRectangleVertex(
  to output: inout [Float],
  x: Float,
  y: Float,
  color: GhostteaMetalColor
) {
  output.append(contentsOf: [x, y] + color.components)
}

private func pushGlyph(
  into output: inout [Float],
  x: Float,
  y: Float,
  width: Float,
  height: Float,
  location: GhostteaAtlasLocation,
  color: GhostteaMetalColor,
  viewportWidth: Int,
  viewportHeight: Int
) {
  let left = clipX(x, width: viewportWidth)
  let right = clipX(x + width, width: viewportWidth)
  let top = clipY(y, height: viewportHeight)
  let bottom = clipY(y + height, height: viewportHeight)
  appendGlyphVertex(to: &output, x: left, y: top, u: location.u0, v: location.v0, color: color)
  appendGlyphVertex(to: &output, x: right, y: top, u: location.u1, v: location.v0, color: color)
  appendGlyphVertex(to: &output, x: left, y: bottom, u: location.u0, v: location.v1, color: color)
  appendGlyphVertex(to: &output, x: left, y: bottom, u: location.u0, v: location.v1, color: color)
  appendGlyphVertex(to: &output, x: right, y: top, u: location.u1, v: location.v0, color: color)
  appendGlyphVertex(to: &output, x: right, y: bottom, u: location.u1, v: location.v1, color: color)
}

private func appendGlyphVertex(
  to output: inout [Float],
  x: Float,
  y: Float,
  u: Float,
  v: Float,
  color: GhostteaMetalColor
) {
  output.append(contentsOf: [x, y, u, v] + color.components)
}

private func readPixels(texture: any MTLTexture, width: Int, height: Int) -> [UInt8] {
  var pixels = [UInt8](repeating: 0, count: width * height * 4)
  pixels.withUnsafeMutableBytes { bytes in
    texture.getBytes(
      bytes.baseAddress!,
      bytesPerRow: width * 4,
      from: MTLRegionMake2D(0, 0, width, height),
      mipmapLevel: 0
    )
  }
  return pixels
}

private func countNonBackgroundPixels(_ pixels: [UInt8], background: GhostteaMetalColor) -> Int {
  let expected = [background.red, background.green, background.blue, background.alpha].map {
    UInt8(max(0, min(255, ($0 * 255).rounded())))
  }
  var count = 0
  for offset in stride(from: 0, to: pixels.count, by: 4) {
    if pixels[offset] != expected[0] || pixels[offset + 1] != expected[1]
      || pixels[offset + 2] != expected[2] || pixels[offset + 3] != expected[3]
    {
      count += 1
    }
  }
  return count
}

private func fnv1a64(_ bytes: [UInt8]) -> UInt64 {
  var hash: UInt64 = 0xcbf2_9ce4_8422_2325
  for byte in bytes {
    hash ^= UInt64(byte)
    hash &*= 0x0000_0100_0000_01b3
  }
  return hash
}
