import type { CellSelection, TerminalTheme } from "./renderers/types.js";
import type { TerminalScrollbarState } from "@vibecook/ghosttea-protocol";
import type { TerminalRenderPerformanceSnapshot } from "./performance.js";

export type RendererToWorkerMessage =
  | { type: "renderer-config"; forceCanvasFallback: boolean }
  | { type: "partial-rendering"; enabled: boolean }
  | { type: "mount"; surfaceId: string; sessionHandle: string; canvas: OffscreenCanvas }
  | { type: "unmount"; surfaceId: string }
  | { type: "drop-session"; sessionHandle: string }
  | { type: "resize"; surfaceId: string; width: number; height: number; dpr: number }
  | { type: "frame"; packet: ArrayBuffer }
  | { type: "frame-gap"; sessionHandles: string[] }
  | { type: "theme"; sessionHandle: string; surfaceId?: string; theme: TerminalTheme }
  | { type: "selection"; sessionHandle: string; surfaceId?: string; selection: CellSelection | null }
  | { type: "visibility"; sessionHandle: string; surfaceId?: string; visible: boolean }
  | { type: "focus"; surfaceId: string; sessionHandle: string; focused: boolean }
  | { type: "cursor-activity"; sessionHandle: string }
  | { type: "force-full-redraw"; sessionHandle: string }
  | { type: "force-row-redraw"; sessionHandle: string; row: number }
  | { type: "performance-start"; requestId: number }
  | { type: "performance-finish"; requestId: number; quietMs: number; timeoutMs: number };

export type WorkerToRendererMessage =
  | { type: "renderer-status"; backend: string; textEngine?: string; recovered?: boolean }
  | { type: "clipboard-write"; text: string }
  | { type: "scrollbar-state"; sessionHandle: string; scrollbar: TerminalScrollbarState }
  | { type: "frame-resync-needed"; sessionHandle: string }
  | { type: "frame-resync-complete"; sessionHandle: string }
  | { type: "frame-credit"; bytes: number }
  | { type: "performance-started"; requestId: number }
  | { type: "performance-result"; requestId: number; snapshot: TerminalRenderPerformanceSnapshot }
  | { type: "renderer-reload-required"; reason: string };
