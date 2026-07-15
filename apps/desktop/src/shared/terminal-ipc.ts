import type { CellSelection, TerminalTheme } from "../renderer/src/renderers/types";

export interface TerminalDaemonConnection {
  controlSocket: string;
  frameSocket: string;
  authToken: string;
}

export interface MainToBridgeMessage {
  type: "connect";
  connection: TerminalDaemonConnection;
}

export interface RendererPortBootstrapMessage {
  type: "ghosttea:ports";
}

export type RendererToWorkerMessage =
  | { type: "renderer-config"; forceCanvasFallback: boolean }
  | { type: "mount"; sessionHandle: string; canvas: OffscreenCanvas }
  | { type: "unmount"; sessionHandle: string }
  | { type: "drop-session"; sessionHandle: string }
  | { type: "resize"; sessionHandle: string; width: number; height: number; dpr: number }
  | { type: "frame"; packet: ArrayBuffer }
  | { type: "theme"; sessionHandle: string; theme: TerminalTheme }
  | { type: "selection"; sessionHandle: string; selection: CellSelection | null }
  | { type: "focus"; sessionHandle: string; focused: boolean }
  | { type: "cursor-activity"; sessionHandle: string }
  | { type: "selection-text"; requestId: number; sessionHandle: string; selection: CellSelection };

export type WorkerToRendererMessage =
  | { type: "renderer-status"; backend: string; textEngine?: string; recovered?: boolean }
  | { type: "clipboard-write"; text: string }
  | { type: "selection-text"; requestId: number; text: string }
  | { type: "frame-resync-needed"; sessionHandle: string }
  | { type: "frame-resync-complete"; sessionHandle: string }
  | { type: "renderer-reload-required"; reason: string };

export function isMainToBridgeMessage(value: unknown): value is MainToBridgeMessage {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  if (candidate.type !== "connect" || !candidate.connection || typeof candidate.connection !== "object") return false;
  const connection = candidate.connection as Record<string, unknown>;
  return (
    typeof connection.controlSocket === "string" &&
    typeof connection.frameSocket === "string" &&
    typeof connection.authToken === "string"
  );
}
