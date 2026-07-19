/// <reference types="@webgpu/types" />

import { CursorStyle, GlyphFormat, type GlyphDefinition, type StyleDefinition } from "@vibecook/ghosttea-frame";
import type { TerminalRenderMetrics } from "../performance.js";

import {
  CELL_WIDTH,
  LINE_HEIGHT,
  ORIGIN_X,
  ORIGIN_Y,
  effectiveCursorStyle,
  type CellPoint,
  type PixelSize,
  type RenderView,
  type Rgba,
  type TerminalRenderer,
} from "./types.js";
import { graphemeCellWidth, splitGraphemes } from "../cell-width.js";

const ATLAS_SIZE = 2048;
const FONT_STACK = "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace";

const RECT_SHADER = /* wgsl */ `
struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) color: vec4f,
}

@vertex fn vertex_main(
  @location(0) position: vec2f,
  @location(1) color: vec4f,
) -> VertexOutput {
  var output: VertexOutput;
  output.position = vec4f(position, 0.0, 1.0);
  output.color = color;
  return output;
}

@fragment fn fragment_main(input: VertexOutput) -> @location(0) vec4f {
  return vec4f(input.color.rgb * input.color.a, input.color.a);
}
`;

const GLYPH_SHADER = /* wgsl */ `
@group(0) @binding(0) var atlas: texture_2d<f32>;
@group(0) @binding(1) var atlas_sampler: sampler;

struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
  @location(1) color: vec4f,
}

@vertex fn vertex_main(
  @location(0) position: vec2f,
  @location(1) uv: vec2f,
  @location(2) color: vec4f,
) -> VertexOutput {
  var output: VertexOutput;
  output.position = vec4f(position, 0.0, 1.0);
  output.uv = uv;
  output.color = color;
  return output;
}

@fragment fn fragment_main(input: VertexOutput) -> @location(0) vec4f {
  let coverage = textureSample(atlas, atlas_sampler, input.uv).a;
  let alpha = input.color.a * coverage;
  return vec4f(input.color.rgb * alpha, alpha);
}
`;

const COLOR_GLYPH_SHADER = /* wgsl */ `
@group(0) @binding(0) var atlas: texture_2d<f32>;
@group(0) @binding(1) var atlas_sampler: sampler;

struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
  @location(1) color: vec4f,
}

@vertex fn vertex_main(
  @location(0) position: vec2f,
  @location(1) uv: vec2f,
  @location(2) color: vec4f,
) -> VertexOutput {
  var output: VertexOutput;
  output.position = vec4f(position, 0.0, 1.0);
  output.uv = uv;
  output.color = color;
  return output;
}

@fragment fn fragment_main(input: VertexOutput) -> @location(0) vec4f {
  return textureSample(atlas, atlas_sampler, input.uv);
}
`;

// WebGPU port of ~/.config/ghostty/shaders/bettercrt.glsl. Ghostty applies
// custom shaders to the completed terminal image, so this must remain a
// separate pass rather than being approximated per glyph.
const BETTER_CRT_SHADER = /* wgsl */ `
@group(0) @binding(0) var terminal_image: texture_2d<f32>;
@group(0) @binding(1) var terminal_sampler: sampler;

@vertex fn vertex_main(@builtin(vertex_index) vertex_index: u32) -> @builtin(position) vec4f {
  let positions = array<vec2f, 3>(
    vec2f(-1.0, -1.0),
    vec2f(3.0, -1.0),
    vec2f(-1.0, 3.0),
  );
  return vec4f(positions[vertex_index], 0.0, 1.0);
}

@fragment fn fragment_main(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let dimensions = vec2f(textureDimensions(terminal_image));
  var uv = position.xy / dimensions;
  var dc = abs(vec2f(0.5) - uv);
  dc *= dc;

  // These constants are the active Ghostty shader's warp = 0.25 and
  // scan = 0.50 values.
  uv.x -= 0.5;
  uv.x *= 1.0 + dc.y * 0.075;
  uv.x += 0.5;
  uv.y -= 0.5;
  uv.y *= 1.0 + dc.x * 0.10;
  uv.y += 0.5;

  let scanline = abs(sin(position.y) * 0.125);
  let color = textureSample(terminal_image, terminal_sampler, uv).rgb;
  return vec4f(mix(color, vec3f(0.0), scanline), 1.0);
}
`;

const premultipliedBlend: GPUBlendState = {
  color: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
  alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
};

class DynamicVertexBuffer {
  #buffer: GPUBuffer | undefined;
  #capacity = 0;

  constructor(
    readonly device: GPUDevice,
    readonly label: string,
  ) {}

  write(vertices: Float32Array): GPUBuffer | undefined {
    if (vertices.byteLength === 0) return undefined;
    if (!this.#buffer || this.#capacity < vertices.byteLength) {
      this.#buffer?.destroy();
      this.#capacity = Math.max(4096, 2 ** Math.ceil(Math.log2(vertices.byteLength)));
      this.#buffer = this.device.createBuffer({
        label: this.label,
        size: this.#capacity,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      });
    }
    this.device.queue.writeBuffer(this.#buffer, 0, vertices);
    return this.#buffer;
  }

  destroy(): void {
    this.#buffer?.destroy();
    this.#buffer = undefined;
  }
}

interface GlyphLocation {
  u0: number;
  v0: number;
  u1: number;
  v1: number;
  cells: number;
}

class FallbackGlyphAtlas {
  readonly #texture: GPUTexture;
  readonly #sampler: GPUSampler;
  readonly #bindGroup: GPUBindGroup;
  readonly #cache = new Map<string, GlyphLocation>();
  readonly #scratch = new OffscreenCanvas(1, 1);
  #x = 1;
  #y = 1;
  #rowHeight = 0;
  #uploadBytes = 0;
  #uploadCalls = 0;

  constructor(
    readonly device: GPUDevice,
    bindGroupLayout: GPUBindGroupLayout,
  ) {
    this.#texture = device.createTexture({
      label: "terminal glyph atlas",
      size: [ATLAS_SIZE, ATLAS_SIZE],
      format: "rgba8unorm",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this.#sampler = device.createSampler({ minFilter: "linear", magFilter: "linear" });
    this.#bindGroup = device.createBindGroup({
      label: "terminal glyph atlas bindings",
      layout: bindGroupLayout,
      entries: [
        { binding: 0, resource: this.#texture.createView() },
        { binding: 1, resource: this.#sampler },
      ],
    });
  }

  get bindGroup(): GPUBindGroup {
    return this.#bindGroup;
  }

