import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, PointerEvent as ReactPointerEvent } from "react";
import type { SessionSummary } from "@electron-ghostty/terminal-protocol";
import { terminalRuntime } from "./runtime";
import { TerminalSurface } from "./TerminalSurface";
import { TERMINAL_THEMES } from "./themes";

type SplitAxis = "horizontal" | "vertical";

interface PaneLeaf {
  kind: "pane";
  id: string;
  session: SessionSummary;
}

interface PaneSplit {
  kind: "split";
  id: string;
  axis: SplitAxis;
  ratio: number;
  first: PaneNode;
  second: PaneNode;
}

type PaneNode = PaneLeaf | PaneSplit;

let nextLayoutId = 1;
const layoutId = (prefix: string): string => `${prefix}-${nextLayoutId++}`;

const initialSession = (async (): Promise<SessionSummary> => {
  await terminalRuntime.connect();
  const existing = await terminalRuntime.listSessions();
  return existing.find((candidate) => !candidate.exited) ?? terminalRuntime.createSession({
    executable: window.desktop.platform === "win32" ? "powershell.exe" : "/bin/zsh",
    args: [],
    cols: 100,
    rows: 30,
    persistence: "terminate-with-app",
  });
})();

function windowTitle(session: SessionSummary | undefined): string {
  if (!session) return "Ghostty";
  const title = session.title?.trim();
  if (title) return title;
  const executable = session.executable.split(/[\\/]/).pop();
  return executable || "Ghostty";
}

function pane(id: string, session: SessionSummary): PaneLeaf {
  return { kind: "pane", id, session };
}

function leaves(node: PaneNode | undefined): PaneLeaf[] {
  if (!node) return [];
  return node.kind === "pane" ? [node] : [...leaves(node.first), ...leaves(node.second)];
}

function replacePane(node: PaneNode, paneId: string, replacement: PaneNode): PaneNode {
  if (node.kind === "pane") return node.id === paneId ? replacement : node;
  return {
    ...node,
    first: replacePane(node.first, paneId, replacement),
    second: replacePane(node.second, paneId, replacement),
  };
}

function updateSession(node: PaneNode, session: SessionSummary): PaneNode {
  if (node.kind === "pane") return node.session.id === session.id ? { ...node, session } : node;
  return { ...node, first: updateSession(node.first, session), second: updateSession(node.second, session) };
}

function removePane(node: PaneNode, paneId: string): PaneNode | null {
  if (node.kind === "pane") return node.id === paneId ? null : node;
  const first = removePane(node.first, paneId);
  const second = removePane(node.second, paneId);
  if (!first) return second;
  if (!second) return first;
  return { ...node, first, second };
}

function updateSplit(node: PaneNode, splitId: string, update: (split: PaneSplit) => PaneSplit): PaneNode {
  if (node.kind === "pane") return node;
  if (node.id === splitId) return update(node);
  return { ...node, first: updateSplit(node.first, splitId, update), second: updateSplit(node.second, splitId, update) };
}

function equalize(node: PaneNode): PaneNode {
  if (node.kind === "pane") return node;
  return { ...node, ratio: 0.5, first: equalize(node.first), second: equalize(node.second) };
}

function containsPane(node: PaneNode, paneId: string): boolean {
  return node.kind === "pane" ? node.id === paneId : containsPane(node.first, paneId) || containsPane(node.second, paneId);
}

