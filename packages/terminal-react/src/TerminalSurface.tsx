import { useCallback, useEffect, useRef, useState } from "react";
import type { ClipboardEvent, KeyboardEvent, PointerEvent, WheelEvent } from "react";
import type { SessionSummary, TerminalKeyEvent, TerminalScrollbarState } from "@vibecook/ghosttea-protocol";
import { useGhostteaRuntime } from "./context.js";
import { terminalKeyboardLayout, terminalKeyDown, terminalKeyUp } from "./keyboard-input.js";
import { CELL_WIDTH, LINE_HEIGHT, ORIGIN_X, ORIGIN_Y, type CellPoint, type TerminalTheme } from "./renderers/types.js";
import { accumulateWheelRows, wheelDeltaPixels } from "./scroll-input.js";

export type TerminalMenuAction = "copy" | "paste" | "select-all" | "clear-screen";

export interface TerminalSurfaceProps {
  session: SessionSummary;
  theme: TerminalTheme;
  active?: boolean;
  /** Whether the surface is currently visible enough to spend GPU work painting it. */
  visible?: boolean;
  controlsResize?: boolean;
  onActivate?: () => void;
  readClipboard?: () => string;
  onContextMenu?: (canCopy: boolean) => void;
  onToggleFullscreen?: () => void;
  onMenuAction?: (listener: (action: TerminalMenuAction) => void) => () => void;
}

export function TerminalSurface(props: TerminalSurfaceProps) {
  const { session } = props;
  return <TerminalSurfaceSession key={`${session.id}:${session.handle}`} {...props} />;
}

