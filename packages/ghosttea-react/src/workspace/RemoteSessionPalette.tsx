import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent, MouseEvent } from "react";
import type { RemoteHostSummary, SharedSessionSummary } from "@vibecook/ghosttea-protocol";
import { useGhostteaRuntime } from "../context.js";

export interface RemoteChoice {
  host: RemoteHostSummary;
  session: SharedSessionSummary;
}

interface RemoteSessionPaletteProps {
  onClose: () => void;
  onOpen: (choice: RemoteChoice) => Promise<void>;
}

export function RemoteSessionPalette({ onClose, onOpen }: RemoteSessionPaletteProps) {
  const terminalRuntime = useGhostteaRuntime();
  const inputRef = useRef<HTMLInputElement>(null);
  const aliveRef = useRef(true);
  const loadingRef = useRef(false);
  const [hosts, setHosts] = useState<RemoteHostSummary[]>([]);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const [loading, setLoading] = useState(true);
  const [opening, setOpening] = useState<string>();
  const [error, setError] = useState<string>();

  const load = useCallback(
    async (background = false): Promise<void> => {
      if (loadingRef.current) return;
      loadingRef.current = true;
      if (!background) {
        setLoading(true);
        setError(undefined);
      }
      try {
        const discovered = await terminalRuntime.listRemoteHosts();
        if (!aliveRef.current) return;
        setHosts(discovered);
        setError(undefined);
        if (!background) setLoading(false);

        const next = await Promise.all(
          discovered.map(async (host) => {
            if (!host.online) return host;
            try {
              const sessions = await terminalRuntime.listRemoteSessions(host.deviceId);
              return { ...host, sessions };
            } catch (cause) {
              console.warn(`[terminal-runtime] could not refresh sessions from ${host.deviceName}`, cause);
              return host;
            }
          }),
        );
        if (aliveRef.current) setHosts(next);
      } catch (cause) {
        if (!aliveRef.current || background) return;
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        loadingRef.current = false;
        if (aliveRef.current && !background) setLoading(false);
      }
    },
    [terminalRuntime],
  );

  useEffect(() => {
    aliveRef.current = true;
    const initialLoad = window.setTimeout(() => void load(), 0);
    const refresh = window.setInterval(() => void load(true), 2_000);
    inputRef.current?.focus({ preventScroll: true });
    return () => {
      aliveRef.current = false;
      window.clearTimeout(initialLoad);
      window.clearInterval(refresh);
    };
  }, [load]);

  const choices = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    return hosts.flatMap((host) =>
      host.sessions
        .filter((session) => session.attachable && session.running)
        .filter((session) => {
          if (!normalized) return true;
          return [host.deviceName, session.title, session.cwdLabel ?? ""]
            .join(" ")
            .toLocaleLowerCase()
            .includes(normalized);
        })
        .map((session) => ({ host, session })),
    );
  }, [hosts, query]);

  const selectedIndex = Math.min(selected, Math.max(0, choices.length - 1));

  const openChoice = async (choice: RemoteChoice): Promise<void> => {
    if (opening) return;
    setOpening(`${choice.host.deviceId}:${choice.session.sessionId}`);
    setError(undefined);
    try {
      await onOpen(choice);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setOpening(undefined);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === "Escape") {
      onClose();
    } else if (event.key === "ArrowDown" && choices.length) {
      setSelected((current) => (current + 1) % choices.length);
    } else if (event.key === "ArrowUp" && choices.length) {
      setSelected((current) => (current - 1 + choices.length) % choices.length);
    } else if (event.key === "Enter" && choices[selectedIndex]) {
      void openChoice(choices[selectedIndex]);
    } else {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
  };

  const dismiss = (event: MouseEvent<HTMLDivElement>): void => {
    if (event.target === event.currentTarget) onClose();
  };

  return (
    <div className="remote-palette-backdrop" role="presentation" onMouseDown={dismiss}>
      <section className="remote-palette" role="dialog" aria-modal="true" aria-label="Remote sessions">
        <div className="remote-palette-search">
          <span className="remote-palette-glyph" aria-hidden="true">
            ↗
          </span>
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => {
              setQuery(event.currentTarget.value);
              setSelected(0);
            }}
            onKeyDown={onKeyDown}
            placeholder="Remote sessions"
            aria-label="Filter remote sessions"
            spellCheck={false}
          />
          {loading ? <span className="remote-palette-spinner" aria-label="Scanning" /> : null}
        </div>

        <div className="remote-palette-results" role="listbox">
          {choices.map((choice, index) => {
            const firstForHost = index === 0 || choices[index - 1]?.host.deviceId !== choice.host.deviceId;
            const key = `${choice.host.deviceId}:${choice.session.sessionId}`;
            return (
              <div key={key}>
                {firstForHost ? (
                  <div className="remote-host-label">
                    <span className={`remote-host-dot${choice.host.online ? " is-online" : ""}`} />
                    <span>{choice.host.deviceName}</span>
                  </div>
                ) : null}
                <button
                  type="button"
                  role="option"
                  aria-selected={index === selectedIndex}
                  className={`remote-session-choice${index === selectedIndex ? " is-selected" : ""}`}
                  onMouseEnter={() => setSelected(index)}
                  onClick={() => void openChoice(choice)}
                  disabled={opening !== undefined}
                >
                  <span className="remote-session-copy">
                    <span className="remote-session-title">{choice.session.title || "Terminal"}</span>
                    <span className="remote-session-cwd">{choice.session.cwdLabel ?? "Remote shell"}</span>
                  </span>
                  <span className={`remote-session-access${choice.session.readWrite ? " is-write" : ""}`}>
                    {opening === key ? "Connecting…" : choice.session.readWrite ? "Interactive available" : "View only"}
                  </span>
                </button>
              </div>
            );
          })}

          {!loading && !error && choices.length === 0 ? (
            <div className="remote-palette-empty">
              <span>
                {query
                  ? "No matching sessions"
                  : hosts.some((host) => host.online)
                    ? "Peers online — waiting for shared sessions…"
                    : hosts.length
                      ? "Remote peers are offline"
                      : "No remote peers found"}
              </span>
              <button type="button" onClick={() => void load(false)}>
                Scan again
              </button>
            </div>
          ) : null}
          {error ? (
            <div className="remote-palette-error" role="alert">
              <span>{error}</span>
              <button type="button" onClick={() => void load(false)}>
                Retry
              </button>
            </div>
          ) : null}
        </div>

        <footer className="remote-palette-footer">
          <span>↑↓ Navigate</span>
          <span>↵ Open</span>
          <span>esc Close</span>
        </footer>
      </section>
    </div>
  );
}
