import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, PointerEvent as ReactPointerEvent } from "react";
import type { SessionSummary } from "@electron-ghostty/terminal-protocol";
import { terminalRuntime } from "./runtime";
import { TerminalSurface } from "./TerminalSurface";
import { TERMINAL_THEMES } from "./themes";
import {
  appendPane,
  containsPane,
  equalize,
  layoutId,
  leaves,
  pane,
  removePane,
  replacePane,
  resizeForPane,
  restoreNode,
  updateSession,
  updateSplit,
  type PaneNode,
  type PaneSplit,
  type SplitAxis,
} from "./pane-layout";
import { ghosttyHotkey } from "./hotkeys";

const WORKSPACE_STORAGE_KEY = "electron-ghostty:workspace:v1";

function windowTitle(session: SessionSummary | undefined): string {
  if (!session) return "Ghostty";
  const title = session.title?.trim();
  if (title) return title;
  const executable = session.executable.split(/[\\/]/).pop();
  return executable || "Ghostty";
}

interface InitialWorkspace {
  layout: PaneNode;
  activePaneId: string;
  zoomedPaneId: string | null;
}

const initialWorkspace = (async (): Promise<InitialWorkspace> => {
  await terminalRuntime.connect();
  const sessions = await terminalRuntime.listSessions();
  const byId = new Map(sessions.map((session) => [session.id, session]));
  let saved: { layout?: unknown; activePaneId?: unknown; zoomedPaneId?: unknown } | undefined;
  try {
    const serialized = localStorage.getItem(WORKSPACE_STORAGE_KEY);
    if (serialized) saved = JSON.parse(serialized) as typeof saved;
  } catch (error) {
    console.warn("[terminal-runtime] ignored invalid saved workspace", error);
  }
  let layout = restoreNode(saved?.layout, byId);
  const attached = new Set(leaves(layout ?? undefined).map((leaf) => leaf.session.id));
  for (const session of sessions) {
    if (session.exited || attached.has(session.id)) continue;
    const next = pane(layoutId("pane"), session);
    layout = layout ? appendPane(layout, next) : next;
  }
  if (!layout) {
    const session = await terminalRuntime.createSession({
      executable: window.desktop.defaultShell,
      args: [],
      cols: 100,
      rows: 30,
      persistence: "terminate-with-app",
    });
    layout = pane(layoutId("pane"), session);
  }
  const savedActive = typeof saved?.activePaneId === "string" ? saved.activePaneId : undefined;
  const activePaneId = savedActive && containsPane(layout, savedActive) ? savedActive : leaves(layout)[0]!.id;
  const savedZoom = typeof saved?.zoomedPaneId === "string" ? saved.zoomedPaneId : null;
  const zoomedPaneId = savedZoom && containsPane(layout, savedZoom) ? savedZoom : null;
  return { layout, activePaneId, zoomedPaneId };
})();

interface SplitViewProps {
  node: PaneNode;
  activePaneId: string;
  zoomedPaneId: string | null;
  onActivate: (paneId: string) => void;
  onRatio: (splitId: string, ratio: number) => void;
}

function SplitView({ node, activePaneId, zoomedPaneId, onActivate, onRatio }: SplitViewProps) {
  const splitRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ pointerId: number } | null>(null);

  if (node.kind === "pane") {
    const active = node.id === activePaneId;
    const zoomed = node.id === zoomedPaneId;
    return (
      <div
        className={`ghostty-pane${active ? " is-active" : ""}${zoomed ? " is-zoomed" : ""}`}
        data-pane-id={node.id}
        onPointerDown={() => onActivate(node.id)}
      >
        <TerminalSurface
          session={node.session}
          theme={TERMINAL_THEMES.midnight}
          active={active}
          onActivate={() => onActivate(node.id)}
        />
      </div>
    );
  }

  const style =
    node.axis === "horizontal"
      ? { gridTemplateColumns: `${node.ratio}fr 1px ${1 - node.ratio}fr` }
      : { gridTemplateRows: `${node.ratio}fr 1px ${1 - node.ratio}fr` };

  const updateRatio = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (dragRef.current?.pointerId !== event.pointerId || !splitRef.current) return;
    const bounds = splitRef.current.getBoundingClientRect();
    const raw =
      node.axis === "horizontal"
        ? (event.clientX - bounds.left) / Math.max(1, bounds.width)
        : (event.clientY - bounds.top) / Math.max(1, bounds.height);
    onRatio(node.id, Math.max(0.1, Math.min(0.9, raw)));
  };

  return (
    <div ref={splitRef} className={`ghostty-split is-${node.axis}`} style={style as CSSProperties}>
      <SplitView {...{ node: node.first, activePaneId, zoomedPaneId, onActivate, onRatio }} />
      <div
        className="ghostty-split-divider"
        onPointerDown={(event) => {
          dragRef.current = { pointerId: event.pointerId };
          event.currentTarget.setPointerCapture(event.pointerId);
          event.preventDefault();
        }}
        onPointerMove={updateRatio}
        onPointerUp={(event) => {
          if (event.currentTarget.hasPointerCapture(event.pointerId))
            event.currentTarget.releasePointerCapture(event.pointerId);
          dragRef.current = null;
        }}
        onPointerCancel={() => {
          dragRef.current = null;
        }}
      />
      <SplitView {...{ node: node.second, activePaneId, zoomedPaneId, onActivate, onRatio }} />
    </div>
  );
}

