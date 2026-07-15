/// <reference lib="webworker" />
/// <reference types="@webgpu/types" />

import {
  decodeClipboardWrite,
  decodeCursorState,
  decodeFrame,
  decodeGlyphDefinitions,
  decodeRowReplacements,
  decodeStyleDefinitions,
  FrameFlag,
  type CursorState,
  type GlyphDefinition,
  type GlyphInstance,
  type StyleDefinition,
  type StyleRun,
  SectionKind,
} from "@electron-ghostty/terminal-frame";
import { CanvasTerminalRenderer } from "./renderers/canvas-renderer";
import {
  DEFAULT_THEME,
  type CellSelection,
  type PixelSize,
  type TerminalRenderer,
  type TerminalTheme,
} from "./renderers/types";
import { WebGpuTerminalRenderer } from "./renderers/webgpu-renderer";
import { classifyFrame } from "./frame-sequence";
import type { RendererToWorkerMessage, WorkerToRendererMessage } from "../../shared/terminal-ipc";
import { graphemeCellWidth, splitGraphemes } from "./cell-width";

interface Snapshot {
  rows: string[];
  nativeRows: GlyphInstance[][];
  nativeStyleRows: StyleRun[][];
  glyphDefinitions: Map<number, GlyphDefinition>;
  styleDefinitions: Map<number, StyleDefinition>;
  rowRevisions: bigint[];
  cursor: CursorState;
  focused: boolean;
  cursorBlinkVisible: boolean;
  selection: CellSelection | null;
  theme: TerminalTheme;
  layoutEpoch: bigint;
  sessionEpoch: bigint;
  sequence: bigint;
  awaitingResync: boolean;
}

interface MountedCanvas {
  canvas: OffscreenCanvas;
  size: PixelSize;
}

const hiddenCursor: CursorState = { x: 0, y: 0, visible: false, style: 1, blinking: false };
const CURSOR_BLINK_INTERVAL_MS = 600;
const snapshots = new Map<string, Snapshot>();
const mounts = new Map<string, MountedCanvas>();
const cursorBlinkTimers = new Map<string, ReturnType<typeof setTimeout>>();
const dirty = new Set<string>();
let renderer: TerminalRenderer | undefined;
let rendererPromise: Promise<TerminalRenderer> | undefined;
let flushTimer: ReturnType<typeof setTimeout> | undefined;
let recoveryAttempts = 0;
let recovering = false;
let nativeTextAnnounced = false;
let forceCanvasFallback = false;

function postToRenderer(message: WorkerToRendererMessage): void {
  self.postMessage(message);
}

function snapshot(id: string): Snapshot {
  let value = snapshots.get(id);
  if (!value) {
    value = {
      rows: [],
      nativeRows: [],
      nativeStyleRows: [],
      glyphDefinitions: new Map(),
      styleDefinitions: new Map(),
      rowRevisions: [],
      cursor: hiddenCursor,
      focused: false,
      cursorBlinkVisible: true,
      selection: null,
      theme: DEFAULT_THEME,
      layoutEpoch: 0n,
      sessionEpoch: 0n,
      sequence: 0n,
      awaitingResync: false,
    };
    snapshots.set(id, value);
  }
  return value;
}

function scheduleCursorBlink(id: string, reset: boolean): void {
  const existing = cursorBlinkTimers.get(id);
  if (existing !== undefined) clearTimeout(existing);
  cursorBlinkTimers.delete(id);
  const value = snapshot(id);
  if (reset) value.cursorBlinkVisible = true;
  if (!value.focused || !value.cursor.visible || !value.cursor.blinking) return;
  cursorBlinkTimers.set(
    id,
    setTimeout(() => {
      cursorBlinkTimers.delete(id);
      const current = snapshots.get(id);
      if (!current || !current.focused || !current.cursor.visible || !current.cursor.blinking) return;
      current.cursorBlinkVisible = !current.cursorBlinkVisible;
      markDirty(id);
      scheduleCursorBlink(id, false);
    }, CURSOR_BLINK_INTERVAL_MS),
  );
}

