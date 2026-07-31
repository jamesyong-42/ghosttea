import type { RemoteSessionRuntimeState } from "../runtime.js";

export type RemoteBannerAction = "retry" | "close" | "browse";

export interface RemoteBannerContent {
  /** Rendered separately so the spinner can respect reduced-motion. */
  glyph: string | null;
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
 * Whether the pane shows state the host has stopped updating. `opening` is the
 * normal path to a first frame, not a stalled one, so it is left alone.
 */
export function paneIsFrozen(lifecycle: RemoteSessionRuntimeState | undefined): boolean {
  return lifecycle !== undefined && lifecycle.state !== "live" && lifecycle.state !== "opening";
}

export function remoteBannerContent(
  state: RemoteSessionRuntimeState,
  elapsedMs: number | null,
): RemoteBannerContent | null {
  // Opening gets the same grace as the first seconds of reconnecting: opening
  // a session is not news, and announcing it would train the banner away.
  if (state.state === "live" || state.state === "opening") return null;
  if (state.state === "reconnecting") {
    const contact = elapsedMs === null ? "" : ` · last contact ${Math.round(elapsedMs / 1000)} s ago`;
    return {
      glyph: "⟳",
      message: `Connection to ${state.deviceName} lost — reconnecting…${contact}`,
      actions: [],
    };
  }
  if (state.state === "synchronizing") {
    return { glyph: "⟳", message: "Restoring session…", actions: [] };
  }
  if (state.state === "suspended") {
    return {
      glyph: null,
      message: `${state.deviceName} is offline · waiting for it to return`,
      actions: ["retry", "close"],
    };
  }
  return { glyph: null, message: endedMessage(state), actions: ["browse", "close"] };
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