  prepare(values: Iterable<string>, dpr: number): void {
    const scale = Math.max(1, Math.min(3, dpr));
    const all = [...new Set(values)].filter((value) => value.trim().length > 0);
    const missing = all.filter((value) => !this.#cache.has(`${scale.toFixed(2)}:${value}`));
    if (this.#fits(missing, scale, this.#x, this.#y, this.#rowHeight)) return;
    this.#cache.clear();
    this.#x = 1;
    this.#y = 1;
    this.#rowHeight = 0;
    if (!this.#fits(all, scale, this.#x, this.#y, this.#rowHeight)) {
      throw new Error("The diagnostic glyph atlas cannot fit the text visible in one frame");
    }
  }

  #fits(values: Iterable<string>, scale: number, startX: number, startY: number, startRowHeight: number): boolean {
    let x = startX;
    let y = startY;
    let rowHeight = startRowHeight;
    for (const value of values) {
      const width = Math.max(1, Math.ceil(CELL_WIDTH * graphemeCellWidth(value) * scale));
      const height = Math.max(1, Math.ceil(LINE_HEIGHT * scale));
      if (x + width + 1 > ATLAS_SIZE) {
        x = 1;
        y += rowHeight + 1;
        rowHeight = 0;
      }
      if (y + height + 1 > ATLAS_SIZE) return false;
      x += width + 1;
      rowHeight = Math.max(rowHeight, height);
    }
    return true;
  }

  glyph(grapheme: string, dpr: number): GlyphLocation | undefined {
    if (grapheme.trim().length === 0) return undefined;
    const scale = Math.max(1, Math.min(3, dpr));
    const cells = graphemeCellWidth(grapheme);
    const key = `${scale.toFixed(2)}:${grapheme}`;
    const cached = this.#cache.get(key);
    if (cached) return cached;

    const width = Math.max(1, Math.ceil(CELL_WIDTH * cells * scale));
    const height = Math.max(1, Math.ceil(LINE_HEIGHT * scale));
    if (this.#x + width + 1 > ATLAS_SIZE) {
      this.#x = 1;
      this.#y += this.#rowHeight + 1;
      this.#rowHeight = 0;
    }
    if (this.#y + height + 1 > ATLAS_SIZE) {
      throw new Error("Temporary glyph atlas exhausted");
    }

    this.#scratch.width = width;
    this.#scratch.height = height;
    const context = this.#scratch.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("Glyph raster canvas unavailable");
    context.clearRect(0, 0, width, height);
    context.fillStyle = "white";
    context.font = `${13 * scale}px ${FONT_STACK}`;
    context.textBaseline = "top";
    context.fillText(grapheme, 0, Math.max(0, Math.floor((height - 15 * scale) / 2)));
    const image = context.getImageData(0, 0, width, height);
    this.device.queue.writeTexture(
      { texture: this.#texture, origin: [this.#x, this.#y] },
      image.data,
      { bytesPerRow: width * 4, rowsPerImage: height },
      [width, height],
    );
    this.#uploadBytes += image.data.byteLength;
    this.#uploadCalls += 1;
    const location: GlyphLocation = {
      u0: this.#x / ATLAS_SIZE,
      v0: this.#y / ATLAS_SIZE,
      u1: (this.#x + width) / ATLAS_SIZE,
      v1: (this.#y + height) / ATLAS_SIZE,
      cells,
    };
    this.#cache.set(key, location);
    this.#x += width + 1;
    this.#rowHeight = Math.max(this.#rowHeight, height);
    return location;
  }

  destroy(): void {
    this.#texture.destroy();
  }

  uploadMetrics(): { bytes: number; calls: number } {
    return { bytes: this.#uploadBytes, calls: this.#uploadCalls };
  }
}

class NativeGlyphAtlas {
  readonly #texture: GPUTexture;
  readonly #sampler: GPUSampler;
  readonly #bindGroup: GPUBindGroup;
  readonly #cache = new Map<number, GlyphLocation>();
  #x = 1;
  #y = 1;
  #rowHeight = 0;
  #uploadBytes = 0;
  #uploadCalls = 0;

  constructor(
    readonly device: GPUDevice,
    bindGroupLayout: GPUBindGroupLayout,
    readonly label: string,
  ) {
    this.#texture = device.createTexture({
      label,
      size: [ATLAS_SIZE, ATLAS_SIZE],
      format: "rgba8unorm",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this.#sampler = device.createSampler({ minFilter: "linear", magFilter: "linear" });
    this.#bindGroup = device.createBindGroup({
      label: `${label} bindings`,
      layout: bindGroupLayout,
      entries: [
        { binding: 0, resource: this.#texture.createView() },
        { binding: 1, resource: this.#sampler },
      ],
    });
  }

  get bindGroup(): GPUBindGroup {
    return this.#bindGroup;
  }

  prepare(definitions: Iterable<GlyphDefinition>): void {
    const all = new Map<number, GlyphDefinition>();
    const missing = new Map<number, GlyphDefinition>();
    for (const definition of definitions) {
      all.set(definition.id, definition);
      if (!this.#cache.has(definition.id)) missing.set(definition.id, definition);
    }
    if (this.#fits(missing.values(), this.#x, this.#y, this.#rowHeight)) return;
    this.#cache.clear();
    this.#x = 1;
    this.#y = 1;
    this.#rowHeight = 0;
    if (!this.#fits(all.values(), this.#x, this.#y, this.#rowHeight)) {
      throw new Error(`${this.label} cannot fit the glyphs visible in one frame`);
    }
  }

  #fits(definitions: Iterable<GlyphDefinition>, startX: number, startY: number, startRowHeight: number): boolean {
    let x = startX;
    let y = startY;
    let rowHeight = startRowHeight;
    for (const { width, height } of definitions) {
      if (width + 2 > ATLAS_SIZE || height + 2 > ATLAS_SIZE) return false;
      if (x + width + 1 > ATLAS_SIZE) {
        x = 1;
        y += rowHeight + 1;
        rowHeight = 0;
      }
      if (y + height + 1 > ATLAS_SIZE) return false;
      x += width + 1;
      rowHeight = Math.max(rowHeight, height);
    }
    return true;
  }

  glyph(definition: GlyphDefinition): GlyphLocation {
    const cached = this.#cache.get(definition.id);
    if (cached) return cached;
    const { width, height } = definition;
    if (this.#x + width + 1 > ATLAS_SIZE) {
      this.#x = 1;
      this.#y += this.#rowHeight + 1;
      this.#rowHeight = 0;
    }
    if (this.#y + height + 1 > ATLAS_SIZE) throw new Error(`${this.label} exhausted`);
    let pixels = definition.pixels;
    if (definition.format === GlyphFormat.Alpha8) {
      const rgba = new Uint8Array(width * height * 4);
      for (let index = 0; index < pixels.length; index += 1) {
        const offset = index * 4;
        rgba[offset] = 255;
        rgba[offset + 1] = 255;
        rgba[offset + 2] = 255;
        rgba[offset + 3] = pixels[index]!;
      }
      pixels = rgba;
    }
    this.device.queue.writeTexture(
      { texture: this.#texture, origin: [this.#x, this.#y] },
      pixels,
      { bytesPerRow: width * 4, rowsPerImage: height },
      [width, height],
    );
    this.#uploadBytes += pixels.byteLength;
    this.#uploadCalls += 1;
    const location: GlyphLocation = {
      u0: this.#x / ATLAS_SIZE,
      v0: this.#y / ATLAS_SIZE,
      u1: (this.#x + width) / ATLAS_SIZE,
      v1: (this.#y + height) / ATLAS_SIZE,
      cells: 0,
    };
    this.#cache.set(definition.id, location);
    this.#x += width + 1;
    this.#rowHeight = Math.max(this.#rowHeight, height);
    return location;
  }

  destroy(): void {
    this.#texture.destroy();
  }

  uploadMetrics(): { bytes: number; calls: number } {
    return { bytes: this.#uploadBytes, calls: this.#uploadCalls };
  }
}

interface WebGpuSurface extends PixelSize {
  canvas: OffscreenCanvas;
  context: GPUCanvasContext;
  sceneTexture: GPUTexture;
  postProcessBindGroup: GPUBindGroup;
  rectangleBuffer: DynamicVertexBuffer;
  glyphBuffer: DynamicVertexBuffer;
  colorGlyphBuffer: DynamicVertexBuffer;
  fallbackGlyphBuffer: DynamicVertexBuffer;
}

function clipX(pixel: number, width: number): number {
  return (pixel / Math.max(1, width)) * 2 - 1;
}

function clipY(pixel: number, height: number): number {
  return 1 - (pixel / Math.max(1, height)) * 2;
}

function pushRectangle(
  output: number[],
  x: number,
  y: number,
  width: number,
  height: number,
  color: Rgba,
  viewportWidth: number,
  viewportHeight: number,
): void {
  const left = clipX(x, viewportWidth);
  const right = clipX(x + width, viewportWidth);
  const top = clipY(y, viewportHeight);
  const bottom = clipY(y + height, viewportHeight);
  const vertex = (px: number, py: number): void => {
    output.push(px, py, ...color);
  };
  vertex(left, top);
  vertex(right, top);
  vertex(left, bottom);
  vertex(left, bottom);
  vertex(right, top);
  vertex(right, bottom);
}

function pushGlyph(
  output: number[],
  x: number,
  y: number,
  width: number,
  height: number,
  glyph: GlyphLocation,
  color: Rgba,
  viewportWidth: number,
  viewportHeight: number,
): void {
  const left = clipX(x, viewportWidth);
  const right = clipX(x + width, viewportWidth);
  const top = clipY(y, viewportHeight);
  const bottom = clipY(y + height, viewportHeight);
  const vertex = (px: number, py: number, u: number, v: number): void => {
    output.push(px, py, u, v, ...color);
  };
  vertex(left, top, glyph.u0, glyph.v0);
  vertex(right, top, glyph.u1, glyph.v0);
  vertex(left, bottom, glyph.u0, glyph.v1);
  vertex(left, bottom, glyph.u0, glyph.v1);
  vertex(right, top, glyph.u1, glyph.v0);
  vertex(right, bottom, glyph.u1, glyph.v1);
}

function ordered(selection: RenderView["selection"]): [CellPoint, CellPoint] | null {
  if (!selection) return null;
  const { anchor, focus } = selection;
  return anchor.row < focus.row || (anchor.row === focus.row && anchor.column <= focus.column)
    ? [anchor, focus]
    : [focus, anchor];
}

function cellLength(text: string): number {
  return splitGraphemes(text).reduce((total, grapheme) => total + graphemeCellWidth(grapheme), 0);
}

const BOX_DIRECTIONS = new Map<string, string>([
  ["─", "lr"],
  ["━", "lr"],
  ["│", "ud"],
  ["┃", "ud"],
  ["┌", "rd"],
  ["┍", "rd"],
  ["┎", "rd"],
  ["┏", "rd"],
  ["┐", "ld"],
  ["┑", "ld"],
  ["┒", "ld"],
  ["┓", "ld"],
  ["└", "ru"],
  ["┕", "ru"],
  ["┖", "ru"],
  ["┗", "ru"],
  ["┘", "lu"],
  ["┙", "lu"],
  ["┚", "lu"],
  ["┛", "lu"],
  ["├", "udr"],
  ["┝", "udr"],
  ["┞", "udr"],
  ["┣", "udr"],
  ["┤", "udl"],
  ["┥", "udl"],
  ["┦", "udl"],
  ["┫", "udl"],
  ["┬", "lrd"],
  ["┯", "lrd"],
  ["┰", "lrd"],
  ["┳", "lrd"],
  ["┴", "lru"],
  ["┷", "lru"],
  ["┸", "lru"],
  ["┻", "lru"],
  ["┼", "lrud"],
  ["╋", "lrud"],
  ["╴", "l"],
  ["╶", "r"],
  ["╵", "u"],
  ["╷", "d"],
  ["═", "lr"],
  ["║", "ud"],
  ["╔", "rd"],
  ["╗", "ld"],
  ["╚", "ru"],
  ["╝", "lu"],
  ["╠", "udr"],
  ["╣", "udl"],
  ["╦", "lrd"],
  ["╩", "lru"],
  ["╬", "lrud"],
  ["╭", "rd"],
  ["╮", "ld"],
  ["╯", "lu"],
  ["╰", "ru"],
]);

const ROUNDED_BOX_CORNERS = new Set(["╭", "╮", "╯", "╰"]);

function boxDrawingCells(text: string): Map<number, string> {
  const cells = new Map<number, string>();
  let column = 0;
  for (const grapheme of splitGraphemes(text)) {
    if (BOX_DIRECTIONS.has(grapheme)) cells.set(column, grapheme);
    column += graphemeCellWidth(grapheme);
  }
  return cells;
}

function blockElementCells(text: string): Map<number, string> {
  const cells = new Map<number, string>();
  let column = 0;
  for (const grapheme of splitGraphemes(text)) {
    const codepoint = grapheme.codePointAt(0) ?? 0;
    if (codepoint >= 0x2580 && codepoint <= 0x259f) cells.set(column, grapheme);
    column += graphemeCellWidth(grapheme);
  }
  return cells;
}

function rgb(color: readonly [number, number, number]): Rgba {
  return [color[0] / 255, color[1] / 255, color[2] / 255, 1];
}

function over(source: Rgba, backdrop: Rgba): Rgba {
  const alpha = source[3] + backdrop[3] * (1 - source[3]);
  if (alpha <= Number.EPSILON) return [0, 0, 0, 0];
  return [
    (source[0] * source[3] + backdrop[0] * backdrop[3] * (1 - source[3])) / alpha,
    (source[1] * source[3] + backdrop[1] * backdrop[3] * (1 - source[3])) / alpha,
    (source[2] * source[3] + backdrop[2] * backdrop[3] * (1 - source[3])) / alpha,
    alpha,
  ];
}

function selectionContains(selection: [CellPoint, CellPoint] | null, row: number, column: number): boolean {
  if (!selection) return false;
  const [start, end] = selection;
  if (row < start.row || row > end.row) return false;
  const first = row === start.row ? start.column : 0;
  const last = row === end.row ? end.column : Number.MAX_SAFE_INTEGER;
  return column >= first && column <= last;
}

interface ResolvedStyle {
  foreground: Rgba;
  background: Rgba | null;
  underline: boolean;
  strikethrough: boolean;
  invisible: boolean;
}

function resolveStyle(style: StyleDefinition | undefined, theme: RenderView["theme"]): ResolvedStyle {
  let foreground: Rgba = style?.foreground ? rgb(style.foreground) : theme.foreground;
  let background: Rgba | null = style?.background ? rgb(style.background) : null;
  if (style?.inverse) {
    const originalForeground = foreground;
    foreground = background ?? theme.background;
    background = originalForeground;
  }
  if (style?.faint) foreground = [foreground[0], foreground[1], foreground[2], foreground[3] * 0.55];
  return {
    foreground,
    background,
    underline: style?.underline ?? false,
    strikethrough: style?.strikethrough ?? false,
    invisible: style?.invisible ?? false,
  };
}

function pushBoxDrawing(
  output: number[],
  grapheme: string,
  column: number,
  row: number,
  scale: number,
  color: Rgba,
  viewportWidth: number,
  viewportHeight: number,
): void {
  const directions = BOX_DIRECTIONS.get(grapheme);
  if (!directions) return;
  const left = (ORIGIN_X + column * CELL_WIDTH) * scale;
  const right = (ORIGIN_X + (column + 1) * CELL_WIDTH) * scale;
  const top = (ORIGIN_Y + row * LINE_HEIGHT) * scale;
  const bottom = (ORIGIN_Y + (row + 1) * LINE_HEIGHT) * scale;
  const stroke = Math.max(1, Math.round(scale));
  const centerX = Math.round((left + right - stroke) / 2);
  const centerY = Math.round((top + bottom - stroke) / 2);
  if (ROUNDED_BOX_CORNERS.has(grapheme)) {
    const x = centerX + stroke / 2;
    const y = centerY + stroke / 2;
    const points: Array<readonly [number, number]> = [];
    const [originX, originY, startAngle, endAngle] =
      grapheme === "╭"
        ? [right, bottom, -Math.PI / 2, -Math.PI]
        : grapheme === "╮"
          ? [left, bottom, -Math.PI / 2, 0]
          : grapheme === "╯"
            ? [left, top, Math.PI / 2, 0]
            : [right, top, Math.PI, Math.PI / 2];
    const radiusX = Math.abs(right - x);
    const radiusY = Math.abs(bottom - y);
    const steps = Math.max(5, Math.ceil(Math.max(radiusX, radiusY) / 2));
    for (let step = 0; step <= steps; step += 1) {
      const angle = startAngle + (endAngle - startAngle) * (step / steps);
      points.push([originX + Math.cos(angle) * radiusX, originY + Math.sin(angle) * radiusY]);
    }
    for (let index = 1; index < points.length; index += 1) {
      const from = points[index - 1]!;
      const to = points[index]!;
      const dx = to[0] - from[0];
      const dy = to[1] - from[1];
      const length = Math.hypot(dx, dy);
      if (length <= Number.EPSILON) continue;
      const nx = ((-dy / length) * stroke) / 2;
      const ny = ((dx / length) * stroke) / 2;
      const vertex = (px: number, py: number): void => {
        output.push(clipX(px, viewportWidth), clipY(py, viewportHeight), ...color);
      };
      vertex(from[0] + nx, from[1] + ny);
      vertex(to[0] + nx, to[1] + ny);
      vertex(from[0] - nx, from[1] - ny);
      vertex(from[0] - nx, from[1] - ny);
      vertex(to[0] + nx, to[1] + ny);
      vertex(to[0] - nx, to[1] - ny);
    }
    return;
  }
  if (directions.includes("u"))
    pushRectangle(output, centerX, top, stroke, centerY + stroke - top, color, viewportWidth, viewportHeight);
  if (directions.includes("d"))
    pushRectangle(output, centerX, centerY, stroke, bottom - centerY, color, viewportWidth, viewportHeight);
  if (directions.includes("l"))
    pushRectangle(output, left, centerY, centerX + stroke - left, stroke, color, viewportWidth, viewportHeight);
  if (directions.includes("r"))
    pushRectangle(output, centerX, centerY, right - centerX, stroke, color, viewportWidth, viewportHeight);
}

type FractionRect = readonly [left: number, top: number, right: number, bottom: number];

function blockElementRectangles(grapheme: string): FractionRect[] | null {
  const codepoint = grapheme.codePointAt(0);
  if (codepoint === undefined) return null;
  if (codepoint === 0x2580) return [[0, 0, 1, 0.5]];
  if (codepoint >= 0x2581 && codepoint <= 0x2587) {
    const eighths = codepoint - 0x2580;
    return [[0, 1 - eighths / 8, 1, 1]];
  }
  if (codepoint === 0x2588) return [[0, 0, 1, 1]];
  if (codepoint >= 0x2589 && codepoint <= 0x258f) {
    const eighths = 0x2590 - codepoint;
    return [[0, 0, eighths / 8, 1]];
  }
  if (codepoint === 0x2590) return [[0.5, 0, 1, 1]];
  if (codepoint === 0x2594) return [[0, 0, 1, 1 / 8]];
  if (codepoint === 0x2595) return [[7 / 8, 0, 1, 1]];
  const quadrants: Record<number, readonly number[]> = {
    0x2596: [2],
    0x2597: [3],
    0x2598: [0],
    0x2599: [0, 2, 3],
    0x259a: [0, 3],
    0x259b: [0, 1, 2],
    0x259c: [0, 1, 3],
    0x259d: [1],
    0x259e: [1, 2],
    0x259f: [1, 2, 3],
  };
  const selected = quadrants[codepoint];
  if (!selected) return null;
  const rectangles: FractionRect[] = [
    [0, 0, 0.5, 0.5],
    [0.5, 0, 1, 0.5],
    [0, 0.5, 0.5, 1],
    [0.5, 0.5, 1, 1],
  ];
  return selected.map((quadrant) => rectangles[quadrant]!);
}

function pushBlockElement(
  output: number[],
  grapheme: string,
  column: number,
  row: number,
  scale: number,
  color: Rgba,
  viewportWidth: number,
  viewportHeight: number,
): boolean {
  const rectangles = blockElementRectangles(grapheme);
  if (!rectangles) return false;
  const cellLeft = (ORIGIN_X + column * CELL_WIDTH) * scale;
  const cellRight = (ORIGIN_X + (column + 1) * CELL_WIDTH) * scale;
  const cellTop = (ORIGIN_Y + row * LINE_HEIGHT) * scale;
  const cellBottom = (ORIGIN_Y + (row + 1) * LINE_HEIGHT) * scale;
  for (const [left, top, right, bottom] of rectangles) {
    const x0 = Math.round(cellLeft + (cellRight - cellLeft) * left);
    const x1 = Math.round(cellLeft + (cellRight - cellLeft) * right);
    const y0 = Math.round(cellTop + (cellBottom - cellTop) * top);
    const y1 = Math.round(cellTop + (cellBottom - cellTop) * bottom);
    pushRectangle(output, x0, y0, x1 - x0, y1 - y0, color, viewportWidth, viewportHeight);
  }
  return true;
}

export class WebGpuTerminalRenderer implements TerminalRenderer {
  readonly kind = "webgpu" as const;
  readonly #surfaces = new Map<string, WebGpuSurface>();
  readonly #rectanglePipeline: GPURenderPipeline;
  readonly #glyphPipeline: GPURenderPipeline;
  readonly #colorGlyphPipeline: GPURenderPipeline;
  readonly #postProcessPipeline: GPURenderPipeline;
  readonly #postProcessSampler: GPUSampler;
  readonly #monoAtlas: NativeGlyphAtlas;
  readonly #colorAtlas: NativeGlyphAtlas;
  readonly #fallbackAtlas: FallbackGlyphAtlas;
  #performanceMeasurementEnabled = false;

  private constructor(
    readonly device: GPUDevice,
    readonly format: GPUTextureFormat,
  ) {
    const rectangleModule = device.createShaderModule({ label: "terminal rectangle shader", code: RECT_SHADER });
    const glyphModule = device.createShaderModule({ label: "terminal glyph shader", code: GLYPH_SHADER });
    const colorGlyphModule = device.createShaderModule({
      label: "terminal color glyph shader",
      code: COLOR_GLYPH_SHADER,
    });
    const postProcessModule = device.createShaderModule({ label: "Ghostty bettercrt shader", code: BETTER_CRT_SHADER });
    this.#rectanglePipeline = device.createRenderPipeline({
      label: "terminal rectangle pipeline",
      layout: "auto",
      vertex: {
        module: rectangleModule,
        entryPoint: "vertex_main",
        buffers: [
          {
            arrayStride: 24,
            attributes: [
              { shaderLocation: 0, offset: 0, format: "float32x2" },
              { shaderLocation: 1, offset: 8, format: "float32x4" },
            ],
          },
        ],
      },
      fragment: {
        module: rectangleModule,
        entryPoint: "fragment_main",
        targets: [{ format, blend: premultipliedBlend }],
      },
      primitive: { topology: "triangle-list" },
    });
    this.#glyphPipeline = device.createRenderPipeline({
      label: "terminal glyph pipeline",
      layout: "auto",
      vertex: {
        module: glyphModule,
        entryPoint: "vertex_main",
        buffers: [
          {
            arrayStride: 32,
            attributes: [
              { shaderLocation: 0, offset: 0, format: "float32x2" },
              { shaderLocation: 1, offset: 8, format: "float32x2" },
              { shaderLocation: 2, offset: 16, format: "float32x4" },
            ],
          },
        ],
      },
      fragment: { module: glyphModule, entryPoint: "fragment_main", targets: [{ format, blend: premultipliedBlend }] },
      primitive: { topology: "triangle-list" },
    });
    this.#colorGlyphPipeline = device.createRenderPipeline({
      label: "terminal color glyph pipeline",
      layout: "auto",
      vertex: {
        module: colorGlyphModule,
        entryPoint: "vertex_main",
        buffers: [
          {
            arrayStride: 32,
            attributes: [
              { shaderLocation: 0, offset: 0, format: "float32x2" },
              { shaderLocation: 1, offset: 8, format: "float32x2" },
              { shaderLocation: 2, offset: 16, format: "float32x4" },
            ],
          },
        ],
      },
      fragment: {
        module: colorGlyphModule,
        entryPoint: "fragment_main",
        targets: [{ format, blend: premultipliedBlend }],
      },
      primitive: { topology: "triangle-list" },
    });
    this.#postProcessPipeline = device.createRenderPipeline({
      label: "Ghostty custom shader pipeline",
      layout: "auto",
      vertex: { module: postProcessModule, entryPoint: "vertex_main" },
      fragment: { module: postProcessModule, entryPoint: "fragment_main", targets: [{ format }] },
      primitive: { topology: "triangle-list" },
    });
    this.#postProcessSampler = device.createSampler({
      label: "Ghostty custom shader sampler",
      addressModeU: "clamp-to-edge",
      addressModeV: "clamp-to-edge",
      minFilter: "linear",
      magFilter: "linear",
    });
    this.#monoAtlas = new NativeGlyphAtlas(
      device,
      this.#glyphPipeline.getBindGroupLayout(0),
      "native monochrome glyph atlas",
    );
    this.#colorAtlas = new NativeGlyphAtlas(
      device,
      this.#colorGlyphPipeline.getBindGroupLayout(0),
      "native color glyph atlas",
    );
    this.#fallbackAtlas = new FallbackGlyphAtlas(device, this.#glyphPipeline.getBindGroupLayout(0));
  }

