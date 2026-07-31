import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { useGhostteaRuntime } from "../context.js";
import { showsStaleScreen, type RemoteInputSuppression, type RemoteSessionRuntimeState } from "../runtime.js";
import {
  contactElapsedMs,
  inputSuppressionHint,
  remoteBannerActionLabel,
  remoteBannerContent,
  retryCountdownMs,
} from "./remote-banner.js";

const SUPPRESSION_HINT_MS = 4_000;
const RECONNECTED_FLASH_MS = 2_000;

/**
 * Tracks one session's lifecycle. The runtime is the external store: it keeps
 * one stable record per session, so the snapshot's identity only changes when
 * a lifecycle event replaces it.
 */
export function useRemoteSessionLifecycle(sessionId: string): RemoteSessionRuntimeState | undefined {
  const terminalRuntime = useGhostteaRuntime();
  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      const update = (event: Event): void => {
        const detail = (event as CustomEvent<RemoteSessionRuntimeState>).detail;
        if (detail.sessionId === sessionId) onStoreChange();
      };
      terminalRuntime.addEventListener("remote-session-state", update);
      return () => terminalRuntime.removeEventListener("remote-session-state", update);
    },
    [sessionId, terminalRuntime],
  );
  return useSyncExternalStore(subscribe, () => terminalRuntime.remoteSession(sessionId));
}

/**
 * The transient note shown after a swallowed keypress. It answers a question
 * the user just asked by typing, so it is deliberately short-lived.
 */
export function useInputSuppressionHint(sessionId: string): string | undefined {
  const terminalRuntime = useGhostteaRuntime();
  const [hint, setHint] = useState<string>();
  useEffect(() => {
    let timer: number | undefined;
    const suppressed = (event: Event): void => {
      const detail = (event as CustomEvent<RemoteInputSuppression>).detail;
      if (detail.sessionId !== sessionId || detail.state === "live") return;
      setHint(inputSuppressionHint(detail.state));
      if (timer !== undefined) window.clearTimeout(timer);
      timer = window.setTimeout(() => setHint(undefined), SUPPRESSION_HINT_MS);
    };
    terminalRuntime.addEventListener("input-suppressed", suppressed);
    return () => {
      if (timer !== undefined) window.clearTimeout(timer);
      terminalRuntime.removeEventListener("input-suppressed", suppressed);
    };
  }, [sessionId, terminalRuntime]);
  return hint;
}

/**
 * A resume is acknowledged once, and only after the restored screen is
 * actually on display — announcing "Reconnected" over the pre-outage frame
 * would be the same lie the cooling exists to prevent.
 */
function useReconnectedFlash(lifecycle: RemoteSessionRuntimeState): boolean {
  const [flashing, setFlashing] = useState(false);
  // Transitions are derived during render (the sanctioned adjust-on-change
  // pattern) so the effect below owns nothing but the timer. `armed` means a
  // stale-screen episode happened and its recovery has not flashed yet; every
  // branch guards on the state it changes, so renders converge.
  const [armed, setArmed] = useState(false);
  const [prevThawed, setPrevThawed] = useState(false);
  const stale = showsStaleScreen(lifecycle.state);
  const thawed = lifecycle.state === "live" && !lifecycle.awaitingRecoveryFrame;
  if (stale && !armed) {
    setArmed(true);
    if (flashing) setFlashing(false);
    if (prevThawed) setPrevThawed(false);
  } else if (!stale && thawed && !prevThawed) {
    setPrevThawed(true);
    if (armed) {
      setArmed(false);
      setFlashing(true);
    }
  }
  useEffect(() => {
    if (!flashing) return undefined;
    const timer = window.setTimeout(() => setFlashing(false), RECONNECTED_FLASH_MS);
    return () => window.clearTimeout(timer);
  }, [flashing]);
  return flashing;
}

export interface RemoteSessionBannerProps {
  lifecycle: RemoteSessionRuntimeState;
  hint?: string | undefined;
  retrying?: boolean;
  onRetry: () => void;
  onClose: () => void;
  onBrowse: () => void;
}

export function RemoteSessionBanner({
  lifecycle,
  hint,
  retrying,
  onRetry,
  onClose,
  onBrowse,
}: RemoteSessionBannerProps) {
  const [now, setNow] = useState(() => performance.now());
  const ticking =
    lifecycle.state === "reconnecting" && (lifecycle.lastContactMs !== null || lifecycle.nextRetryMs !== null);
  useEffect(() => {
    if (!ticking) return undefined;
    const timer = window.setInterval(() => setNow(performance.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [ticking]);
  const reconnected = useReconnectedFlash(lifecycle);

  const content = remoteBannerContent(lifecycle, contactElapsedMs(lifecycle, now), {
    reconnected,
    retryMs: retryCountdownMs(lifecycle, now),
  });
  if (!content) return null;
  return (
    <div className={`remote-session-banner is-${lifecycle.state}`} role="status">
      {content.glyph ? (
        <span className={`remote-session-banner-glyph${content.spinning ? " is-spinning" : ""}`} aria-hidden="true">
          {content.glyph}
        </span>
      ) : null}
      <span className="remote-session-banner-message">{content.message}</span>
      {hint ? <span className="remote-session-banner-hint">{hint}</span> : null}
      {content.actions.length > 0 ? (
        <span className="remote-session-banner-actions">
          {content.actions.map((action) => (
            <button
              key={action}
              type="button"
              disabled={action === "retry" && retrying === true}
              onClick={action === "retry" ? onRetry : action === "close" ? onClose : onBrowse}
            >
              {action === "retry" && retrying ? "Retrying…" : remoteBannerActionLabel(action, lifecycle)}
            </button>
          ))}
        </span>
      ) : null}
    </div>
  );
}
