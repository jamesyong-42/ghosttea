import {
  CursorStyle,
  type CursorState,
  type GlyphDefinition,
  type GlyphInstance,
  type StyleDefinition,
  type StyleRun,
} from "@vibecook/ghosttea-frame";
import type { TerminalRenderMetrics } from "../performance.js";

export type Rgba = readonly [number, number, number, number];

export interface TerminalTheme {
  background: Rgba;
  foreground: Rgba;
  cursor: Rgba;
  selection: Rgba;
  selectionForeground: Rgba;
}

export type TerminalPostProcess = "none" | "better-crt";

export interface TerminalEffects {
  postProcess: TerminalPostProcess;
}

export interface CellPoint {
  column: number;
  row: number;
}

export interface CellSelection {
  anchor: CellPoint;
  focus: CellPoint;
}

export interface RenderView {
  rows: string[];
  nativeRows: GlyphInstance[][];
  nativeStyleRows: StyleRun[][];
  rowRevisions: readonly bigint[];
  glyphDefinitions: Map<number, GlyphDefinition>;
  styleDefinitions: Map<number, StyleDefinition>;
  sessionEpoch: bigint;
  layoutEpoch: bigint;
  cursor: CursorState;
  focused: boolean;
  cursorBlinkVisible: boolean;
  selection: CellSelection | null;
  theme: TerminalTheme;
  effects?: TerminalEffects;
  damage?: RenderDamage;
}

export interface RenderDamage {
  full: boolean;
  rows: ReadonlySet<number>;
  geometryChanged: boolean;
}

export function effectiveCursorStyle(view: RenderView): CursorStyle | null {
  if (!view.cursor.visible) return null;
  if (!view.focused) return CursorStyle.HollowBlock;
  if (view.cursor.blinking && !view.cursorBlinkVisible) return null;
  return view.cursor.style;
}

export interface PixelSize {
  width: number;
  height: number;
  dpr: number;
}

function physicalPixels(value: number, dpr: number): number {
  return Math.max(1, Math.round(value * dpr));
}

export function renderedSizeChanged(current: PixelSize, next: PixelSize): boolean {
  return (
    current.dpr !== next.dpr ||
    physicalPixels(current.width, current.dpr) !== physicalPixels(next.width, next.dpr) ||
    physicalPixels(current.height, current.dpr) !== physicalPixels(next.height, next.dpr)
  );
}

export interface TerminalRenderer {
  readonly kind: "webgpu" | "canvas2d";
  mount(id: string, canvas: OffscreenCanvas): void;
  unmount(id: string): void;
  resize(id: string, size: PixelSize): void;
  render(id: string, view: RenderView): TerminalRenderMetrics | undefined;
  renderBatch?(entries: ReadonlyArray<{ id: string; view: RenderView }>): Array<TerminalRenderMetrics | undefined>;
  setPerformanceMeasurementEnabled?(enabled: boolean): void;
  settle?(): Promise<void>;
}

export const DEFAULT_THEME: TerminalTheme = {
  background: [40 / 255, 44 / 255, 52 / 255, 1],
  foreground: [1, 1, 1, 1],
  cursor: [1, 1, 1, 1],
  selection: [1, 1, 1, 1],
  selectionForeground: [40 / 255, 44 / 255, 52 / 255, 1],
};

export const DEFAULT_EFFECTS: TerminalEffects = {
  postProcess: "none",
};

export const CELL_WIDTH = 7.83;
export const LINE_HEIGHT = 19;
// Ghostty defaults window-padding-x/y to two device-independent points.
export const ORIGIN_X = 2;
export const ORIGIN_Y = 2;