  static async create(onLost: (info: GPUDeviceLostInfo) => void): Promise<WebGpuTerminalRenderer> {
    if (!navigator.gpu) throw new Error("WebGPU is unavailable");
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) throw new Error("No WebGPU adapter is available");
    const device = await adapter.requestDevice({ label: "Electron Ghostty terminal renderer" });
    device.addEventListener("uncapturederror", (event) => {
      console.error("[terminal-renderer] WebGPU validation error", event.error);
    });
    void device.lost.then((info) => {
      if (info.reason !== "destroyed") onLost(info);
    });
    return new WebGpuTerminalRenderer(device, navigator.gpu.getPreferredCanvasFormat());
  }

  setPerformanceMeasurementEnabled(enabled: boolean): void {
    this.#performanceMeasurementEnabled = enabled;
  }

  mount(id: string, canvas: OffscreenCanvas): void {
    const context = canvas.getContext("webgpu") as GPUCanvasContext | null;
    if (!context) throw new Error("WebGPU canvas context unavailable");
    const sceneTexture = this.#createSceneTexture(canvas.width, canvas.height);
    const surface: WebGpuSurface = {
      canvas,
      context,
      sceneTexture,
      postProcessBindGroup: this.#createPostProcessBindGroup(sceneTexture),
      width: 1,
      height: 1,
      dpr: 1,
      rectangleBuffer: new DynamicVertexBuffer(this.device, `rectangles ${id}`),
      glyphBuffer: new DynamicVertexBuffer(this.device, `glyphs ${id}`),
      colorGlyphBuffer: new DynamicVertexBuffer(this.device, `color glyphs ${id}`),
      fallbackGlyphBuffer: new DynamicVertexBuffer(this.device, `fallback glyphs ${id}`),
    };
    this.#surfaces.set(id, surface);
    this.#configure(surface);
  }

  unmount(id: string): void {
    const surface = this.#surfaces.get(id);
    if (!surface) return;
    surface.context.unconfigure();
    surface.sceneTexture.destroy();
    surface.rectangleBuffer.destroy();
    surface.glyphBuffer.destroy();
    surface.colorGlyphBuffer.destroy();
    surface.fallbackGlyphBuffer.destroy();
    this.#surfaces.delete(id);
  }

  resize(id: string, size: PixelSize): void {
    const surface = this.#surfaces.get(id);
    if (!surface) return;
    if (surface.width === size.width && surface.height === size.height && surface.dpr === size.dpr) return;
    Object.assign(surface, size);
    surface.canvas.width = Math.max(1, Math.round(size.width * size.dpr));
    surface.canvas.height = Math.max(1, Math.round(size.height * size.dpr));
    this.#configure(surface);
  }

  #configure(surface: WebGpuSurface): void {
    surface.context.configure({ device: this.device, format: this.format, alphaMode: "premultiplied" });
    surface.sceneTexture.destroy();
    surface.sceneTexture = this.#createSceneTexture(surface.canvas.width, surface.canvas.height);
    surface.postProcessBindGroup = this.#createPostProcessBindGroup(surface.sceneTexture);
  }

  #createSceneTexture(width: number, height: number): GPUTexture {
    return this.device.createTexture({
      label: "terminal scene before Ghostty custom shaders",
      size: [Math.max(1, width), Math.max(1, height)],
      format: this.format,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
  }

  #createPostProcessBindGroup(texture: GPUTexture): GPUBindGroup {
    return this.device.createBindGroup({
      label: "Ghostty custom shader bindings",
      layout: this.#postProcessPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: texture.createView() },
        { binding: 1, resource: this.#postProcessSampler },
      ],
    });
  }

  render(id: string, view: RenderView): TerminalRenderMetrics | undefined {
    if (!this.#surfaces.has(id)) return;
    const encoder = this.device.createCommandEncoder({ label: `terminal frame ${id}` });
    const metrics = this.#encodeRender(id, view, encoder);
    this.device.queue.submit([encoder.finish()]);
    if (metrics) metrics.queueSubmits = 1;
    return metrics;
  }

  renderBatch(entries: ReadonlyArray<{ id: string; view: RenderView }>): Array<TerminalRenderMetrics | undefined> {
    const active = entries.filter(({ id }) => this.#surfaces.has(id));
    if (active.length === 0) return entries.map(() => undefined);
    const encoder = this.device.createCommandEncoder({ label: `terminal frame batch (${active.length} panes)` });
    const byId = new Map<string, TerminalRenderMetrics | undefined>();
    for (const { id, view } of active) byId.set(id, this.#encodeRender(id, view, encoder));
    this.device.queue.submit([encoder.finish()]);
    const firstMetrics = [...byId.values()].find((metrics) => metrics !== undefined);
    if (firstMetrics) firstMetrics.queueSubmits = 1;
    return entries.map(({ id }) => byId.get(id));
  }

  #encodeRender(id: string, view: RenderView, encoder: GPUCommandEncoder): TerminalRenderMetrics | undefined {
    const surface = this.#surfaces.get(id);
    if (!surface) return;
    const monoUploadsBefore = this.#performanceMeasurementEnabled ? this.#monoAtlas.uploadMetrics() : undefined;
    const colorUploadsBefore = this.#performanceMeasurementEnabled ? this.#colorAtlas.uploadMetrics() : undefined;
    const fallbackUploadsBefore = this.#performanceMeasurementEnabled ? this.#fallbackAtlas.uploadMetrics() : undefined;
    const scale = surface.dpr;
    const viewportWidth = surface.canvas.width;
    const viewportHeight = surface.canvas.height;
    const rectangleVertices: number[] = [];
    const glyphVertices: number[] = [];
    const colorGlyphVertices: number[] = [];
    const fallbackGlyphVertices: number[] = [];
    const monoDefinitions = new Map<number, GlyphDefinition>();
    const colorDefinitions = new Map<number, GlyphDefinition>();
    for (const row of view.nativeRows) {
      for (const glyph of row) {
        const definition = view.glyphDefinitions.get(glyph.glyphId);
        if (!definition) continue;
        (definition.format === GlyphFormat.Rgba8Premultiplied ? colorDefinitions : monoDefinitions).set(
          definition.id,
          definition,
        );
      }
    }
    this.#monoAtlas.prepare(monoDefinitions.values());
    this.#colorAtlas.prepare(colorDefinitions.values());

    for (let row = 0; row < view.nativeStyleRows.length; row += 1) {
      for (const run of view.nativeStyleRows[row] ?? []) {
        const style = resolveStyle(view.styleDefinitions.get(run.styleId), view.theme);
        if (!style.background) continue;
        pushRectangle(
          rectangleVertices,
          (ORIGIN_X + run.cellStart * CELL_WIDTH) * scale,
          (ORIGIN_Y + row * LINE_HEIGHT) * scale,
          run.cellSpan * CELL_WIDTH * scale,
          LINE_HEIGHT * scale,
          style.background,
          viewportWidth,
          viewportHeight,
        );
      }
    }
    const backgroundVertexCount = rectangleVertices.length / 6;

    const selection = ordered(view.selection);
    if (selection) {
      const [start, end] = selection;
      for (let row = start.row; row <= end.row; row += 1) {
        const first = row === start.row ? start.column : 0;
        const last = row === end.row ? end.column : Math.max(0, cellLength(view.rows[row] ?? "") - 1);
        pushRectangle(
          rectangleVertices,
          (ORIGIN_X + first * CELL_WIDTH) * scale,
          (ORIGIN_Y + row * LINE_HEIGHT) * scale,
          Math.max(1, last - first + 1) * CELL_WIDTH * scale,
          LINE_HEIGHT * scale,
          view.theme.selection,
          viewportWidth,
          viewportHeight,
        );
      }
    }
    const selectionVertexCount = rectangleVertices.length / 6 - backgroundVertexCount;

    const hasNativeRows = view.nativeRows.some((row) => row.length > 0);
    if (!hasNativeRows) {
      this.#fallbackAtlas.prepare(view.rows.flatMap(splitGraphemes), scale);
    }
    if (hasNativeRows) {
      for (let row = 0; row < view.nativeRows.length; row += 1) {
        const boxCells = boxDrawingCells(view.rows[row] ?? "");
        const blockCells = blockElementCells(view.rows[row] ?? "");
        for (const instance of view.nativeRows[row] ?? []) {
          const definition = view.glyphDefinitions.get(instance.glyphId);
          if (!definition) continue;
          const style = resolveStyle(view.styleDefinitions.get(instance.styleId), view.theme);
          if (style.invisible) continue;
          const isSelected = selectionContains(selection, row, instance.cellStart);
          const foreground = isSelected ? view.theme.selectionForeground : style.foreground;
          const boxDrawing = boxCells.get(instance.cellStart);
          if (boxDrawing) {
            let backdrop = style.background ?? view.theme.background;
            if (isSelected) backdrop = view.theme.selection;
            // Box glyphs are assembled from several overlapping primitives. Flatten
            // faint opacity against the cell backdrop first so joins are blended once,
            // instead of producing a brighter seam at every cell boundary.
            const boxColor = over(foreground, backdrop);
            pushBoxDrawing(
              rectangleVertices,
              boxDrawing,
              instance.cellStart,
              row,
              scale,
              boxColor,
              viewportWidth,
              viewportHeight,
            );
            continue;
          }
          const blockElement = blockCells.get(instance.cellStart);
          if (blockElement) {
            let backdrop = style.background ?? view.theme.background;
            if (isSelected) backdrop = view.theme.selection;
            const blockColor = over(foreground, backdrop);
            if (
              pushBlockElement(
                rectangleVertices,
                blockElement,
                instance.cellStart,
                row,
                scale,
                blockColor,
                viewportWidth,
                viewportHeight,
              )
            )
              continue;
          }
          const atlas = definition.format === GlyphFormat.Alpha8 ? this.#monoAtlas : this.#colorAtlas;
          const vertices = definition.format === GlyphFormat.Alpha8 ? glyphVertices : colorGlyphVertices;
          pushGlyph(
            vertices,
            (ORIGIN_X + instance.x) * scale,
            (ORIGIN_Y + row * LINE_HEIGHT + instance.y) * scale,
            instance.width * scale,
            instance.height * scale,
            atlas.glyph(definition),
            foreground,
            viewportWidth,
            viewportHeight,
          );
        }
      }
    } else {
      for (let row = 0; row < view.rows.length; row += 1) {
        let column = 0;
        for (const grapheme of splitGraphemes(view.rows[row] ?? "")) {
          const glyph = this.#fallbackAtlas.glyph(grapheme, scale);
          const cells = glyph?.cells ?? graphemeCellWidth(grapheme);
          if (glyph) {
            const foreground = selectionContains(selection, row, column)
              ? view.theme.selectionForeground
              : view.theme.foreground;
            pushGlyph(
              fallbackGlyphVertices,
              (ORIGIN_X + column * CELL_WIDTH) * scale,
              (ORIGIN_Y + row * LINE_HEIGHT) * scale,
              CELL_WIDTH * cells * scale,
              LINE_HEIGHT * scale,
              glyph,
              foreground,
              viewportWidth,
              viewportHeight,
            );
          }
          column += cells;
        }
      }
    }

    for (let row = 0; row < view.nativeStyleRows.length; row += 1) {
      for (const run of view.nativeStyleRows[row] ?? []) {
        const style = resolveStyle(view.styleDefinitions.get(run.styleId), view.theme);
        if (style.invisible) continue;
        const x = (ORIGIN_X + run.cellStart * CELL_WIDTH) * scale;
        const width = run.cellSpan * CELL_WIDTH * scale;
        const rowTop = (ORIGIN_Y + row * LINE_HEIGHT) * scale;
        const stroke = Math.max(1, Math.round(scale));
        if (style.underline) {
          pushRectangle(
            rectangleVertices,
            x,
            Math.round(rowTop + 16 * scale),
            width,
            stroke,
            style.foreground,
            viewportWidth,
            viewportHeight,
          );
        }
        if (style.strikethrough) {
          pushRectangle(
            rectangleVertices,
            x,
            Math.round(rowTop + 9 * scale),
            width,
            stroke,
            style.foreground,
            viewportWidth,
            viewportHeight,
          );
        }
      }
    }
    const decorationVertexStart = backgroundVertexCount + selectionVertexCount;
    const decorationVertexCount = rectangleVertices.length / 6 - decorationVertexStart;

    const cursorStyle = effectiveCursorStyle(view);
    if (cursorStyle !== null) {
      const x = (ORIGIN_X + view.cursor.x * CELL_WIDTH) * scale;
      const y = (ORIGIN_Y + view.cursor.y * LINE_HEIGHT) * scale;
      const width = CELL_WIDTH * scale;
      const height = LINE_HEIGHT * scale;
      const stroke = Math.max(1, Math.round(scale));
      const cursorColor: Rgba =
        cursorStyle === CursorStyle.HollowBlock
          ? [view.theme.cursor[0], view.theme.cursor[1], view.theme.cursor[2], 1]
          : view.theme.cursor;
      if (cursorStyle === CursorStyle.Bar) {
        pushRectangle(
          rectangleVertices,
          x,
          y,
          Math.max(2, Math.round(2 * scale)),
          height,
          cursorColor,
          viewportWidth,
          viewportHeight,
        );
      } else if (cursorStyle === CursorStyle.Underline) {
        const thickness = Math.max(2, Math.round(2 * scale));
        pushRectangle(
          rectangleVertices,
          x,
          y + height - thickness,
          width,
          thickness,
          cursorColor,
          viewportWidth,
          viewportHeight,
        );
      } else if (cursorStyle === CursorStyle.HollowBlock) {
        pushRectangle(rectangleVertices, x, y, width, stroke, cursorColor, viewportWidth, viewportHeight);
        pushRectangle(
          rectangleVertices,
          x,
          y + height - stroke,
          width,
          stroke,
          cursorColor,
          viewportWidth,
          viewportHeight,
        );
        pushRectangle(
          rectangleVertices,
          x,
          y + stroke,
          stroke,
          Math.max(0, height - stroke * 2),
          cursorColor,
          viewportWidth,
          viewportHeight,
        );
        pushRectangle(
          rectangleVertices,
          x + width - stroke,
          y + stroke,
          stroke,
          Math.max(0, height - stroke * 2),
          cursorColor,
          viewportWidth,
          viewportHeight,
        );
      } else {
        pushRectangle(rectangleVertices, x, y, width, height, cursorColor, viewportWidth, viewportHeight);
      }
    }
    const rectangleData = new Float32Array(rectangleVertices);
    const glyphData = new Float32Array(glyphVertices);
    const colorGlyphData = new Float32Array(colorGlyphVertices);
    const fallbackGlyphData = new Float32Array(fallbackGlyphVertices);
    const rectangleBuffer = surface.rectangleBuffer.write(rectangleData);
    const glyphBuffer = surface.glyphBuffer.write(glyphData);
    const colorGlyphBuffer = surface.colorGlyphBuffer.write(colorGlyphData);
    const fallbackGlyphBuffer = surface.fallbackGlyphBuffer.write(fallbackGlyphData);
    const cursorVertexStart = decorationVertexStart + decorationVertexCount;
    const cursorVertexCount = rectangleVertices.length / 6 - cursorVertexStart;

    const pass = encoder.beginRenderPass({
      label: `terminal pass ${id}`,
      colorAttachments: [
        {
          view: surface.sceneTexture.createView(),
          clearValue: {
            r: view.theme.background[0],
            g: view.theme.background[1],
            b: view.theme.background[2],
            a: view.theme.background[3],
          },
          loadOp: "clear",
          storeOp: "store",
        },
      ],
    });
    if (rectangleBuffer && backgroundVertexCount > 0) {
      pass.setPipeline(this.#rectanglePipeline);
      pass.setVertexBuffer(0, rectangleBuffer);
      pass.draw(backgroundVertexCount);
    }
    if (rectangleBuffer && selectionVertexCount > 0) {
      pass.setPipeline(this.#rectanglePipeline);
      pass.setVertexBuffer(0, rectangleBuffer);
      pass.draw(selectionVertexCount, 1, backgroundVertexCount);
    }
    if (glyphBuffer && glyphData.length > 0) {
      pass.setPipeline(this.#glyphPipeline);
      pass.setBindGroup(0, this.#monoAtlas.bindGroup);
      pass.setVertexBuffer(0, glyphBuffer);
      pass.draw(glyphVertices.length / 8);
    }
    if (colorGlyphBuffer && colorGlyphData.length > 0) {
      pass.setPipeline(this.#colorGlyphPipeline);
      pass.setBindGroup(0, this.#colorAtlas.bindGroup);
      pass.setVertexBuffer(0, colorGlyphBuffer);
      pass.draw(colorGlyphVertices.length / 8);
    }
    if (fallbackGlyphBuffer && fallbackGlyphData.length > 0) {
      pass.setPipeline(this.#glyphPipeline);
      pass.setBindGroup(0, this.#fallbackAtlas.bindGroup);
      pass.setVertexBuffer(0, fallbackGlyphBuffer);
      pass.draw(fallbackGlyphVertices.length / 8);
    }
    if (rectangleBuffer && decorationVertexCount > 0) {
      pass.setPipeline(this.#rectanglePipeline);
      pass.setVertexBuffer(0, rectangleBuffer);
      pass.draw(decorationVertexCount, 1, decorationVertexStart);
    }
    if (rectangleBuffer && cursorVertexCount > 0) {
      pass.setPipeline(this.#rectanglePipeline);
      pass.setVertexBuffer(0, rectangleBuffer);
      pass.draw(cursorVertexCount, 1, cursorVertexStart);
    }
    pass.end();

    const postProcessPass = encoder.beginRenderPass({
      label: `Ghostty custom shader pass ${id}`,
      colorAttachments: [
        {
          view: surface.context.getCurrentTexture().createView(),
          clearValue: {
            r: view.theme.background[0],
            g: view.theme.background[1],
            b: view.theme.background[2],
            a: 1,
          },
          loadOp: "clear",
          storeOp: "store",
        },
      ],
    });
    postProcessPass.setPipeline(this.#postProcessPipeline);
    postProcessPass.setBindGroup(0, surface.postProcessBindGroup);
    postProcessPass.draw(3);
    postProcessPass.end();
    if (!this.#performanceMeasurementEnabled) return undefined;
    const monoUploadsAfter = this.#monoAtlas.uploadMetrics();
    const colorUploadsAfter = this.#colorAtlas.uploadMetrics();
    const fallbackUploadsAfter = this.#fallbackAtlas.uploadMetrics();
    return {
      queueSubmits: 0,
      canvasPixels: viewportWidth * viewportHeight,
      renderPasses: 2,
      drawCalls:
        Number(backgroundVertexCount > 0) +
        Number(selectionVertexCount > 0) +
        Number(glyphData.length > 0) +
        Number(colorGlyphData.length > 0) +
        Number(fallbackGlyphData.length > 0) +
        Number(decorationVertexCount > 0) +
        Number(cursorVertexCount > 0) +
        1,
      rectangleVertices: rectangleVertices.length / 6,
      monoGlyphVertices: glyphVertices.length / 8,
      colorGlyphVertices: colorGlyphVertices.length / 8,
      fallbackGlyphVertices: fallbackGlyphVertices.length / 8,
      vertexUploadBytes:
        rectangleData.byteLength + glyphData.byteLength + colorGlyphData.byteLength + fallbackGlyphData.byteLength,
      atlasUploadBytes:
        monoUploadsAfter.bytes -
        monoUploadsBefore!.bytes +
        (colorUploadsAfter.bytes - colorUploadsBefore!.bytes) +
        (fallbackUploadsAfter.bytes - fallbackUploadsBefore!.bytes),
      atlasUploadCalls:
        monoUploadsAfter.calls -
        monoUploadsBefore!.calls +
        (colorUploadsAfter.calls - colorUploadsBefore!.calls) +
        (fallbackUploadsAfter.calls - fallbackUploadsBefore!.calls),
    };
  }

  settle(): Promise<void> {
    return this.device.queue.onSubmittedWorkDone();
  }

  destroy(): void {
    for (const id of [...this.#surfaces.keys()]) this.unmount(id);
    this.#monoAtlas.destroy();
    this.#colorAtlas.destroy();
    this.#fallbackAtlas.destroy();
    this.device.destroy();
  }
}
