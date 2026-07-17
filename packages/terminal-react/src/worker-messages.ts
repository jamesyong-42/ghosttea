import type { CellSelection, TerminalTheme } from "./renderers/types.js";
import type { TerminalScrollbarState } from "@vibecook/ghosttea-protocol";

export type RendererToWorkerMessage =
  | { type: "renderer-config"; forceCanvasFallback: boolean }
  | { type: "mount"; sessionHandle: string; canvas: OffscreenCanvas }
  | { type: "unmount"; sessionHandle: string }
  | { type: "drop-session"; sessionHandle: string }
  | { type: "resize"; sessionHandle: string; width: number; height: number; dpr: number }
  | { type: "frame"; packet: ArrayBuffer }
  | { type: "theme"; sessionHandle: string; theme: TerminalTheme }
  | { type: "selection"; sessionHandle: string; selection: CellSelection | null }
  | { type: "visibility"; sessionHandle: string; visible: boolean }
  | { type: "focus"; sessionHandle: string; focused: boolean }
  | { type: "cursor-activity"; sessionHandle: string };

export type WorkerToRendererMessage =
  | { type: "renderer-status"; backend: string; textEngine?: string; recovered?: boolean }
  | { type: "clipboard-write"; text: string }
  | { type: "scrollbar-state"; sessionHandle: string; scrollbar: TerminalScrollbarState }
  | { type: "frame-resync-needed"; sessionHandle: string }
  | { type: "frame-resync-complete"; sessionHandle: string }
  | { type: "renderer-reload-required"; reason: string };
