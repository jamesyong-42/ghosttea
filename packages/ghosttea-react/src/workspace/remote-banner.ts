import { sessionIsFrozen, type RemoteSessionRuntimeState } from "../runtime.js";

export type RemoteBannerAction = "retry" | "close" | "browse";

export interface RemoteBannerContent {
  /** Rendered separately so the spinner can respect reduced-motion. */
  glyph: string | null;
  /** Whether the glyph represents work in flight, rather than an outcome. */
  spinning: boolean;
  message: string;
  actions: readonly RemoteBannerAction[];
}

/**
 * Milliseconds since the daemon last heard from the host, carried forward from
 * when this client observed the state. Null when the daemon reported no
 * contact time; the banner then omits the clock rather than inventing one.
 */
export function contactElapsedMs(state: RemoteSessionRuntimeState, now: number): number | null {
  if (state.lastContactMs === null) return null;
  return Math.max(0, state.lastContactMs + Math.max(0, now - state.observedAt));
}

function endedMessage(state: RemoteSessionRuntimeState): string {
  const device = state.deviceName;
  switch (state.reason) {
    case "host-restarted":
      return "Session ended — the host restarted. This is a frozen snapshot of the last screen.";
    case "host-shutdown":
      return `${device} shut down. This is a frozen snapshot of the last screen.`;
    case "session-exited":
      return state.exit && state.exit.code !== null
        ? `Process exited (code ${state.exit.code}) on ${device}.`
        : `Process exited on ${device}.`;
    case "session-closed":
      return `Session was closed on ${device}.`;
    case "closed-locally":
      return `Session was closed on this device.`;
    // No evidence for a specific reason is reported as exactly that.
    default:
      return `This session is no longer available on ${device}.`;
  }
}

/**
 * Whether the pane shows state the host has stopped updating — including the
 * window after recovery where the session is live but the screen has not been
 * redrawn yet. `opening` is the normal path to a first frame, not a stalled
 * one, so it is left alone.
 */
export function paneIsFrozen(lifecycle: RemoteSessionRuntimeState | undefined): boolean {
  return lifecycle !== undefined && sessionIsFrozen(lifecycle);
}

/**
 * How long until the engine dials again, carried forward from when this client
 * observed the state. Null when no retry is scheduled.
 */
export function retryCountdownMs(state: RemoteSessionRuntimeState, now: number): number | null {
  if (state.nextRetryMs === null) return null;
  return Math.max(0, state.nextRetryMs - Math.max(0, now - state.observedAt));
}

function reconnectingMessage(
  state: RemoteSessionRuntimeState,
  elapsedMs: number | null,
  retryMs: number | null,
): string {
  let message = `Connection to ${state.deviceName} lost — reconnecting…`;
  if (elapsedMs !== null) message += ` · last contact ${Math.round(elapsedMs / 1000)} s ago`;
  if (state.attempt !== null && state.attempt > 0) message += ` · attempt ${state.attempt}`;
  // A countdown that has run out is not news; the dial is already going out.
  if (retryMs !== null && retryMs >= 1000) message += ` · retrying in ${Math.round(retryMs / 1000)} s`;
  return message;
}

export function remoteBannerContent(
  state: RemoteSessionRuntimeState,
  elapsedMs: number | null,
  options: { reconnected?: boolean; retryMs?: number | null } = {},
): RemoteBannerContent | null {
  if (state.state === "live") {
    // A resume is worth acknowledging exactly once, and only after the screen
    // it restored is actually on display.
    if (options.reconnected === true && !state.awaitingRecoveryFrame) {
      return { glyph: "✓", spinning: false, message: "Reconnected", actions: [] };
    }
    return null;
  }
  // Opening gets the same grace as the first seconds of reconnecting: opening
  // a session is not news, and announcing it would train the banner away.
  if (state.state === "opening") return null;
  if (state.state === "reconnecting") {
    return {
      glyph: "⟳",
      spinning: true,
      message: reconnectingMessage(state, elapsedMs, options.retryMs ?? null),
      actions: [],
    };
  }
  if (state.state === "synchronizing") {
    return { glyph: "⟳", spinning: true, message: "Restoring session…", actions: [] };
  }
  if (state.state === "suspended") {
    return {
      glyph: null,
      spinning: false,
      message: `${state.deviceName} is offline · waiting for it to return`,
      actions: ["retry", "close"],
    };
  }
  return { glyph: null, spinning: false, message: endedMessage(state), actions: ["browse", "close"] };
}

export function remoteBannerActionLabel(action: RemoteBannerAction, state: RemoteSessionRuntimeState): string {
  if (action === "retry") return "Retry now";
  if (action === "close") return "Close";
  return `Browse sessions on ${state.deviceName}`;
}

/** Why a keystroke went nowhere. Read-only viewers never see this. */
export function inputSuppressionHint(state: RemoteSessionRuntimeState["state"]): string {
  return state === "reconnecting" || state === "synchronizing"
    ? "Keystrokes are not delivered while reconnecting"
    : "Keystrokes are not delivered while the session is offline";
}
