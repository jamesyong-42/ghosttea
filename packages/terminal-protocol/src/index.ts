export const PROTOCOL_MAJOR = 1;
export const PROTOCOL_MINOR = 4;

export type SessionEnvironment =
  { mode: "inherit"; overrides?: Record<string, string> } | { mode: "clean"; variables: Record<string, string> };

export type TerminationSource = "user" | "application" | "service-shutdown";

export type ExitOutcome =
  | "completed"
  | "crashed"
  | "signaled"
  | "user-terminated"
  | "application-terminated"
  | "service-terminated"
  | "unknown";

export type AutomationInputOperation =
  { kind: "text"; text: string } | { kind: "paste"; text: string; submit: boolean } | { kind: "interrupt" };

export interface CreateSessionOptions {
  executable: string;
  args: string[];
  cwd?: string;
  /** @deprecated Prefer the explicit environment policy. */
  env?: Record<string, string>;
  environment?: SessionEnvironment;
  cols: number;
  rows: number;
  persistence: "terminate-with-app" | "keep-until-exit" | "keep-until-explicit-close";
}

export type ClientCommand =
  | { requestId: number; type: "hello"; protocolMajor: number; protocolMinor: number; clientBuild: string }
  | { requestId: number; type: "create-session"; options: CreateSessionOptions }
  | { requestId: number; type: "list-sessions" }
  | { requestId: number; type: "list-remote-hosts" }
  | { requestId: number; type: "list-remote-sessions"; deviceId: string }
  | {
      requestId: number;
      type: "open-remote-session";
      deviceId: string;
      remoteSessionId: string;
      cols: number;
      rows: number;
    }
  | { requestId: number; type: "get-session"; sessionId: string }
  | { requestId: number; type: "refresh-session"; sessionId: string }
  | { requestId: number; type: "attach-session"; sessionId: string; viewId: string }
  | { requestId: number; type: "detach-session"; sessionId: string; viewId: string }
  | (ViewInputIdentity & { requestId: number; type: "send-text"; sessionId: string; text: string })
  | (ViewInputIdentity & { requestId: number; type: "paste"; sessionId: string; text: string })
  | (ViewInputIdentity & { requestId: number; type: "send-key"; sessionId: string; event: TerminalKeyEvent })
  | (ViewInputIdentity & { requestId: number; type: "send-mouse"; sessionId: string; event: TerminalMouseEvent })
  | (ViewInputIdentity & { requestId: number; type: "scroll"; sessionId: string; rows: number })
  | (ViewInputIdentity & { requestId: number; type: "scroll-to"; sessionId: string; row: number })
  | (ViewInputIdentity & { requestId: number; type: "focus"; sessionId: string; focused: boolean })
  | {
      requestId: number;
      type: "focus-and-resize";
      sessionId: string;
      viewId: string;
      attachmentEpoch: number;
      cols: number;
      rows: number;
    }
  | {
      requestId: number;
      type: "resize";
      sessionId: string;
      viewId: string;
      attachmentEpoch: number;
      controlEpoch: number;
      resizeSequence: number;
      cols: number;
      rows: number;
    }
  | {
      requestId: number;
      type: "set-colors";
      sessionId: string;
      foreground: [number, number, number];
      background: [number, number, number];
      cursor: [number, number, number];
    }
  | {
      requestId: number;
      type: "selection-text";
      sessionId: string;
      viewId: string;
      attachmentEpoch: number;
      startColumn: number;
      startRow: number;
      endColumn: number;
      endRow: number;
      selectAll: boolean;
    }
  | (ViewInputIdentity & { requestId: number; type: "interrupt"; sessionId: string })
  | { requestId: number; type: "get-automation-state"; sessionId: string }
  | {
      requestId: number;
      type: "automation-input";
      sessionId: string;
      expectedHumanInputEpoch: number;
      operation: AutomationInputOperation;
    }
  | { requestId: number; type: "terminate"; sessionId: string; source?: TerminationSource };