function sliceCells(text: string, start: number, endInclusive: number): string {
  let column = 0;
  let selected = "";
  for (const segment of splitGraphemes(text)) {
    const width = graphemeCellWidth(segment);
    if (column <= endInclusive && column + width > start) selected += segment;
    column += width;
    if (column > endInclusive) break;
  }
  return selected;
}

function selectionText(rows: string[], selection: CellSelection): string {
  const forward =
    selection.anchor.row < selection.focus.row ||
    (selection.anchor.row === selection.focus.row && selection.anchor.column <= selection.focus.column);
  const start = forward ? selection.anchor : selection.focus;
  const end = forward ? selection.focus : selection.anchor;
  const output: string[] = [];
  for (let row = start.row; row <= end.row && row < rows.length; row += 1) {
    const first = row === start.row ? start.column : 0;
    const last = row === end.row ? end.column : Number.MAX_SAFE_INTEGER;
    output.push(sliceCells(rows[row] ?? "", first, last));
  }
  return output.join("\n");
}

async function createRenderer(): Promise<TerminalRenderer> {
  if (forceCanvasFallback) {
    const canvas = new CanvasTerminalRenderer();
    postToRenderer({ type: "renderer-status", backend: canvas.kind, recovered: true });
    return canvas;
  }
  try {
    const gpu = await WebGpuTerminalRenderer.create((info) => void recoverDevice(info));
    recoveryAttempts = 0;
    postToRenderer({ type: "renderer-status", backend: gpu.kind });
    return gpu;
  } catch (error) {
    console.warn("[terminal-renderer] WebGPU unavailable; using diagnostic Canvas2D", error);
    const canvas = new CanvasTerminalRenderer();
    postToRenderer({ type: "renderer-status", backend: canvas.kind });
    return canvas;
  }
}

async function ensureRenderer(): Promise<TerminalRenderer> {
  rendererPromise ??= createRenderer();
  renderer = await rendererPromise;
  return renderer;
}

async function recoverDevice(info: GPUDeviceLostInfo): Promise<void> {
  if (recovering || renderer?.kind === "canvas2d") return;
  recovering = true;
  recoveryAttempts += 1;
  console.warn(`[terminal-renderer] WebGPU device lost (${info.reason}): ${info.message}`);
  renderer = undefined;
  rendererPromise = WebGpuTerminalRenderer.create((nextInfo) => void recoverDevice(nextInfo));
  try {
    const next = await rendererPromise;
    renderer = next;
    recoveryAttempts = 0;
    recovering = false;
    for (const [id, mount] of mounts) {
      next.mount(id, mount.canvas);
      next.resize(id, mount.size);
      markDirty(id);
    }
    postToRenderer({ type: "renderer-status", backend: next.kind, recovered: true });
  } catch (error) {
    console.error("[terminal-renderer] WebGPU recovery failed", error);
    rendererPromise = undefined;
    recovering = false;
    if (recoveryAttempts >= 3) {
      postToRenderer({ type: "renderer-reload-required", reason: "webgpu-device-loss" });
      return;
    }
    const delay = Math.min(5_000, 250 * 2 ** Math.min(recoveryAttempts, 4));
    setTimeout(() => void recoverDevice(info), delay);
  }
}

function scheduleFlush(): void {
  flushTimer ??= setTimeout(() => {
    flushTimer = undefined;
    void flush();
  }, 8);
}

async function flush(): Promise<void> {
  const backend = await ensureRenderer();
  const ids = [...dirty];
  dirty.clear();
  for (const id of ids) {
    if (!mounts.has(id)) continue;
    const snapshot = snapshots.get(id);
    if (!snapshot) continue;
    try {
      backend.render(id, snapshot);
    } catch (error) {
      console.error(`[terminal-renderer] failed to render view ${id}`, error);
    }
  }
  if (dirty.size > 0) scheduleFlush();
}

