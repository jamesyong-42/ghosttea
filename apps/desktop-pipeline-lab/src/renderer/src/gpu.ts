/// <reference types="@webgpu/types" />

import type { SlotLayout, ViewMountSpec } from "../../shared/messages";
import {
  clampConfig,
  emptyWorkerCounters,
  fitGrid,
  fitRect,
  gridNativeSize,
  type FitMode,
  type LabConfig,
  type WorkerCounters,
} from "../../shared/model";

const ATLAS_COLS = 16;
const ATLAS_ROWS = 8;
const GLYPH_W = 8;
const GLYPH_H = 16;
const ATLAS_W = ATLAS_COLS * GLYPH_W;
const ATLAS_H = ATLAS_ROWS * GLYPH_H;
const INSTANCE_FLOATS = 12;
const UNIFORM_BYTES = 64;

const CELL_SHADER = /* wgsl */ `
struct Uniforms {
  viewport: vec2f,
  cell: vec2f,
  origin: vec2f,
  cursor: vec2f,
  cursor_on: f32,
  time: f32,
}

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var atlas: texture_2d<f32>;
@group(0) @binding(2) var atlas_sampler: sampler;

struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
  @location(1) fg: vec4f,
  @location(2) bg: vec4f,
}

@vertex fn vertex_main(
  @builtin(vertex_index) vertex_index: u32,
  @location(0) cell: vec2f,
  @location(1) uv_bounds: vec4f,
  @location(2) fg: vec3f,
  @location(3) bg: vec3f,
) -> VertexOutput {
  let corners = array<vec2f, 6>(
    vec2f(0.0, 0.0), vec2f(1.0, 0.0), vec2f(0.0, 1.0),
    vec2f(0.0, 1.0), vec2f(1.0, 0.0), vec2f(1.0, 1.0),
  );
  let corner = corners[vertex_index];
  let pixel = uniforms.origin + (cell + corner) * uniforms.cell;
  let clip = vec2f(pixel.x / uniforms.viewport.x * 2.0 - 1.0, 1.0 - pixel.y / uniforms.viewport.y * 2.0);
  var output: VertexOutput;
  output.position = vec4f(clip, 0.0, 1.0);
  output.uv = mix(uv_bounds.xy, uv_bounds.zw, corner);
  output.fg = vec4f(fg, 1.0);
  output.bg = vec4f(bg, 1.0);
  return output;
}

@fragment fn fragment_main(input: VertexOutput) -> @location(0) vec4f {
  let coverage = textureSample(atlas, atlas_sampler, input.uv).r;
  let color = mix(input.bg, input.fg, coverage);
  return vec4f(color.rgb * color.a, color.a);
}
`;

const FILL_SHADER = /* wgsl */ `
struct Fill {
  color: vec4f,
  rect: vec4f,
  viewport: vec2f,
  _pad: vec2f,
}

@group(0) @binding(0) var<uniform> fill: Fill;

@vertex fn vertex_main(@builtin(vertex_index) vertex_index: u32) -> @builtin(position) vec4f {
  let corners = array<vec2f, 6>(
    vec2f(0.0, 0.0), vec2f(1.0, 0.0), vec2f(0.0, 1.0),
    vec2f(0.0, 1.0), vec2f(1.0, 0.0), vec2f(1.0, 1.0),
  );
  let corner = corners[vertex_index];
  let pixel = fill.rect.xy + corner * fill.rect.zw;
  return vec4f(pixel.x / fill.viewport.x * 2.0 - 1.0, 1.0 - pixel.y / fill.viewport.y * 2.0, 0.0, 1.0);
}

@fragment fn fragment_main() -> @location(0) vec4f {
  return vec4f(fill.color.rgb * fill.color.a, fill.color.a);
}
`;

const BLIT_SHADER = /* wgsl */ `
struct Blit {
  rect: vec4f,
  viewport: vec2f,
  time: f32,
  effect: f32,
}

@group(0) @binding(0) var<uniform> blit: Blit;
@group(0) @binding(1) var source: texture_2d<f32>;
@group(0) @binding(2) var source_sampler: sampler;

struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
}

@vertex fn vertex_main(@builtin(vertex_index) vertex_index: u32) -> VertexOutput {
  let corners = array<vec2f, 6>(
    vec2f(0.0, 0.0), vec2f(1.0, 0.0), vec2f(0.0, 1.0),
    vec2f(0.0, 1.0), vec2f(1.0, 0.0), vec2f(1.0, 1.0),
  );
  let corner = corners[vertex_index];
  let pixel = blit.rect.xy + corner * blit.rect.zw;
  var output: VertexOutput;
  output.position = vec4f(pixel.x / blit.viewport.x * 2.0 - 1.0, 1.0 - pixel.y / blit.viewport.y * 2.0, 0.0, 1.0);
  output.uv = corner;
  return output;
}

@fragment fn fragment_main(input: VertexOutput) -> @location(0) vec4f {
  var color = textureSample(source, source_sampler, input.uv);
  if (blit.effect > 0.5) {
    let scan = 0.88 + 0.12 * sin(input.uv.y * blit.viewport.y * 3.14159);
    let roll = 0.04 * sin(input.uv.y * 40.0 + blit.time * 6.0);
    color = vec4f(color.rgb * scan + roll, color.a);
  }
  return color;
}
`;

function premultiplied(): GPUBlendState {
  return {
    color: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
    alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
  };
}

function hsl(h: number, s: number, l: number, a = 1): [number, number, number, number] {
  const sat = s / 100;
  const lig = l / 100;
  const k = (n: number) => (n + h / 30) % 12;
  const q = sat * Math.min(lig, 1 - lig);
  const f = (n: number) => lig - q * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0), f(8), f(4), a];
}