function resizeForPane(node: PaneNode, paneId: string, axis: SplitAxis, delta: number): [PaneNode, boolean] {
  if (node.kind === "pane") return [node, false];
  const inFirst = containsPane(node.first, paneId);
  const inSecond = containsPane(node.second, paneId);
  if (inFirst) {
    const [first, changed] = resizeForPane(node.first, paneId, axis, delta);
    if (changed) return [{ ...node, first }, true];
  }
  if (inSecond) {
    const [second, changed] = resizeForPane(node.second, paneId, axis, delta);
    if (changed) return [{ ...node, second }, true];
  }
  if (node.axis === axis && (inFirst || inSecond)) {
    return [{ ...node, ratio: Math.max(0.1, Math.min(0.9, node.ratio + delta)) }, true];
  }
  return [node, false];
}

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

  const style = node.axis === "horizontal"
    ? { gridTemplateColumns: `${node.ratio}fr 1px ${1 - node.ratio}fr` }
    : { gridTemplateRows: `${node.ratio}fr 1px ${1 - node.ratio}fr` };

  const updateRatio = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (dragRef.current?.pointerId !== event.pointerId || !splitRef.current) return;
    const bounds = splitRef.current.getBoundingClientRect();
    const raw = node.axis === "horizontal"
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
          if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
          dragRef.current = null;
        }}
        onPointerCancel={() => { dragRef.current = null; }}
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
  const [focused, setFocused] = useState(document.hasFocus());
  const creatingSplitRef = useRef(false);
  const activePane = useMemo(() => leaves(layout).find((candidate) => candidate.id === activePaneId), [layout, activePaneId]);
  const title = useMemo(() => windowTitle(activePane?.session), [activePane?.session]);

  useEffect(() => {
    let mounted = true;
    void initialSession.then(
      (session) => {
        if (!mounted) return;
        const firstPane = pane(layoutId("pane"), session);
        setLayout(firstPane);
        setActivePaneId(firstPane.id);
      },
      (cause) => { if (mounted) setError(cause instanceof Error ? cause.message : String(cause)); },
    );
    return () => { mounted = false; };
  }, []);

  useEffect(() => {
    const update = (event: Event): void => {
      const session = (event as CustomEvent<SessionSummary>).detail;
      setLayout((current) => current ? updateSession(current, session) : current);
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
      const target = Array.from(document.querySelectorAll<HTMLElement>("[data-pane-id]"))
        .find((element) => element.dataset.paneId === paneId);
      target?.querySelector<HTMLTextAreaElement>(".terminal-input")?.focus({ preventScroll: true });
    });
  }, []);

  const newSplit = useCallback(async (axis: SplitAxis): Promise<void> => {
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
      const newPane = pane(layoutId("pane"), session);
      const split: PaneSplit = {
        kind: "split",
        id: layoutId("split"),
        axis,
        ratio: 0.5,
        first: activePane,
        second: newPane,
      };
      setLayout((current) => current ? replacePane(current, activePane.id, split) : current);
      setZoomedPaneId(null);
      activatePane(newPane.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      creatingSplitRef.current = false;
    }
  }, [activePane, activatePane, layout]);

  const focusRelative = useCallback((offset: number): void => {
    const panes = leaves(layout);
    const current = panes.findIndex((candidate) => candidate.id === activePaneId);
    if (panes.length < 2 || current < 0) return;
    activatePane(panes[(current + offset + panes.length) % panes.length]!.id);
  }, [activatePane, activePaneId, layout]);

  const focusDirection = useCallback((direction: "left" | "right" | "up" | "down"): void => {
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
  }, [activatePane, activePaneId]);

  const closeActivePane = useCallback((): void => {
    if (!layout || !activePane) return;
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

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (!event.metaKey) return;
      const key = event.key.toLowerCase();
      let handled = true;
      if (key === "d" && !event.altKey && !event.ctrlKey) {
        void newSplit(event.shiftKey ? "vertical" : "horizontal");
      } else if (key === "[" && !event.shiftKey && !event.altKey && !event.ctrlKey) {
        focusRelative(-1);
      } else if (key === "]" && !event.shiftKey && !event.altKey && !event.ctrlKey) {
        focusRelative(1);
      } else if (event.altKey && ["arrowleft", "arrowright", "arrowup", "arrowdown"].includes(key)) {
        focusDirection(key.slice(5) as "left" | "right" | "up" | "down");
      } else if (event.ctrlKey && ["arrowleft", "arrowright", "arrowup", "arrowdown"].includes(key)) {
        if (activePaneId) {
          const axis: SplitAxis = key === "arrowleft" || key === "arrowright" ? "horizontal" : "vertical";
          const delta = key === "arrowleft" || key === "arrowup" ? -0.05 : 0.05;
          setLayout((current) => current ? resizeForPane(current, activePaneId, axis, delta)[0] : current);
        }
      } else if (event.ctrlKey && (key === "=" || key === "+")) {
        setLayout((current) => current ? equalize(current) : current);
      } else if (key === "enter" && event.shiftKey && !event.altKey && !event.ctrlKey) {
        setZoomedPaneId((current) => current ? null : activePaneId ?? null);
      } else if (key === "w" && !event.shiftKey && !event.altKey && !event.ctrlKey) {
        closeActivePane();
      } else {
        handled = false;
      }
      if (handled) {
        event.preventDefault();
        event.stopPropagation();
      }
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
          <div className="terminal-error" role="alert">{error}</div>
        ) : layout && activePaneId ? (
          <SplitView
            node={layout}
            activePaneId={activePaneId}
            zoomedPaneId={zoomedPaneId}
            onActivate={activatePane}
            onRatio={(splitId, ratio) => setLayout((current) => current
              ? updateSplit(current, splitId, (split) => ({ ...split, ratio }))
              : current)}
          />
        ) : null}
      </section>
    </main>
  );
}