function markDirty(id: string): void {
  dirty.add(id);
  scheduleFlush();
}

async function mount(id: string, canvas: OffscreenCanvas): Promise<void> {
  if (mounts.has(id)) renderer?.unmount(id);
  const entry: MountedCanvas = { canvas, size: { width: 1, height: 1, dpr: 1 } };
  mounts.set(id, entry);
  const backend = await ensureRenderer();
  if (mounts.get(id) !== entry) return;
  backend.mount(id, canvas);
  backend.resize(id, entry.size);
  markDirty(id);
}

function applyFrame(packet: ArrayBuffer): void {
  const frame = decodeFrame(packet);
  const id = frame.sessionHandle.toString();
  const previous = snapshot(id);
  const fullFrame = (frame.flags & FrameFlag.FullSnapshot) !== 0;
  const classification = classifyFrame(previous, {
    sessionEpoch: frame.sessionEpoch,
    layoutEpoch: frame.layoutEpoch,
    sequence: frame.frameSequence,
    full: fullFrame,
  });
  if (classification === "stale") return;
  const changedSession = previous.sessionEpoch !== 0n && frame.sessionEpoch !== previous.sessionEpoch;
  if (classification === "resync") {
    previous.awaitingResync = true;
    postToRenderer({ type: "frame-resync-needed", sessionHandle: id });
    return;
  }
  const completingResync = previous.awaitingResync;
  if (changedSession || completingResync) {
    previous.rows = [];
    previous.nativeRows = [];
    previous.nativeStyleRows = [];
    previous.glyphDefinitions.clear();
    previous.styleDefinitions.clear();
    previous.rowRevisions = [];
  }
  const rowSection = frame.sections.find((candidate) => candidate.kind === SectionKind.RowReplacements);
  const cursorSection = frame.sections.find((candidate) => candidate.kind === SectionKind.CursorState);
  const glyphSection = frame.sections.find((candidate) => candidate.kind === SectionKind.GlyphDefinitions);
  const styleSection = frame.sections.find((candidate) => candidate.kind === SectionKind.StyleDefinitions);
  const clipboardSection = frame.sections.find((candidate) => candidate.kind === SectionKind.ClipboardWrite);
  if (!rowSection || !cursorSection) return;

  if (glyphSection) {
    const definitions = decodeGlyphDefinitions(glyphSection);
    for (const definition of definitions) previous.glyphDefinitions.set(definition.id, definition);
    if (!nativeTextAnnounced && definitions.length > 0) {
      nativeTextAnnounced = true;
      postToRenderer({ type: "renderer-status", backend: renderer?.kind ?? "starting", textEngine: "native" });
    }
  }
  if (styleSection) {
    for (const definition of decodeStyleDefinitions(styleSection))
      previous.styleDefinitions.set(definition.id, definition);
  }
  if (clipboardSection) {
    postToRenderer({ type: "clipboard-write", text: decodeClipboardWrite(clipboardSection) });
  }

  const full = (rowSection.flags & 1) !== 0;
  const rows = full ? Array<string>(frame.rows).fill("") : previous.rows.slice();
  const nativeRows = full
    ? Array.from({ length: frame.rows }, () => [] as GlyphInstance[])
    : previous.nativeRows.map((row) => row.slice());
  const nativeStyleRows = full
    ? Array.from({ length: frame.rows }, () => [] as StyleRun[])
    : previous.nativeStyleRows.map((row) => row.slice());
  const rowRevisions = full ? Array<bigint>(frame.rows).fill(0n) : previous.rowRevisions.slice();
  for (const replacement of decodeRowReplacements(rowSection)) {
    if (replacement.row >= frame.rows) throw new RangeError("Row replacement exceeds viewport");
    if (replacement.revision < (rowRevisions[replacement.row] ?? 0n)) continue;
    rows[replacement.row] = replacement.text;
    nativeRows[replacement.row] = replacement.glyphs;
    nativeStyleRows[replacement.row] = replacement.styles;
    rowRevisions[replacement.row] = replacement.revision;
  }
  previous.rows = rows;
  previous.nativeRows = nativeRows;
  previous.nativeStyleRows = nativeStyleRows;
  previous.rowRevisions = rowRevisions;
  const nextCursor = decodeCursorState(cursorSection);
  const cursorChanged =
    nextCursor.x !== previous.cursor.x ||
    nextCursor.y !== previous.cursor.y ||
    nextCursor.visible !== previous.cursor.visible ||
    nextCursor.style !== previous.cursor.style ||
    nextCursor.blinking !== previous.cursor.blinking;
  previous.cursor = nextCursor;
  if (cursorChanged) scheduleCursorBlink(id, true);
  previous.layoutEpoch = frame.layoutEpoch;
  previous.sessionEpoch = frame.sessionEpoch;
  previous.sequence = frame.frameSequence;
  previous.awaitingResync = false;
  if (completingResync) postToRenderer({ type: "frame-resync-complete", sessionHandle: id });
  markDirty(id);
}