export interface SessionSummary {
  id: string;
  handle: string;
  executable: string;
  cols: number;
  rows: number;
  exited: boolean;
  readWrite: boolean;
  title: string | null;
  cwd: string | null;
  bellCount: number;
  pid: number | null;
  createdAtMs: number;
  exitCode: number | null;
  exitSignal: string | null;
  requestedTermination: TerminationSource | null;
  exitOutcome: ExitOutcome | null;
}

export interface ViewInputIdentity {
  viewId: string;
  attachmentEpoch: number;
  inputSequence: number;
}

export interface SharedSessionSummary {
  sessionId: string;
  title: string;
  cwdLabel: string | null;
  running: boolean;
  attachable: boolean;
  readWrite: boolean;
  createdAtMs: number;
}

export interface RemoteHostSummary {
  deviceId: string;
  deviceName: string;
  online: boolean;
  protocolMajor: number;
  protocolMinor: number;
  hostInstanceId: string;
  sessions: SharedSessionSummary[];
}

export type ServerEvent =
  | { requestId: number; type: "hello"; protocolMajor: number; protocolMinor: number; serverBuild: string }
  | { requestId: number; type: "session-created"; session: SessionSummary }
  | { requestId: number; type: "session"; session: SessionSummary }
  | { requestId: number; type: "sessions"; sessions: SessionSummary[] }
  | { requestId: number; type: "remote-hosts"; hosts: RemoteHostSummary[] }
  | { requestId: number; type: "remote-sessions"; deviceId: string; sessions: SharedSessionSummary[] }
  | {
      requestId: number;
      type: "view-attached";
      sessionId: string;
      viewId: string;
      attachmentEpoch: number;
      readWrite: boolean;
    }
  | {
      requestId: number;
      type: "control-claimed";
      sessionId: string;
      controllerViewId: string;
      controlEpoch: number;
      cols: number;
      rows: number;
      layoutEpoch: number;
    }
  | { requestId: number; type: "automation-state"; sessionId: string; humanInputEpoch: number }
  | { requestId: number; type: "selection-text"; text: string }
  | {
      requestId: number;
      type: "automation-input-result";
      sessionId: string;
      accepted: boolean;
      humanInputEpoch: number;
      inputSequence: number | null;
      reason: "human-input-conflict" | null;
    }
  | { requestId: number; type: "ok" }
  | { requestId: number; type: "error"; message: string }
  | { requestId: 0; type: "bridge-error"; message: string }
  | {
      requestId: 0;
      type: "session-exited";
      sessionId: string;
      exitCode: number | null;
      exitSignal: string | null;
      requestedTermination: TerminationSource | null;
      exitOutcome: ExitOutcome;
    }
  | {
      requestId: 0;
      type: "control-changed";
      sessionId: string;
      controllerViewId: string;
      controlEpoch: number;
      cols: number;
      rows: number;
      layoutEpoch: number;
    };

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
  /** Layout-aware Unicode codepoint for this physical key with modifiers removed. */
  unshiftedCodepoint?: number;
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