function TerminalSurfaceSession({
  session,
  theme,
  active = true,
  visible = true,
  controlsResize = active,
  onActivate,
  readClipboard,
  onContextMenu,
  onToggleFullscreen,
  onMenuAction,
}: TerminalSurfaceProps) {
  const terminalRuntime = useGhostteaRuntime();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const gridRef = useRef({ cols: session.cols, rows: session.rows });
  const [viewId] = useState(() => crypto.randomUUID());
  const [inputFocused, setInputFocused] = useState(false);
  const selectionAnchorRef = useRef<CellPoint | null>(null);
  const selectionRef = useRef<{ anchor: CellPoint; focus: CellPoint } | null>(null);
  const pointerModeRef = useRef<"mouse" | "selection" | null>(null);
  const wheelDeltaRef = useRef(0);
  const pendingScrollRowsRef = useRef(0);
  const scrollFrameRef = useRef<number | null>(null);
  const pendingScrollToRef = useRef<number | null>(null);
  const scrollToFrameRef = useRef<number | null>(null);
  const scrollbarHideTimerRef = useRef<number | null>(null);
  const scrollbarDragRef = useRef<{
    pointerId: number;
    startY: number;
    startOffset: number;
    maxOffset: number;
    travel: number;
  } | null>(null);
  const forwardedKeysRef = useRef(new Map<string, TerminalKeyEvent>());
  const restoreInputFocusRef = useRef(false);
  const [scrollbar, setScrollbar] = useState<TerminalScrollbarState>(
    () =>
      terminalRuntime.scrollbar(session.handle) ?? {
        total: session.rows,
        offset: 0,
        length: session.rows,
      },
  );
  const [scrollbarVisible, setScrollbarVisible] = useState(false);

  const releaseForwardedKeys = useCallback((): void => {
    for (const event of forwardedKeysRef.current.values()) {
      terminalRuntime.sendKey(session.id, viewId, {
        ...event,
        type: "up",
        repeat: false,
        timestamp: performance.now(),
      });
    }
    forwardedKeysRef.current.clear();
  }, [session.id, terminalRuntime, viewId]);

  useEffect(() => {
    terminalRuntime.setTheme(session.handle, theme);
  }, [session.handle, terminalRuntime, theme]);

  useEffect(() => {
    void terminalKeyboardLayout.refresh();
  }, []);

  useEffect(() => {
    if (!onMenuAction) return;
    return onMenuAction((action) => {
      if (!active) return;
      if (action === "copy" && selectionRef.current) {
        void terminalRuntime.copySelection(session.handle, selectionRef.current);
      } else if (action === "paste") {
        const text = readClipboard?.() ?? "";
        if (text) terminalRuntime.paste(session.id, viewId, text);
      } else if (action === "select-all") {
        const { cols, rows } = gridRef.current;
        selectionRef.current = { anchor: { column: 0, row: 0 }, focus: { column: cols - 1, row: rows - 1 } };
        terminalRuntime.setSelection(session.handle, selectionRef.current);
      } else if (action === "clear-screen") {
        terminalRuntime.sendText(session.id, viewId, "\u000c");
      }
    });
  }, [active, onMenuAction, readClipboard, session.handle, session.id, terminalRuntime, viewId]);

  useEffect(() => {
    if (active && document.hasFocus()) inputRef.current?.focus({ preventScroll: true });
  }, [active]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const handle = terminalRuntime.mount(session.id, session.handle, viewId, canvas);
    let { cols, rows } = gridRef.current;
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      handle.resize(entry.contentRect.width, entry.contentRect.height, window.devicePixelRatio);
      const nextCols = Math.max(2, Math.floor((entry.contentRect.width - ORIGIN_X * 2) / CELL_WIDTH));
      const nextRows = Math.max(1, Math.floor((entry.contentRect.height - ORIGIN_Y * 2) / LINE_HEIGHT));
      if (nextCols !== cols || nextRows !== rows) {
        cols = nextCols;
        rows = nextRows;
        gridRef.current = { cols, rows };
        terminalRuntime.resize(session.id, viewId, cols, rows);
      }
    });
    observer.observe(canvas);
    return () => {
      observer.disconnect();
      handle.dispose();
    };
  }, [session.handle, session.id, terminalRuntime, viewId]);

  useEffect(() => {
    terminalRuntime.setVisible(session.handle, visible);
  }, [session.handle, terminalRuntime, visible]);

  useEffect(() => {
    const onScrollbar = (event: Event): void => {
      const detail = (event as CustomEvent<{ sessionHandle: string; scrollbar: TerminalScrollbarState }>).detail;
      if (detail.sessionHandle === session.handle) setScrollbar(detail.scrollbar);
    };
    terminalRuntime.addEventListener("scrollbar-state", onScrollbar);
    return () => terminalRuntime.removeEventListener("scrollbar-state", onScrollbar);
  }, [session.handle, terminalRuntime]);

  useEffect(
    () => () => {
      if (scrollFrameRef.current !== null) window.cancelAnimationFrame(scrollFrameRef.current);
      if (scrollToFrameRef.current !== null) window.cancelAnimationFrame(scrollToFrameRef.current);
      if (scrollbarHideTimerRef.current !== null) window.clearTimeout(scrollbarHideTimerRef.current);
    },
    [],
  );

  useEffect(() => {
    if (!controlsResize) return;
    const { cols, rows } = gridRef.current;
    terminalRuntime.claimResizeControl(session.handle, viewId, cols, rows);
  }, [controlsResize, session.handle, terminalRuntime, viewId]);

  useEffect(() => {
    const syncFocus = (): void => {
      const { cols, rows } = gridRef.current;
      terminalRuntime.setFocused(
        session.handle,
        viewId,
        active && inputFocused && document.hasFocus() && document.activeElement === inputRef.current,
        cols,
        rows,
      );
    };
    const onWindowBlur = (): void => {
      restoreInputFocusRef.current = restoreInputFocusRef.current || document.activeElement === inputRef.current;
      releaseForwardedKeys();
      const { cols, rows } = gridRef.current;
      terminalRuntime.setFocused(session.handle, viewId, false, cols, rows);
    };
    const onWindowFocus = (): void => {
      if (active && restoreInputFocusRef.current) inputRef.current?.focus({ preventScroll: true });
      syncFocus();
    };
    window.addEventListener("blur", onWindowBlur);
    window.addEventListener("focus", onWindowFocus);
    syncFocus();
    return () => {
      window.removeEventListener("blur", onWindowBlur);
      window.removeEventListener("focus", onWindowFocus);
      releaseForwardedKeys();
      const { cols, rows } = gridRef.current;
      terminalRuntime.setFocused(session.handle, viewId, false, cols, rows);
    };
  }, [active, inputFocused, releaseForwardedKeys, session.handle, terminalRuntime, viewId]);

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.nativeEvent.isComposing) return;
    if (event.metaKey) {
      if (event.key.toLowerCase() === "c" && selectionRef.current) {
        void terminalRuntime.copySelection(session.handle, selectionRef.current);
        event.preventDefault();
      } else if (event.key.toLowerCase() === "k") {
        terminalRuntime.sendText(session.id, viewId, "\u000c");
        event.preventDefault();
      } else if (event.key.toLowerCase() === "a") {
        const { cols, rows } = gridRef.current;
        selectionRef.current = { anchor: { column: 0, row: 0 }, focus: { column: cols - 1, row: rows - 1 } };
        terminalRuntime.setSelection(session.handle, selectionRef.current);
        event.preventDefault();
      } else if (event.key === "Enter" || (event.ctrlKey && event.key.toLowerCase() === "f")) {
        onToggleFullscreen?.();
        event.preventDefault();
      }
      return;
    }
    selectionAnchorRef.current = null;
    selectionRef.current = null;
    terminalRuntime.setSelection(session.handle, null);
    if (event.ctrlKey && !event.altKey && event.key.toLowerCase() === "c") {
      terminalRuntime.interrupt(session.id, viewId);
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    const terminalEvent = terminalKeyDown(event.nativeEvent);
    terminalRuntime.sendKey(session.id, viewId, terminalEvent);
    forwardedKeysRef.current.set(event.code, terminalEvent);
    event.preventDefault();
    event.stopPropagation();
  };

  const onKeyUp = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    const pressed = forwardedKeysRef.current.get(event.code);
    if (!pressed) return;
    forwardedKeysRef.current.delete(event.code);
    terminalRuntime.sendKey(session.id, viewId, terminalKeyUp(pressed, event.nativeEvent));
    event.preventDefault();
    event.stopPropagation();
  };

  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>): void => {
    const text = event.clipboardData.getData("text/plain");
    if (!text) return;
    terminalRuntime.paste(session.id, viewId, text);
    event.preventDefault();
  };

  const pointFromPointer = (event: PointerEvent<HTMLTextAreaElement>): CellPoint => {
    const bounds = event.currentTarget.getBoundingClientRect();
    const { cols, rows } = gridRef.current;
    return {
      column: Math.max(0, Math.min(cols - 1, Math.floor((event.clientX - bounds.left - ORIGIN_X) / CELL_WIDTH))),
      row: Math.max(0, Math.min(rows - 1, Math.floor((event.clientY - bounds.top - ORIGIN_Y) / LINE_HEIGHT))),
    };
  };

  const sendMouse = (
    event: PointerEvent<HTMLTextAreaElement> | WheelEvent<HTMLTextAreaElement>,
    action: "press" | "release" | "motion",
    button: number,
  ): void => {
    const bounds = event.currentTarget.getBoundingClientRect();
    terminalRuntime.sendMouse(session.id, viewId, {
      action,
      button,
      x: Math.max(0, event.clientX - bounds.left),
      y: Math.max(0, event.clientY - bounds.top),
      screenWidth: Math.max(1, Math.round(bounds.width)),
      screenHeight: Math.max(1, Math.round(bounds.height)),
      cellWidth: Math.max(1, Math.round(CELL_WIDTH)),
      cellHeight: LINE_HEIGHT,
      paddingLeft: ORIGIN_X,
      paddingTop: ORIGIN_Y,
      shift: event.shiftKey,
      control: event.ctrlKey,
      alt: event.altKey,
      meta: event.metaKey,
    });
  };

  const mouseButton = (button: number): number => (button === 0 ? 1 : button === 1 ? 3 : button === 2 ? 2 : 0);

  const revealScrollbar = (): void => {
    setScrollbarVisible(true);
    if (scrollbarHideTimerRef.current !== null) window.clearTimeout(scrollbarHideTimerRef.current);
    scrollbarHideTimerRef.current = window.setTimeout(() => {
      scrollbarHideTimerRef.current = null;
      if (!scrollbarDragRef.current) setScrollbarVisible(false);
    }, 850);
  };

  const queueScrollRows = (rows: number): void => {
    pendingScrollRowsRef.current += rows;
    if (scrollFrameRef.current !== null) return;
    scrollFrameRef.current = window.requestAnimationFrame(() => {
      scrollFrameRef.current = null;
      const pending = pendingScrollRowsRef.current;
      pendingScrollRowsRef.current = 0;
      if (pending !== 0) terminalRuntime.scroll(session.id, viewId, Math.max(-1_000, Math.min(1_000, pending)));
    });
  };

  const queueScrollTo = (row: number): void => {
    pendingScrollToRef.current = row;
    if (scrollToFrameRef.current !== null) return;
    scrollToFrameRef.current = window.requestAnimationFrame(() => {
      scrollToFrameRef.current = null;
      const pending = pendingScrollToRef.current;
      pendingScrollToRef.current = null;
      if (pending !== null) terminalRuntime.scrollTo(session.id, viewId, pending);
    });
  };

  const onPointerDown = (event: PointerEvent<HTMLTextAreaElement>): void => {
    onActivate?.();
    event.currentTarget.focus({ preventScroll: true });
    const mouseTracking = terminalRuntime.isMouseTracking(session.handle) && !event.shiftKey;
    if (event.button === 2 && !mouseTracking) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
    if (mouseTracking) {
      pointerModeRef.current = "mouse";
      selectionAnchorRef.current = null;
      selectionRef.current = null;
      terminalRuntime.setSelection(session.handle, null);
      sendMouse(event, "press", mouseButton(event.button));
      return;
    }
    pointerModeRef.current = "selection";
    const point = pointFromPointer(event);
    selectionAnchorRef.current = point;
    selectionRef.current = { anchor: point, focus: point };
    terminalRuntime.setSelection(session.handle, selectionRef.current);
  };

  const onPointerMove = (event: PointerEvent<HTMLTextAreaElement>): void => {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
    if (pointerModeRef.current === "mouse") {
      const button = event.buttons & 1 ? 1 : event.buttons & 4 ? 3 : event.buttons & 2 ? 2 : 0;
      sendMouse(event, "motion", button);
      return;
    }
    const anchor = selectionAnchorRef.current;
    if (!anchor || pointerModeRef.current !== "selection") return;
    selectionRef.current = { anchor, focus: pointFromPointer(event) };
    terminalRuntime.setSelection(session.handle, selectionRef.current);
  };

  const onPointerUp = (event: PointerEvent<HTMLTextAreaElement>): void => {
    if (pointerModeRef.current === "mouse") {
      sendMouse(event, "release", mouseButton(event.button));
    } else if (pointerModeRef.current === "selection" && selectionRef.current) {
      const { anchor, focus } = selectionRef.current;
      if (anchor.row === focus.row && anchor.column === focus.column) {
        selectionRef.current = null;
        terminalRuntime.setSelection(session.handle, null);
      } else {
        void terminalRuntime.copySelection(session.handle, selectionRef.current);
      }
    }
    pointerModeRef.current = null;
    selectionAnchorRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const onWheel = (event: WheelEvent<HTMLTextAreaElement>): void => {
    event.preventDefault();
    const accumulated = accumulateWheelRows(
      wheelDeltaRef.current,
      wheelDeltaPixels(event.deltaY, event.deltaMode, gridRef.current.rows, LINE_HEIGHT),
      LINE_HEIGHT,
    );
    wheelDeltaRef.current = accumulated.remainder;
    const { rows } = accumulated;
    if (rows === 0) return;
    if (terminalRuntime.isMouseTracking(session.handle) && !event.shiftKey) {
      const button = rows < 0 ? 4 : 5;
      for (let count = 0; count < Math.min(12, Math.abs(rows)); count += 1) {
        sendMouse(event, "press", button);
      }
    } else {
      revealScrollbar();
      queueScrollRows(rows);
    }
  };

  const scrollbarScrollable = scrollbar.total > scrollbar.length;
  const scrollbarMaxOffset = Math.max(0, scrollbar.total - scrollbar.length);
  const scrollbarPosition = scrollbarMaxOffset === 0 ? 0 : Math.min(1, scrollbar.offset / scrollbarMaxOffset);
  const scrollbarSize = scrollbar.total === 0 ? 1 : Math.min(1, scrollbar.length / scrollbar.total);

  const onScrollbarPointerDown = (event: PointerEvent<HTMLDivElement>): void => {
    if (!scrollbarScrollable) return;
    event.preventDefault();
    event.stopPropagation();
    onActivate?.();
    const track = event.currentTarget;
    const bounds = track.getBoundingClientRect();
    const thumbHeight = Math.max(24, bounds.height * scrollbarSize);
    const travel = Math.max(1, bounds.height - thumbHeight);
    const thumb = (event.target as HTMLElement).closest(".terminal-scrollbar-thumb");
    let startOffset = scrollbar.offset;
    if (!thumb) {
      startOffset = Math.round(
        Math.max(0, Math.min(1, (event.clientY - bounds.top - thumbHeight / 2) / travel)) * scrollbarMaxOffset,
      );
      queueScrollTo(startOffset);
    }
    scrollbarDragRef.current = {
      pointerId: event.pointerId,
      startY: event.clientY,
      startOffset,
      maxOffset: scrollbarMaxOffset,
      travel,
    };
    track.setPointerCapture(event.pointerId);
    revealScrollbar();
  };

  const onScrollbarPointerMove = (event: PointerEvent<HTMLDivElement>): void => {
    const drag = scrollbarDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const row = Math.round(
      Math.max(
        0,
        Math.min(drag.maxOffset, drag.startOffset + ((event.clientY - drag.startY) / drag.travel) * drag.maxOffset),
      ),
    );
    queueScrollTo(row);
    revealScrollbar();
  };

  const onScrollbarPointerUp = (event: PointerEvent<HTMLDivElement>): void => {
    const drag = scrollbarDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    scrollbarDragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
    revealScrollbar();
  };

  return (
    <div className="terminal-surface">
      <canvas ref={canvasRef} aria-label={`Terminal session ${session.id}`} />
      <textarea
        ref={inputRef}
        className="terminal-input"
        autoCapitalize="off"
        autoComplete="off"
        spellCheck={false}
        aria-label="Terminal input"
        onFocus={() => {
          onActivate?.();
          restoreInputFocusRef.current = true;
          setInputFocused(true);
        }}
        onBlur={() => {
          restoreInputFocusRef.current = !document.hasFocus();
          setInputFocused(false);
          releaseForwardedKeys();
        }}
        onKeyDown={onKeyDown}
        onKeyUp={onKeyUp}
        onPaste={onPaste}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onWheel={onWheel}
        onContextMenu={(event) => {
          event.preventDefault();
          onContextMenu?.(selectionRef.current !== null);
        }}
        onCompositionEnd={(event) => {
          terminalRuntime.sendText(session.id, viewId, event.currentTarget.value);
          event.currentTarget.value = "";
        }}
        onInput={(event) => {
          if (!event.nativeEvent.isComposing) event.currentTarget.value = "";
        }}
      />
      {scrollbarScrollable ? (
        <div
          className={`terminal-scrollbar${scrollbarVisible ? " is-visible" : ""}`}
          role="scrollbar"
          aria-label="Terminal scrollback"
          aria-orientation="vertical"
          aria-valuemin={0}
          aria-valuemax={scrollbarMaxOffset}
          aria-valuenow={scrollbar.offset}
          onPointerDown={onScrollbarPointerDown}
          onPointerMove={onScrollbarPointerMove}
          onPointerUp={onScrollbarPointerUp}
          onPointerCancel={onScrollbarPointerUp}
        >
          <div
            className="terminal-scrollbar-thumb"
            style={{
              height: `${scrollbarSize * 100}%`,
              top: `${scrollbarPosition * 100}%`,
              transform: `translateY(-${scrollbarPosition * 100}%)`,
            }}
          />
        </div>
      ) : null}
    </div>
  );
}