self.onmessage = (event: MessageEvent<RendererToWorkerMessage>) => {
  const message = event.data;
  try {
    if (message.type === "mount") {
      void mount(message.sessionHandle, message.canvas).catch((error) => {
        console.error("[terminal-renderer] mount failed", error);
      });
    } else if (message.type === "renderer-config") {
      forceCanvasFallback = Boolean(message.forceCanvasFallback);
    } else if (message.type === "unmount") {
      mounts.delete(message.sessionHandle);
      dirty.delete(message.sessionHandle);
      renderer?.unmount(message.sessionHandle);
      const timer = cursorBlinkTimers.get(message.sessionHandle);
      if (timer !== undefined) clearTimeout(timer);
      cursorBlinkTimers.delete(message.sessionHandle);
      snapshots.delete(message.sessionHandle);
    } else if (message.type === "drop-session") {
      mounts.delete(message.sessionHandle);
      dirty.delete(message.sessionHandle);
      snapshots.delete(message.sessionHandle);
      renderer?.unmount(message.sessionHandle);
      const timer = cursorBlinkTimers.get(message.sessionHandle);
      if (timer !== undefined) clearTimeout(timer);
      cursorBlinkTimers.delete(message.sessionHandle);
    } else if (message.type === "resize") {
      const mounted = mounts.get(message.sessionHandle);
      if (!mounted) return;
      mounted.size = { width: message.width, height: message.height, dpr: message.dpr };
      renderer?.resize(message.sessionHandle, mounted.size);
      markDirty(message.sessionHandle);
    } else if (message.type === "frame") {
      applyFrame(message.packet);
    } else if (message.type === "theme") {
      snapshot(message.sessionHandle).theme = message.theme;
      markDirty(message.sessionHandle);
    } else if (message.type === "selection") {
      snapshot(message.sessionHandle).selection = message.selection;
      markDirty(message.sessionHandle);
    } else if (message.type === "focus") {
      const value = snapshot(message.sessionHandle);
      value.focused = Boolean(message.focused);
      scheduleCursorBlink(message.sessionHandle, value.focused);
      markDirty(message.sessionHandle);
    } else if (message.type === "cursor-activity") {
      scheduleCursorBlink(message.sessionHandle, true);
      markDirty(message.sessionHandle);
    } else if (message.type === "selection-text") {
      postToRenderer({
        type: "selection-text",
        requestId: message.requestId,
        text: selectionText(snapshot(message.sessionHandle).rows, message.selection),
      });
    }
  } catch (error) {
    console.error("[terminal-renderer] rejected worker message", error);
  }
};