export interface TerminalScrollbarState {
  /** Total rows in scrollback plus the active screen. */
  total: number;
  /** First visible row, measured from the top of scrollback. */
  offset: number;
  /** Number of visible terminal rows. */
  length: number;
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
  const validTerminationSource = (source: unknown): boolean =>
    source === null || source === "user" || source === "application" || source === "service-shutdown";
  const validExitOutcome = (outcome: unknown): boolean =>
    outcome === "completed" ||
    outcome === "crashed" ||
    outcome === "signaled" ||
    outcome === "user-terminated" ||
    outcome === "application-terminated" ||
    outcome === "service-terminated" ||
    outcome === "unknown";
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
      typeof summary.readWrite === "boolean" &&
      (summary.title === null || typeof summary.title === "string") &&
      (summary.cwd === null || typeof summary.cwd === "string") &&
      Number.isSafeInteger(summary.bellCount) &&
      (summary.pid === null || Number.isSafeInteger(summary.pid)) &&
      Number.isSafeInteger(summary.createdAtMs) &&
      (summary.exitCode === null || Number.isSafeInteger(summary.exitCode)) &&
      (summary.exitSignal === null || typeof summary.exitSignal === "string") &&
      validTerminationSource(summary.requestedTermination) &&
      (summary.exitOutcome === null || validExitOutcome(summary.exitOutcome))
    );
  };
  const validSharedSession = (session: unknown): boolean => {
    if (!session || typeof session !== "object") return false;
    const summary = session as Record<string, unknown>;
    return (
      typeof summary.sessionId === "string" &&
      typeof summary.title === "string" &&
      (summary.cwdLabel === null || typeof summary.cwdLabel === "string") &&
      typeof summary.running === "boolean" &&
      typeof summary.attachable === "boolean" &&
      typeof summary.readWrite === "boolean" &&
      Number.isSafeInteger(summary.createdAtMs)
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
    case "remote-hosts":
      return (
        Array.isArray(candidate.hosts) &&
        candidate.hosts.every((host) => {
          if (!host || typeof host !== "object") return false;
          const summary = host as Record<string, unknown>;
          return (
            typeof summary.deviceId === "string" &&
            typeof summary.deviceName === "string" &&
            typeof summary.online === "boolean" &&
            Number.isSafeInteger(summary.protocolMajor) &&
            Number.isSafeInteger(summary.protocolMinor) &&
            typeof summary.hostInstanceId === "string" &&
            Array.isArray(summary.sessions) &&
            summary.sessions.every(validSharedSession)
          );
        })
      );
    case "remote-sessions":
      return (
        typeof candidate.deviceId === "string" &&
        Array.isArray(candidate.sessions) &&
        candidate.sessions.every(validSharedSession)
      );
    case "view-attached":
      return (
        typeof candidate.sessionId === "string" &&
        typeof candidate.viewId === "string" &&
        Number.isSafeInteger(candidate.attachmentEpoch) &&
        typeof candidate.readWrite === "boolean"
      );
    case "control-claimed":
      return (
        typeof candidate.sessionId === "string" &&
        typeof candidate.controllerViewId === "string" &&
        Number.isSafeInteger(candidate.controlEpoch) &&
        Number.isSafeInteger(candidate.cols) &&
        Number.isSafeInteger(candidate.rows) &&
        Number.isSafeInteger(candidate.layoutEpoch)
      );
    case "automation-state":
      return typeof candidate.sessionId === "string" && Number.isSafeInteger(candidate.humanInputEpoch);
    case "selection-text":
      return typeof candidate.text === "string";
    case "automation-input-result":
      return (
        typeof candidate.sessionId === "string" &&
        typeof candidate.accepted === "boolean" &&
        Number.isSafeInteger(candidate.humanInputEpoch) &&
        (candidate.inputSequence === null || Number.isSafeInteger(candidate.inputSequence)) &&
        (candidate.reason === null || candidate.reason === "human-input-conflict")
      );
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
        (candidate.exitCode === null || Number.isSafeInteger(candidate.exitCode)) &&
        (candidate.exitSignal === null || typeof candidate.exitSignal === "string") &&
        validTerminationSource(candidate.requestedTermination) &&
        validExitOutcome(candidate.exitOutcome)
      );
    case "control-changed":
      return (
        candidate.requestId === 0 &&
        typeof candidate.sessionId === "string" &&
        typeof candidate.controllerViewId === "string" &&
        Number.isSafeInteger(candidate.controlEpoch) &&
        Number.isSafeInteger(candidate.cols) &&
        Number.isSafeInteger(candidate.rows) &&
        Number.isSafeInteger(candidate.layoutEpoch)
      );
    default:
      return false;
  }
}