export function App() {
  const [layout, setLayout] = useState<PaneNode>();
  const [activePaneId, setActivePaneId] = useState<string>();
  const [zoomedPaneId, setZoomedPaneId] = useState<string | null>(null);
  const [error, setError] = useState<string>();
  const [operationError, setOperationError] = useState<string>();
  const [focused, setFocused] = useState(document.hasFocus());
  const creatingSplitRef = useRef(false);
  const layoutRef = useRef<PaneNode | undefined>(undefined);
  const mountedRef = useRef(true);
  const activePane = useMemo(
    () => leaves(layout).find((candidate) => candidate.id === activePaneId),
    [layout, activePaneId],
  );
  const title = useMemo(() => windowTitle(activePane?.session), [activePane?.session]);

  useEffect(() => {
    let mounted = true;
    mountedRef.current = true;
    void initialWorkspace.then(
      (workspace) => {
        if (!mounted) return;
        setLayout(workspace.layout);
        setActivePaneId(workspace.activePaneId);
        setZoomedPaneId(workspace.zoomedPaneId);
      },
      (cause) => {
        if (mounted) setError(cause instanceof Error ? cause.message : String(cause));
      },
    );
    return () => {
      mounted = false;
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    layoutRef.current = layout;
    if (!layout || !activePaneId) return;
    try {
      localStorage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify({ layout, activePaneId, zoomedPaneId }));
    } catch (error) {
      console.warn("[terminal-runtime] failed to save workspace", error);
    }
  }, [activePaneId, layout, zoomedPaneId]);

  useEffect(() => {
    const update = (event: Event): void => {
      const session = (event as CustomEvent<SessionSummary>).detail;
      setLayout((current) => (current ? updateSession(current, session) : current));
    };
    terminalRuntime.addEventListener("session-metadata", update);
    return () => terminalRuntime.removeEventListener("session-metadata", update);
  }, []);

  useEffect(() => {
    document.title = title;
  }, [title]);

  useEffect(() => {
    const onFocus = (): void => setFocused(true);
    const onBlur = (): void => setFocused(false);
    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onBlur);
    };
  }, []);

  const activatePane = useCallback((paneId: string): void => {
    setActivePaneId(paneId);
    window.requestAnimationFrame(() => {
      const target = Array.from(document.querySelectorAll<HTMLElement>("[data-pane-id]")).find(
        (element) => element.dataset.paneId === paneId,
      );
      target?.querySelector<HTMLTextAreaElement>(".terminal-input")?.focus({ preventScroll: true });
    });
  }, []);

  const newSplit = useCallback(
    async (axis: SplitAxis): Promise<void> => {
      if (!layout || !activePane || creatingSplitRef.current) return;
      creatingSplitRef.current = true;
      try {
        const session = await terminalRuntime.createSession({
          executable: activePane.session.executable,
          args: [],
          ...(activePane.session.cwd ? { cwd: activePane.session.cwd } : {}),
          cols: activePane.session.cols,
          rows: activePane.session.rows,
          persistence: "terminate-with-app",
        });
        if (!mountedRef.current || !layoutRef.current || !containsPane(layoutRef.current, activePane.id)) {
          terminalRuntime.terminate(session.id);
          return;
        }
        const newPane = pane(layoutId("pane"), session);
        const split: PaneSplit = {
          kind: "split",
          id: layoutId("split"),
          axis,
          ratio: 0.5,
          first: activePane,
          second: newPane,
        };
        setLayout((current) => (current ? replacePane(current, activePane.id, split) : current));
        setZoomedPaneId(null);
        setOperationError(undefined);
        activatePane(newPane.id);
      } catch (cause) {
        setOperationError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        creatingSplitRef.current = false;
      }
    },
    [activePane, activatePane, layout],
  );

  const focusRelative = useCallback(
    (offset: number): void => {
      if (zoomedPaneId) return;
      const panes = leaves(layout);
      const current = panes.findIndex((candidate) => candidate.id === activePaneId);
      if (panes.length < 2 || current < 0) return;
      activatePane(panes[(current + offset + panes.length) % panes.length]!.id);
    },
    [activatePane, activePaneId, layout, zoomedPaneId],
  );

  const focusDirection = useCallback(
    (direction: "left" | "right" | "up" | "down"): void => {
      if (zoomedPaneId) return;
      const elements = Array.from(document.querySelectorAll<HTMLElement>("[data-pane-id]"));
      const current = elements.find((element) => element.dataset.paneId === activePaneId);
      if (!current) return;
      const source = current.getBoundingClientRect();
      const sourceX = source.left + source.width / 2;
      const sourceY = source.top + source.height / 2;
      let best: { id: string; score: number } | undefined;
      for (const element of elements) {
        const id = element.dataset.paneId;
        if (!id || id === activePaneId) continue;
        const rect = element.getBoundingClientRect();
        const dx = rect.left + rect.width / 2 - sourceX;
        const dy = rect.top + rect.height / 2 - sourceY;
        const forward = direction === "left" ? -dx : direction === "right" ? dx : direction === "up" ? -dy : dy;
        if (forward <= 0) continue;
        const cross = direction === "left" || direction === "right" ? Math.abs(dy) : Math.abs(dx);
        const score = forward + cross * 2;
        if (!best || score < best.score) best = { id, score };
      }
      if (best) activatePane(best.id);
    },
    [activatePane, activePaneId, zoomedPaneId],
  );

  const closeActivePane = useCallback((): void => {
    if (!layout || !activePane || creatingSplitRef.current) return;
    const panes = leaves(layout);
    if (panes.length === 1) {
      window.desktop.closeWindow();
      return;
    }
    terminalRuntime.terminate(activePane.session.id);
    const index = panes.findIndex((candidate) => candidate.id === activePane.id);
    const next = panes[index === panes.length - 1 ? index - 1 : index + 1]!;
    setLayout(removePane(layout, activePane.id) ?? undefined);
    setZoomedPaneId(null);
    activatePane(next.id);
  }, [activatePane, activePane, layout]);

  const displayedLayout = zoomedPaneId ? leaves(layout).find((candidate) => candidate.id === zoomedPaneId) : layout;

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent): void => {
      const action = ghosttyHotkey(event);
      if (!action) return;
      if (action.type === "split") {
        void newSplit(action.axis);
      } else if (action.type === "focus-relative") {
        focusRelative(action.offset);
      } else if (action.type === "focus-direction") {
        focusDirection(action.direction);
      } else if (action.type === "resize") {
        if (activePaneId) {
          setLayout((current) =>
            current ? resizeForPane(current, activePaneId, action.axis, action.delta)[0] : current,
          );
        }
      } else if (action.type === "equalize") {
        setLayout((current) => (current ? equalize(current) : current));
      } else if (action.type === "toggle-zoom") {
        setZoomedPaneId((current) => (current ? null : (activePaneId ?? null)));
      } else if (action.type === "close-pane") {
        closeActivePane();
      }
      event.preventDefault();
      event.stopPropagation();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [activePaneId, closeActivePane, focusDirection, focusRelative, newSplit]);

  return (
    <main className={`ghostty-window${focused ? " is-focused" : ""}`}>
      <header className="ghostty-titlebar" aria-label={title}>
        <span className="ghostty-title">{title}</span>
      </header>
      <section className="terminal-host">
        {error ? (
          <div className="terminal-error" role="alert">
            {error}
          </div>
        ) : displayedLayout && activePaneId ? (
          <SplitView
            node={displayedLayout}
            activePaneId={activePaneId}
            zoomedPaneId={null}
            onActivate={activatePane}
            onRatio={(splitId, ratio) =>
              setLayout((current) =>
                current ? updateSplit(current, splitId, (split) => ({ ...split, ratio })) : current,
              )
            }
          />
        ) : null}
        {operationError ? (
          <div className="terminal-operation-error" role="status">
            {operationError}
          </div>
        ) : null}
      </section>
    </main>
  );
}
