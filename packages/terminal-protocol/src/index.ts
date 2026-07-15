export const PROTOCOL_MAJOR = 1;
export const PROTOCOL_MINOR = 0;

export interface CreateSessionOptions {
  executable: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
  cols: number;
  rows: number;
  persistence: "terminate-with-app" | "keep-until-exit" | "keep-until-explicit-close";
}

export type ClientCommand =
  | { requestId: number; type: "hello"; protocolMajor: number; protocolMinor: number; clientBuild: string }
  | { requestId: number; type: "create-session"; options: CreateSessionOptions }
  | { requestId: number; type: "list-sessions" }
  | { requestId: number; type: "get-session"; sessionId: string }
  | { requestId: number; type: "refresh-session"; sessionId: string }
  | { requestId: number; type: "attach-session"; sessionId: string }
  | { requestId: number; type: "detach-session"; sessionId: string }
  | { requestId: number; type: "send-text"; sessionId: string; text: string }
  | { requestId: number; type: "paste"; sessionId: string; text: string }
  | { requestId: number; type: "send-key"; sessionId: string; event: TerminalKeyEvent }
  | { requestId: number; type: "send-mouse"; sessionId: string; event: TerminalMouseEvent }
  | { requestId: number; type: "scroll"; sessionId: string; rows: number }
  | { requestId: number; type: "focus"; sessionId: string; focused: boolean }
  | { requestId: number; type: "resize"; sessionId: string; cols: number; rows: number }
  | {
      requestId: number;
      type: "set-colors";
      sessionId: string;
      foreground: [number, number, number];
      background: [number, number, number];
      cursor: [number, number, number];
    }
  | { requestId: number; type: "interrupt"; sessionId: string }
  | { requestId: number; type: "terminate"; sessionId: string };

export interface SessionSummary {
  id: string;
  handle: string;
  executable: string;
  cols: number;
  rows: number;
  exited: boolean;
  title: string | null;
  cwd: string | null;
  bellCount: number;
}

export type ServerEvent =
  | { requestId: number; type: "hello"; protocolMajor: number; protocolMinor: number; serverBuild: string }
  | { requestId: number; type: "session-created"; session: SessionSummary }
  | { requestId: number; type: "session"; session: SessionSummary }
  | { requestId: number; type: "sessions"; sessions: SessionSummary[] }
  | { requestId: number; type: "ok" }
  | { requestId: number; type: "error"; message: string }
  | { requestId: 0; type: "bridge-error"; message: string }
  | { requestId: 0; type: "session-exited"; sessionId: string; exitCode: number | null };

export interface TerminalKeyEvent {
  type: "down" | "up";
  key: string;
  code: string;
  location: number;
  repeat: boolean;
  shift: boolean;
  control: boolean;
  alt: boolean;
  meta: boolean;
  timestamp: number;
}

export interface TerminalMouseEvent {
  action: "press" | "release" | "motion";
  button: number;
  x: number;
  y: number;
  screenWidth: number;
  screenHeight: number;
  cellWidth: number;
  cellHeight: number;
  paddingLeft: number;
  paddingTop: number;
  shift: boolean;
  control: boolean;
  alt: boolean;
  meta: boolean;
}

export function isServerEvent(value: unknown): value is ServerEvent {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  if (
    !Number.isSafeInteger(candidate.requestId) ||
    (candidate.requestId as number) < 0 ||
    typeof candidate.type !== "string"
  )
    return false;
  const validSession = (session: unknown): boolean => {
    if (!session || typeof session !== "object") return false;
    const summary = session as Record<string, unknown>;
    return (
      typeof summary.id === "string" &&
      typeof summary.handle === "string" &&
      typeof summary.executable === "string" &&
      Number.isSafeInteger(summary.cols) &&
      Number.isSafeInteger(summary.rows) &&
      typeof summary.exited === "boolean" &&
      (summary.title === null || typeof summary.title === "string") &&
      (summary.cwd === null || typeof summary.cwd === "string") &&
      Number.isSafeInteger(summary.bellCount)
    );
  };
  switch (candidate.type) {
    case "hello":
      return (
        typeof candidate.protocolMajor === "number" &&
        typeof candidate.protocolMinor === "number" &&
        typeof candidate.serverBuild === "string"
      );
    case "session-created":
    case "session":
      return validSession(candidate.session);
    case "sessions":
      return Array.isArray(candidate.sessions) && candidate.sessions.every(validSession);
    case "ok":
      return true;
    case "error":
      return typeof candidate.message === "string";
    case "bridge-error":
      return candidate.requestId === 0 && typeof candidate.message === "string";
    case "session-exited":
      return (
        candidate.requestId === 0 &&
        typeof candidate.sessionId === "string" &&
        (candidate.exitCode === null || Number.isSafeInteger(candidate.exitCode))
      );
    default:
      return false;
  }
}