const FONT_5X7: readonly string[] = [
  "01110100011001110101110011000101110",
  "00100011000010000100001000010001110",
  "01110100010000100010001000100011111",
  "01110100010000100110000011000101110",
  "00010001100101010010111110001000010",
  "11111100001111000001000011000101110",
  "00110010001000011110100011000101110",
  "11111000010001000100001000010000100",
  "01110100011000101110100011000101110",
  "01110100011000101111000010001001100",
  "01110100011111110001100011000110001",
  "11110100011111010001100011000111110",
  "01110100011000010000100001000101110",
  "11110100011000110001100011000111110",
  "11111100001110010000100001000011111",
  "11111100001110010000100001000010000",
  "01110100011000010011100011000101111",
  "10001100011111110001100011000110001",
  "01110001000010000100001000010001110",
  "00111000100001000010000101001001100",
  "10001100101010011000101001001010001",
  "10000100001000010000100001000011111",
  "10001110111010110101100011000110001",
  "10001110011100110101100111000110001",
  "01110100011000110001100011000101110",
  "11110100011000111110100001000010000",
  "01110100011000110001101011001001101",
  "11110100011000111110101001001010001",
  "01111100000111000001000011000111110",
  "11111001000010000100001000010000100",
  "10001100011000110001100011000101110",
  "10001100011000110001100010101000100",
  "10001100011000110101101011010101010",
  "10001100010101000100010101000110001",
  "10001100010101000100001000010000100",
  "11111000010001000100010001000011111",
];

function paintGlyph(data: Uint8Array, glyph: number, bits: string, fill = false): void {
  const originX = (glyph % ATLAS_COLS) * GLYPH_W;
  const originY = Math.floor(glyph / ATLAS_COLS) * GLYPH_H;
  if (fill) {
    for (let y = 1; y < GLYPH_H - 1; y += 1) {
      for (let x = 1; x < GLYPH_W - 1; x += 1) data[(originY + y) * ATLAS_W + originX + x] = 255;
    }
    return;
  }
  for (let y = 0; y < 7; y += 1) {
    for (let x = 0; x < 5; x += 1) {
      if (bits[y * 5 + x] === "1") data[(originY + 4 + y) * ATLAS_W + originX + 1 + x] = 255;
    }
  }
}

function buildAtlasBytes(): Uint8Array {
  const data = new Uint8Array(ATLAS_W * ATLAS_H);
  for (let digit = 0; digit < 10; digit += 1) paintGlyph(data, digit, FONT_5X7[digit]!);
  for (let letter = 0; letter < 26; letter += 1) paintGlyph(data, 10 + letter, FONT_5X7[10 + letter]!);
  paintGlyph(data, 37, "", true);
  return data;
}

function cellGlyph(col: number, row: number, generation: number, sessionIndex: number): number {
  if (col === 0) return Math.floor(row / 10) % 10;
  if (col === 1) return row % 10;
  if (col === 2) return 36;
  return 10 + ((col + row * 3 + generation + sessionIndex) % 26);
}

class GrowBuffer {
  buffer: GPUBuffer;
  capacity: number;

  constructor(
    private readonly device: GPUDevice,
    private readonly label: string,
    private readonly usage: GPUBufferUsageFlags,
    bytes: number,
  ) {
    this.capacity = Math.max(256, bytes);
    this.buffer = device.createBuffer({ label, size: this.capacity, usage });
  }

  write(data: ArrayBufferView): GPUBuffer {
    const bytes = data.byteLength;
    if (bytes > this.capacity) {
      this.buffer.destroy();
      this.capacity = Math.max(bytes, this.capacity * 2);
      this.buffer = this.device.createBuffer({ label: this.label, size: this.capacity, usage: this.usage });
    }
    if (bytes > 0) this.device.queue.writeBuffer(this.buffer, 0, data);
    return this.buffer;
  }

  destroy(): void {
    this.buffer.destroy();
  }
}

interface GpuHub {
  device: GPUDevice;
  format: GPUTextureFormat;
  cellPipeline: GPURenderPipeline;
  fillPipeline: GPURenderPipeline;
  blitPipeline: GPURenderPipeline;
  sampler: GPUSampler;
  atlas: GPUTexture;
  atlasView: GPUTextureView;
  cellLayout: GPUBindGroupLayout;
  fillLayout: GPUBindGroupLayout;
  blitLayout: GPUBindGroupLayout;
}

interface SessionGpu {
  id: string;
  index: number;
  texture: GPUTexture;
  view: GPUTextureView;
  width: number;
  height: number;
  instance: GrowBuffer;
  cellUniform: GPUBuffer;
  fillUniform: GPUBuffer;
  cellBind: GPUBindGroup;
  fillBind: GPUBindGroup;
  generation: number;
  cursor: { x: number; y: number; on: boolean };
  dirtyRows: Set<number>;
  full: boolean;
  device: GPUDevice;
}

interface SlotGpu {
  blitUniform: GPUBuffer;
  fillUniform: GPUBuffer;
  blitBind: GPUBindGroup | undefined;
  fillBind: GPUBindGroup;
}

interface ViewGpu {
  id: string;
  sessionId: string;
  role: "authority" | "mirror";
  canvas: OffscreenCanvas;
  context: GPUCanvasContext | ImageBitmapRenderingContext;
  bitmap: boolean;
  width: number;
  height: number;
  dpr: number;
  blitUniform: GPUBuffer | undefined;
  blitBind: GPUBindGroup | undefined;
  fillUniform: GPUBuffer | undefined;
  fillBind: GPUBindGroup | undefined;
  hub: GpuHub;
  localScene: SessionGpu | undefined;
}

function createTexture(
  device: GPUDevice,
  format: GPUTextureFormat,
  width: number,
  height: number,
  label: string,
): GPUTexture {
  return device.createTexture({
    label,
    size: [Math.max(1, width), Math.max(1, height)],
    format,
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC,
  });
}

