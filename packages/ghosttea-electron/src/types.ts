import type { GhostteaControlConnection } from "@vibecook/ghosttea-client";

export interface TerminalDaemonConnection extends GhostteaControlConnection {
  frameSocket: string;
}

export interface MainToBridgeMessage {
  type: "connect";
  connection: TerminalDaemonConnection;
}

export interface RendererPortBootstrapMessage {
  type: "ghosttea:ports";
}

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