export class PipelineEngine {
  config: LabConfig = clampConfig({
    architecture: "shared-scene",
    sceneResolution: "grid-native",
    effectScope: "off",
    devicePerView: false,
    sessions: 1,
    viewsPerSession: 1,
    cols: 80,
    rows: 24,
    cellWidth: 8,
    cellHeight: 16,
    layout: "grid",
    workload: "hold",
    hz: 60,
  });
  counters = emptyWorkerCounters();
  adapterName = "unknown";
  #shared: GpuHub | undefined;
  #sessions = new Map<string, SessionGpu>();
  #views = new Map<string, ViewGpu>();
  #slots = new Map<string, SlotLayout>();
  #stage:
    { canvas: OffscreenCanvas; context: GPUCanvasContext; width: number; height: number; dpr: number } | undefined;
  #scratch: { canvas: OffscreenCanvas; context: GPUCanvasContext; width: number; height: number } | undefined;
  #slotGpu = new Map<string, SlotGpu>();
  #lastFlushAt = 0;
  #tick = 0;

  async init(): Promise<string> {
    this.#shared ??= await this.#createHub("shared");
    return this.adapterName;
  }

  async configure(config: LabConfig): Promise<void> {
    this.config = clampConfig(config);
    this.resetSurfaces();
    this.#sessions.clear();
    this.#tick = 0;
  }

  resetSurfaces(): void {
    for (const session of this.#sessions.values()) this.#destroySession(session);
    this.#sessions.clear();
    for (const view of this.#views.values()) this.#destroyView(view);
    this.#views.clear();
    for (const slot of this.#slotGpu.values()) {
      slot.blitUniform.destroy();
      slot.fillUniform.destroy();
    }
    this.#slotGpu.clear();
    this.#stage = undefined;
    if (this.#scratch) {
      this.#scratch.canvas.width = 1;
      this.#scratch = undefined;
    }
    this.counters.canvasContexts = 0;
    this.counters.sceneTextures = 0;
    this.counters.devices = this.#shared ? 1 : 0;
  }

  mountStage(canvas: OffscreenCanvas, width: number, height: number, dpr: number): void {
    const hub = this.#requireHub();
    const context = canvas.getContext("webgpu");
    if (!context) throw new Error("WebGPU stage context unavailable");
    canvas.width = Math.max(1, Math.round(width * dpr));
    canvas.height = Math.max(1, Math.round(height * dpr));
    context.configure({ device: hub.device, format: hub.format, alphaMode: "opaque" });
    this.#stage = { canvas, context, width: canvas.width, height: canvas.height, dpr };
    this.counters.canvasContexts += 1;
  }

  async mountViews(specs: readonly ViewMountSpec[], canvases: readonly OffscreenCanvas[]): Promise<void> {
    if (specs.length !== canvases.length) throw new Error("view mount length mismatch");
    for (let index = 0; index < specs.length; index += 1) {
      const spec = specs[index]!;
      const canvas = canvases[index]!;
      const hub =
        this.config.devicePerView && spec.role === "authority"
          ? await this.#createHub(`view-${spec.viewId}`)
          : this.config.devicePerView
            ? await this.#createHub(`view-${spec.viewId}`)
            : this.#requireHub();
      const width = Math.max(1, Math.round(spec.width * spec.dpr));
      const height = Math.max(1, Math.round(spec.height * spec.dpr));
      canvas.width = width;
      canvas.height = height;
      const bitmap = spec.bitmap && spec.role === "mirror";
      if (bitmap) {
        const context = canvas.getContext("bitmaprenderer");
        if (!context) throw new Error("bitmaprenderer unavailable");
        this.#views.set(spec.viewId, {
          id: spec.viewId,
          sessionId: spec.sessionId,
          role: spec.role,
          canvas,
          context,
          bitmap: true,
          width,
          height,
          dpr: spec.dpr,
          blitUniform: undefined,
          blitBind: undefined,
          fillUniform: undefined,
          fillBind: undefined,
          hub,
          localScene: undefined,
        });
      } else {
        const context = canvas.getContext("webgpu");
        if (!context) throw new Error("WebGPU view context unavailable");
        context.configure({ device: hub.device, format: hub.format, alphaMode: "opaque" });
        const view: ViewGpu = {
          id: spec.viewId,
          sessionId: spec.sessionId,
          role: spec.role,
          canvas,
          context,
          bitmap: false,
          width,
          height,
          dpr: spec.dpr,
          blitUniform: hub.device.createBuffer({
            label: `blit ${spec.viewId}`,
            size: UNIFORM_BYTES,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
          }),
          blitBind: undefined,
          fillUniform: hub.device.createBuffer({
            label: `clear ${spec.viewId}`,
            size: UNIFORM_BYTES,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
          }),
          fillBind: undefined,
          hub,
          localScene: undefined,
        };
        view.fillBind = hub.device.createBindGroup({
          layout: hub.fillLayout,
          entries: [{ binding: 0, resource: { buffer: view.fillUniform! } }],
        });
        this.#views.set(spec.viewId, view);
      }
      this.counters.canvasContexts += 1;
      if (this.config.architecture === "per-view-scene" || this.config.devicePerView) {
        const sceneSize =
          this.config.sceneResolution === "view"
            ? { width, height }
            : this.#sceneSizeForSession(spec.sessionId, spec.sessionIndex);
        const local = this.#createSessionGpu(hub, spec.sessionId, spec.sessionIndex, sceneSize.width, sceneSize.height);
        this.#views.get(spec.viewId)!.localScene = local;
      }
    }
    this.#ensureSessions();
    this.#invalidateAll();
  }

  layout(slots: readonly SlotLayout[], stageWidth: number, stageHeight: number, stageDpr: number): void {
    this.#slots.clear();
    for (const slot of slots) this.#slots.set(slot.viewId, slot);
    if (this.#stage) {
      const width = Math.max(1, Math.round(stageWidth * stageDpr));
      const height = Math.max(1, Math.round(stageHeight * stageDpr));
      if (this.#stage.canvas.width !== width || this.#stage.canvas.height !== height) {
        this.#stage.canvas.width = width;
        this.#stage.canvas.height = height;
        this.#stage.context.configure({
          device: this.#requireHub().device,
          format: this.#requireHub().format,
          alphaMode: "opaque",
        });
      }
      this.#stage.width = width;
      this.#stage.height = height;
      this.#stage.dpr = stageDpr;
    }
    this.#invalidateAll();
  }

  resizeView(viewId: string, width: number, height: number, dpr: number): void {
    const view = this.#views.get(viewId);
    if (!view) return;
    const nextW = Math.max(1, Math.round(width * dpr));
    const nextH = Math.max(1, Math.round(height * dpr));
    if (view.width === nextW && view.height === nextH && view.dpr === dpr) return;
    view.width = nextW;
    view.height = nextH;
    view.dpr = dpr;
    view.canvas.width = nextW;
    view.canvas.height = nextH;
    if (!view.bitmap) {
      (view.context as GPUCanvasContext).configure({
        device: view.hub.device,
        format: view.hub.format,
        alphaMode: "opaque",
      });
    }
    if (view.localScene && this.config.sceneResolution === "view") {
      this.#resizeSession(view.hub, view.localScene, nextW, nextH);
    }
    const session = this.#sessions.get(view.sessionId);
    if (session && view.role === "authority" && this.config.sceneResolution === "authority") {
      this.#resizeSession(this.#requireHub(), session, nextW, nextH);
    }
    this.#invalidateSession(view.sessionId);
  }

  tick(now: number): void {
    const { workload } = this.config;
    this.#tick += 1;
    const mutate = (session: SessionGpu, full: boolean, rows: Iterable<number>): void => {
      if (full) {
        session.full = true;
        session.dirtyRows.clear();
        session.generation += 1;
      } else {
        for (const row of rows) session.dirtyRows.add(row);
      }
    };

    const targets = this.#sessionTargets();
    for (const session of targets) {
      if (workload === "hold") continue;
      if (workload === "repaint") continue;
      if (workload === "blink") {
        session.cursor.on = Math.floor(now / 500) % 2 === 0;
        mutate(session, false, [session.cursor.y]);
        continue;
      }
      if (workload === "sparse") {
        session.cursor.x = this.#tick % this.config.cols;
        session.cursor.y = Math.floor(this.#tick / 7) % this.config.rows;
        session.generation += 1;
        mutate(session, false, [session.cursor.y]);
        continue;
      }
      if (workload === "flood") {
        session.cursor.x = this.#tick % this.config.cols;
        mutate(session, true, []);
        continue;
      }
      session.generation += 1;
      session.cursor.y = this.#tick % this.config.rows;
      mutate(session, true, []);
    }
  }

  async flush(now: number): Promise<void> {
    if (this.#lastFlushAt > 0) this.counters.flushIntervalsMs.push(now - this.#lastFlushAt);
    this.#lastFlushAt = now;
    const started = performance.now();
    this.counters.flushes += 1;

    if (this.config.architecture === "window-composite") {
      await this.#flushWindow(now);
    } else if (this.config.architecture === "bitmap-mirrors") {
      await this.#flushBitmap(now);
    } else if (this.config.architecture === "per-view-scene") {
      this.#flushPerView(now);
    } else {
      this.#flushShared(now);
    }

    this.counters.renderCpuMs.push(performance.now() - started);
    if (this.counters.renderCpuMs.length > 4_000)
      this.counters.renderCpuMs.splice(0, this.counters.renderCpuMs.length - 2_000);
    if (this.counters.flushIntervalsMs.length > 4_000) {
      this.counters.flushIntervalsMs.splice(0, this.counters.flushIntervalsMs.length - 2_000);
    }
  }

  snapshotAndReset(durationMs: number): WorkerCounters {
    const snapshot = {
      ...this.counters,
      renderCpuMs: [...this.counters.renderCpuMs],
      flushIntervalsMs: [...this.counters.flushIntervalsMs],
    };
    const resources = {
      devices: this.counters.devices,
      sceneTextures: this.counters.sceneTextures,
      canvasContexts: this.counters.canvasContexts,
    };
    this.counters = emptyWorkerCounters();
    this.counters.devices = resources.devices;
    this.counters.sceneTextures = resources.sceneTextures;
    this.counters.canvasContexts = resources.canvasContexts;
    void durationMs;
    return snapshot;
  }

  needsContinuousPresent(): boolean {
    return this.config.workload !== "hold" || this.config.effectScope !== "off";
  }

  #sessionTargets(): SessionGpu[] {
    if (this.config.architecture === "per-view-scene" || this.config.devicePerView) {
      return [...this.#views.values()].flatMap((view) => (view.localScene ? [view.localScene] : []));
    }
    return [...this.#sessions.values()];
  }

  #ensureSessions(): void {
    if (this.config.architecture === "per-view-scene" || this.config.devicePerView) return;
    const hub = this.#requireHub();
    const views = [...this.#views.values()];
    const sessionIds = new Set(views.map((view) => view.sessionId));
    if (this.config.architecture === "window-composite") {
      for (const slot of this.#slots.values()) sessionIds.add(slot.viewId.split(":")[0] ?? slot.viewId);
    }
    const unique = new Set<string>();
    for (const view of views) unique.add(view.sessionId);
    if (unique.size === 0) {
      const count = this.config.sessions;
      for (let index = 0; index < count; index += 1) unique.add(`s${index}`);
    }
    for (const [index, sessionId] of [...unique].entries()) {
      if (this.#sessions.has(sessionId)) continue;
      const size = this.#sceneSizeForSession(sessionId, index);
      this.#sessions.set(sessionId, this.#createSessionGpu(hub, sessionId, index, size.width, size.height));
    }
    this.#rebindViewBlits();
  }

  #sceneSizeForSession(sessionId: string, sessionIndex: number): { width: number; height: number } {
    if (this.config.sceneResolution === "grid-native") {
      const authority = [...this.#views.values()].find(
        (view) => view.sessionId === sessionId && view.role === "authority",
      );
      const dpr = authority?.dpr ?? this.#stage?.dpr ?? 2;
      return gridNativeSize(this.config, dpr);
    }
    if (this.config.sceneResolution === "authority") {
      const authority = [...this.#views.values()].find(
        (view) => view.sessionId === sessionId && view.role === "authority",
      );
      if (authority) return { width: authority.width, height: authority.height };
      const slot = [...this.#slots.values()].find((candidate) => candidate.viewId.startsWith(`${sessionId}:`));
      if (slot)
        return {
          width: Math.max(1, Math.round(slot.width * slot.dpr)),
          height: Math.max(1, Math.round(slot.height * slot.dpr)),
        };
    }
    void sessionIndex;
    return gridNativeSize(this.config, 2);
  }

  #rebindViewBlits(): void {
    for (const view of this.#views.values()) {
      if (view.bitmap || !view.blitUniform) continue;
      const session = view.localScene ?? this.#sessions.get(view.sessionId);
      if (!session) continue;
      view.blitBind = view.hub.device.createBindGroup({
        layout: view.hub.blitLayout,
        entries: [
          { binding: 0, resource: { buffer: view.blitUniform } },
          { binding: 1, resource: session.view },
          { binding: 2, resource: view.hub.sampler },
        ],
      });
    }
  }

  #flushPerView(now: number): void {
    const submitted = new Set<GPUDevice>();
    for (const view of this.#views.values()) {
      const session = view.localScene;
      if (!session || view.bitmap) continue;
      const encoder = view.hub.device.createCommandEncoder({ label: `per-view ${view.id}` });
      this.#encodeScene(view.hub, encoder, session, now);
      this.#encodePresent(
        view.hub,
        encoder,
        view,
        session,
        now,
        { x: 0, y: 0, width: view.width, height: view.height },
        this.#presentFit(view, session),
      );
      view.hub.device.queue.submit([encoder.finish()]);
      submitted.add(view.hub.device);
    }
    this.counters.queueSubmits += submitted.size;
  }

  #flushShared(now: number): void {
    const hub = this.#requireHub();
    const encoder = hub.device.createCommandEncoder({ label: "shared-scene flush" });
    for (const session of this.#sessions.values()) this.#encodeScene(hub, encoder, session, now);
    for (const view of this.#views.values()) {
      const session = this.#sessions.get(view.sessionId);
      if (!session || view.bitmap) continue;
      this.#encodePresent(
        hub,
        encoder,
        view,
        session,
        now,
        { x: 0, y: 0, width: view.width, height: view.height },
        this.#presentFit(view, session),
      );
    }
    hub.device.queue.submit([encoder.finish()]);
    this.counters.queueSubmits += 1;
  }

  async #flushWindow(now: number): Promise<void> {
    const hub = this.#requireHub();
    const stage = this.#stage;
    if (!stage) return;
    this.#ensureSessionsFromSlots();
    const encoder = hub.device.createCommandEncoder({ label: "window-composite flush" });
    for (const session of this.#sessions.values()) this.#encodeScene(hub, encoder, session, now);
    const target = stage.context.getCurrentTexture().createView();
    this.counters.swapchainAcquires += 1;
    this.#encodeFill(
      hub,
      encoder,
      target,
      stage.width,
      stage.height,
      [0.06, 0.065, 0.05, 1],
      {
        x: 0,
        y: 0,
        width: stage.width,
        height: stage.height,
      },
      undefined,
      "stage",
    );
    for (const slot of this.#slots.values()) {
      const sessionId = slot.viewId.split(":")[0] ?? "s0";
      const session = this.#sessions.get(sessionId);
      if (!session) continue;
      const dest = {
        x: slot.x * slot.dpr,
        y: slot.y * slot.dpr,
        width: slot.width * slot.dpr,
        height: slot.height * slot.dpr,
      };
      this.#encodeBlitTo(
        hub,
        encoder,
        target,
        session,
        stage.width,
        stage.height,
        dest,
        "letterbox",
        now,
        undefined,
        slot.viewId,
      );
    }
    hub.device.queue.submit([encoder.finish()]);
    this.counters.queueSubmits += 1;
  }

  async #flushBitmap(now: number): Promise<void> {
    const hub = this.#requireHub();
    const encoder = hub.device.createCommandEncoder({ label: "bitmap flush" });
    for (const session of this.#sessions.values()) this.#encodeScene(hub, encoder, session, now);
    for (const view of this.#views.values()) {
      if (view.bitmap) continue;
      const session = this.#sessions.get(view.sessionId);
      if (!session) continue;
      this.#encodePresent(
        hub,
        encoder,
        view,
        session,
        now,
        { x: 0, y: 0, width: view.width, height: view.height },
        "stretch",
      );
    }
    hub.device.queue.submit([encoder.finish()]);
    this.counters.queueSubmits += 1;
    await hub.device.queue.onSubmittedWorkDone();

    for (const view of this.#views.values()) {
      if (!view.bitmap) continue;
      const session = this.#sessions.get(view.sessionId);
      if (!session) continue;
      const scratch = this.#ensureScratch(hub, session.width, session.height);
      const copy = hub.device.createCommandEncoder({ label: `bitmap copy ${view.id}` });
      this.#encodeBlitTo(
        hub,
        copy,
        scratch.context.getCurrentTexture().createView(),
        session,
        scratch.width,
        scratch.height,
        { x: 0, y: 0, width: scratch.width, height: scratch.height },
        "stretch",
        now,
        undefined,
        `scratch:${view.id}`,
      );
      this.counters.swapchainAcquires += 1;
      hub.device.queue.submit([copy.finish()]);
      this.counters.queueSubmits += 1;
      await hub.device.queue.onSubmittedWorkDone();
      const bitmap = await createImageBitmap(scratch.canvas);
      (view.context as ImageBitmapRenderingContext).transferFromImageBitmap(bitmap);
      this.counters.bitmapTransfers += 1;
    }
  }

  #ensureSessionsFromSlots(): void {
    const hub = this.#requireHub();
    const ids = new Set<string>();
    for (const slot of this.#slots.values()) ids.add(slot.viewId.split(":")[0] ?? "s0");
    for (const [index, sessionId] of [...ids].entries()) {
      if (this.#sessions.has(sessionId)) continue;
      const size = this.#sceneSizeForSession(sessionId, index);
      this.#sessions.set(sessionId, this.#createSessionGpu(hub, sessionId, index, size.width, size.height));
    }
  }

  #ensureScratch(
    hub: GpuHub,
    width: number,
    height: number,
  ): { canvas: OffscreenCanvas; context: GPUCanvasContext; width: number; height: number } {
    if (this.#scratch && this.#scratch.width === width && this.#scratch.height === height) return this.#scratch;
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext("webgpu");
    if (!context) throw new Error("scratch WebGPU context unavailable");
    context.configure({ device: hub.device, format: hub.format, alphaMode: "opaque" });
    this.#scratch = { canvas, context, width, height };
    return this.#scratch;
  }

  #encodeScene(hub: GpuHub, encoder: GPUCommandEncoder, session: SessionGpu, now: number): void {
    if (!session.full && session.dirtyRows.size === 0) return;
    const instances = this.#packInstances(session);
    session.instance.write(instances.buffer);
    this.counters.uploadBytes += instances.byteLength + UNIFORM_BYTES;
    this.#writeCellUniform(hub, session, now);
    const attachment: GPURenderPassColorAttachment = {
      view: session.view,
      clearValue: { r: 0.05, g: 0.055, b: 0.04, a: 1 },
      loadOp: session.full ? "clear" : "load",
      storeOp: "store",
    };
    const pass = encoder.beginRenderPass({ label: `scene ${session.id}`, colorAttachments: [attachment] });
    if (instances.count > 0) {
      pass.setPipeline(hub.cellPipeline);
      pass.setBindGroup(0, session.cellBind);
      pass.setVertexBuffer(0, session.instance.buffer);
      pass.draw(6, instances.count);
    }
    pass.end();
    this.counters.scenePasses += 1;
    this.counters.cellsDrawn += instances.count;
    session.full = false;
    session.dirtyRows.clear();
  }

  #encodePresent(
    hub: GpuHub,
    encoder: GPUCommandEncoder,
    view: ViewGpu,
    session: SessionGpu,
    now: number,
    dest: { x: number; y: number; width: number; height: number },
    fit: FitMode,
  ): void {
    const context = view.context as GPUCanvasContext;
    const target = context.getCurrentTexture().createView();
    this.counters.swapchainAcquires += 1;
    this.#encodeBlitTo(hub, encoder, target, session, view.width, view.height, dest, fit, now, view);
  }

  #encodeBlitTo(
    hub: GpuHub,
    encoder: GPUCommandEncoder,
    target: GPUTextureView,
    session: SessionGpu,
    viewportW: number,
    viewportH: number,
    dest: { x: number; y: number; width: number; height: number },
    fit: FitMode,
    now: number,
    view?: ViewGpu,
    resourceId?: string,
  ): void {
    const bar: [number, number, number, number] = [0.07, 0.075, 0.055, 1];
    const clearFirst = Boolean(view) || resourceId === "stage" || resourceId?.startsWith("scratch:");
    if (!view) {
      this.#encodeFill(hub, encoder, target, viewportW, viewportH, bar, dest, view, resourceId);
    }
    const fitted = fitRect(session.width, session.height, dest.width, dest.height, fit);
    const rect = { x: dest.x + fitted.x, y: dest.y + fitted.y, width: fitted.width, height: fitted.height };
    const slot = view ? undefined : this.#slotResources(hub, session, resourceId ?? session.id);
    const uniform = view?.blitUniform ?? slot!.blitUniform;
    this.#writeBlit(hub.device, uniform, rect, viewportW, viewportH, now, this.config.effectScope !== "off");
    if (view && !view.blitBind && view.blitUniform) {
      view.blitBind = hub.device.createBindGroup({
        layout: hub.blitLayout,
        entries: [
          { binding: 0, resource: { buffer: view.blitUniform } },
          { binding: 1, resource: session.view },
          { binding: 2, resource: hub.sampler },
        ],
      });
    }
    const bind = view?.blitBind ?? slot!.blitBind;
    if (!bind) return;
    const pass = encoder.beginRenderPass({
      label: "blit",
      colorAttachments: [
        {
          view: target,
          clearValue: { r: bar[0], g: bar[1], b: bar[2], a: bar[3] },
          loadOp: clearFirst && view ? "clear" : "load",
          storeOp: "store",
        },
      ],
    });
    pass.setPipeline(hub.blitPipeline);
    pass.setBindGroup(0, bind);
    pass.draw(6);
    pass.end();
    this.counters.blitPasses += 1;
    if (this.config.effectScope !== "off") this.counters.effectPasses += 1;
  }

  #encodeFill(
    hub: GpuHub,
    encoder: GPUCommandEncoder,
    target: GPUTextureView,
    viewportW: number,
    viewportH: number,
    color: [number, number, number, number],
    rect: { x: number; y: number; width: number; height: number },
    view?: ViewGpu,
    resourceId?: string,
  ): void {
    const slot = view ? undefined : this.#slotResources(hub, undefined, resourceId ?? "fill");
    const uniform = view?.fillUniform ?? slot!.fillUniform;
    this.#writeFill(hub.device, uniform, color, rect, viewportW, viewportH);
    const bind = view?.fillBind ?? slot!.fillBind;
    const pass = encoder.beginRenderPass({
      label: "fill",
      colorAttachments: [
        {
          view: target,
          clearValue: { r: color[0], g: color[1], b: color[2], a: color[3] },
          loadOp: resourceId === "stage" || resourceId?.startsWith("scratch:") ? "clear" : "load",
          storeOp: "store",
        },
      ],
    });
    pass.setPipeline(hub.fillPipeline);
    pass.setBindGroup(0, bind);
    pass.draw(6);
    pass.end();
  }

  #slotResources(hub: GpuHub, session: SessionGpu | undefined, id: string): SlotGpu {
    let slot = this.#slotGpu.get(id);
    if (!slot) {
      const blitUniform = hub.device.createBuffer({
        label: `slot blit ${id}`,
        size: UNIFORM_BYTES,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      const fillUniform = hub.device.createBuffer({
        label: `slot fill ${id}`,
        size: UNIFORM_BYTES,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      slot = {
        blitUniform,
        fillUniform,
        blitBind: undefined,
        fillBind: hub.device.createBindGroup({
          layout: hub.fillLayout,
          entries: [{ binding: 0, resource: { buffer: fillUniform } }],
        }),
      };
      this.#slotGpu.set(id, slot);
    }
    if (session && !slot.blitBind) {
      slot.blitBind = hub.device.createBindGroup({
        layout: hub.blitLayout,
        entries: [
          { binding: 0, resource: { buffer: slot.blitUniform } },
          { binding: 1, resource: session.view },
          { binding: 2, resource: hub.sampler },
        ],
      });
    }
    return slot;
  }

  #presentFit(view: ViewGpu, session: SessionGpu): FitMode {
    return session.width === view.width && session.height === view.height ? "stretch" : "letterbox";
  }

  #packInstances(session: SessionGpu): { buffer: Float32Array; byteLength: number; count: number } {
    const { cols, rows } = this.config;
    const rowsToDraw = session.full
      ? Array.from({ length: rows }, (_, row) => row)
      : [...session.dirtyRows].sort((left, right) => left - right);
    const count = rowsToDraw.length * cols;
    const data = new Float32Array(count * INSTANCE_FLOATS);
    const hue = (session.index * 47 + 18) % 360;
    const fg = hsl(hue, 42, 78);
    const bgOdd = hsl(hue, 18, 12);
    const bgEven = hsl(hue, 16, 16);
    let offset = 0;
    for (const row of rowsToDraw) {
      const bg = row % 2 === 0 ? bgEven : bgOdd;
      for (let col = 0; col < cols; col += 1) {
        const cursor = session.cursor.on && session.cursor.x === col && session.cursor.y === row;
        const glyph = cursor ? 37 : cellGlyph(col, row, session.generation, session.index);
        const u0 = (glyph % ATLAS_COLS) / ATLAS_COLS;
        const v0 = Math.floor(glyph / ATLAS_COLS) / ATLAS_ROWS;
        data[offset++] = col;
        data[offset++] = row;
        data[offset++] = u0;
        data[offset++] = v0;
        data[offset++] = u0 + 1 / ATLAS_COLS;
        data[offset++] = v0 + 1 / ATLAS_ROWS;
        const color = cursor ? hsl(42, 80, 62) : fg;
        data[offset++] = color[0]!;
        data[offset++] = color[1]!;
        data[offset++] = color[2]!;
        data[offset++] = bg[0]!;
        data[offset++] = bg[1]!;
        data[offset++] = bg[2]!;
      }
    }
    return { buffer: data, byteLength: count * INSTANCE_FLOATS * 4, count };
  }

  #writeCellUniform(_hub: GpuHub, session: SessionGpu, now: number): void {
    const grid = fitGrid(
      this.config.cols,
      this.config.rows,
      this.config.cellWidth,
      this.config.cellHeight,
      session.width,
      session.height,
    );
    const data = new Float32Array(UNIFORM_BYTES / 4);
    data[0] = session.width;
    data[1] = session.height;
    data[2] = grid.cellW;
    data[3] = grid.cellH;
    data[4] = grid.x;
    data[5] = grid.y;
    data[6] = session.cursor.x;
    data[7] = session.cursor.y;
    data[8] = session.cursor.on ? 1 : 0;
    data[9] = now / 1000;
    session.device.queue.writeBuffer(session.cellUniform, 0, data);
  }

  #writeFill(
    device: GPUDevice,
    buffer: GPUBuffer,
    color: [number, number, number, number],
    rect: { x: number; y: number; width: number; height: number },
    viewportW: number,
    viewportH: number,
  ): void {
    const data = new Float32Array(UNIFORM_BYTES / 4);
    data.set(color, 0);
    data[4] = rect.x;
    data[5] = rect.y;
    data[6] = rect.width;
    data[7] = rect.height;
    data[8] = viewportW;
    data[9] = viewportH;
    device.queue.writeBuffer(buffer, 0, data);
  }

  #writeBlit(
    device: GPUDevice,
    buffer: GPUBuffer,
    rect: { x: number; y: number; width: number; height: number },
    viewportW: number,
    viewportH: number,
    now: number,
    effect: boolean,
  ): void {
    const data = new Float32Array(UNIFORM_BYTES / 4);
    data[0] = rect.x;
    data[1] = rect.y;
    data[2] = rect.width;
    data[3] = rect.height;
    data[4] = viewportW;
    data[5] = viewportH;
    data[6] = now / 1000;
    data[7] = effect ? 1 : 0;
    device.queue.writeBuffer(buffer, 0, data);
  }

  #createSessionGpu(hub: GpuHub, id: string, index: number, width: number, height: number): SessionGpu {
    const texture = createTexture(hub.device, hub.format, width, height, `scene ${id}`);
    const cellUniform = hub.device.createBuffer({
      label: `cell uniform ${id}`,
      size: UNIFORM_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const fillUniform = hub.device.createBuffer({
      label: `fill uniform ${id}`,
      size: UNIFORM_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const session: SessionGpu = {
      id,
      index,
      texture,
      view: texture.createView(),
      width,
      height,
      instance: new GrowBuffer(
        hub.device,
        `instances ${id}`,
        GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
        this.config.cols * this.config.rows * INSTANCE_FLOATS * 4,
      ),
      cellUniform,
      fillUniform,
      cellBind: hub.device.createBindGroup({
        layout: hub.cellLayout,
        entries: [
          { binding: 0, resource: { buffer: cellUniform } },
          { binding: 1, resource: hub.atlasView },
          { binding: 2, resource: hub.sampler },
        ],
      }),
      fillBind: hub.device.createBindGroup({
        layout: hub.fillLayout,
        entries: [{ binding: 0, resource: { buffer: fillUniform } }],
      }),
      generation: 1,
      cursor: { x: 0, y: 0, on: true },
      dirtyRows: new Set(),
      full: true,
      device: hub.device,
    };
    this.counters.sceneTextures += 1;
    return session;
  }

  #resizeSession(hub: GpuHub, session: SessionGpu, width: number, height: number): void {
    if (session.width === width && session.height === height) return;
    session.texture.destroy();
    session.texture = createTexture(hub.device, hub.format, width, height, `scene ${session.id}`);
    session.view = session.texture.createView();
    session.width = width;
    session.height = height;
    session.cellBind = hub.device.createBindGroup({
      layout: hub.cellLayout,
      entries: [
        { binding: 0, resource: { buffer: session.cellUniform } },
        { binding: 1, resource: hub.atlasView },
        { binding: 2, resource: hub.sampler },
      ],
    });
    session.full = true;
    for (const slot of this.#slotGpu.values()) slot.blitBind = undefined;
    this.#rebindViewBlits();
  }

  #destroySession(session: SessionGpu): void {
    session.texture.destroy();
    session.instance.destroy();
    session.cellUniform.destroy();
    session.fillUniform.destroy();
    this.counters.sceneTextures = Math.max(0, this.counters.sceneTextures - 1);
  }

  #destroyView(view: ViewGpu): void {
    view.blitUniform?.destroy();
    view.fillUniform?.destroy();
    if (view.localScene) this.#destroySession(view.localScene);
    if (!view.bitmap) {
      try {
        (view.context as GPUCanvasContext).unconfigure();
      } catch {
        // canvas already detached
      }
    }
  }

  #invalidateAll(): void {
    for (const session of this.#sessionTargets()) {
      session.full = true;
      session.dirtyRows.clear();
    }
  }

  #invalidateSession(sessionId: string): void {
    const session = this.#sessions.get(sessionId);
    if (session) session.full = true;
    for (const view of this.#views.values()) {
      if (view.sessionId === sessionId && view.localScene) view.localScene.full = true;
    }
  }

  #requireHub(): GpuHub {
    if (!this.#shared) throw new Error("WebGPU hub is not ready");
    return this.#shared;
  }

  async #createHub(label: string): Promise<GpuHub> {
    if (!navigator.gpu) throw new Error("WebGPU is unavailable");
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) throw new Error("No WebGPU adapter");
    this.adapterName = adapter.info?.description || adapter.info?.vendor || label;
    const device = await adapter.requestDevice({ label: `pipeline-lab ${label}` });
    const format = navigator.gpu.getPreferredCanvasFormat();
    const cellModule = device.createShaderModule({ label: "cell", code: CELL_SHADER });
    const fillModule = device.createShaderModule({ label: "fill", code: FILL_SHADER });
    const blitModule = device.createShaderModule({ label: "blit", code: BLIT_SHADER });
    const cellPipeline = device.createRenderPipeline({
      label: "cell pipeline",
      layout: "auto",
      vertex: {
        module: cellModule,
        entryPoint: "vertex_main",
        buffers: [
          {
            arrayStride: INSTANCE_FLOATS * 4,
            stepMode: "instance",
            attributes: [
              { shaderLocation: 0, offset: 0, format: "float32x2" },
              { shaderLocation: 1, offset: 8, format: "float32x4" },
              { shaderLocation: 2, offset: 24, format: "float32x3" },
              { shaderLocation: 3, offset: 36, format: "float32x3" },
            ],
          },
        ],
      },
      fragment: {
        module: cellModule,
        entryPoint: "fragment_main",
        targets: [{ format, blend: premultiplied() }],
      },
      primitive: { topology: "triangle-list" },
    });
    const fillPipeline = device.createRenderPipeline({
      label: "fill pipeline",
      layout: "auto",
      vertex: { module: fillModule, entryPoint: "vertex_main" },
      fragment: { module: fillModule, entryPoint: "fragment_main", targets: [{ format }] },
      primitive: { topology: "triangle-list" },
    });
    const blitPipeline = device.createRenderPipeline({
      label: "blit pipeline",
      layout: "auto",
      vertex: { module: blitModule, entryPoint: "vertex_main" },
      fragment: { module: blitModule, entryPoint: "fragment_main", targets: [{ format }] },
      primitive: { topology: "triangle-list" },
    });
    const atlas = device.createTexture({
      label: "glyph atlas",
      size: [ATLAS_W, ATLAS_H],
      format: "r8unorm",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    device.queue.writeTexture({ texture: atlas }, buildAtlasBytes(), { bytesPerRow: ATLAS_W }, [ATLAS_W, ATLAS_H]);
    const sampler = device.createSampler({ magFilter: "nearest", minFilter: "nearest" });
    this.counters.devices += 1;
    return {
      device,
      format,
      cellPipeline,
      fillPipeline,
      blitPipeline,
      sampler,
      atlas,
      atlasView: atlas.createView(),
      cellLayout: cellPipeline.getBindGroupLayout(0),
      fillLayout: fillPipeline.getBindGroupLayout(0),
      blitLayout: blitPipeline.getBindGroupLayout(0),
    };
  }
}
