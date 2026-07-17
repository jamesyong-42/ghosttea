import { useCallback, useEffect, useRef, useState } from "react";
import type { ClipboardEvent, KeyboardEvent, PointerEvent, WheelEvent } from "react";
import type { SessionSummary, TerminalKeyEvent, TerminalScrollbarState } from "@vibecook/ghosttea-protocol";
import { useGhostteaRuntime } from "./context.js";
import { terminalKeyboardLayout, terminalKeyDown, terminalKeyUp } from "./keyboard-input.js";
import { ghosttyTerminalBinding } from "./terminal-bindings.js";
import { CELL_WIDTH, LINE_HEIGHT, ORIGIN_X, ORIGIN_Y, type CellPoint, type TerminalTheme } from "./renderers/types.js";
import { accumulateWheelRows, wheelDeltaPixels } from "./scroll-input.js";
import { usesLocalSelection } from "./selection-input.js";

export type TerminalMenuAction = "copy" | "paste" | "select-all" | "clear-screen";

export interface TerminalSurfaceProps {
  session: SessionSummary;
  theme: TerminalTheme;
  active?: boolean;
  /** Host platform used for Ghostty-compatible application keybindings. */
  platform?: string;
  /** Whether the surface is currently visible enough to spend GPU work painting it. */
  visible?: boolean;
  controlsResize?: boolean;
  onActivate?: () => void;
  readClipboard?: () => string;
  onContextMenu?: (canCopy: boolean) => void;
  onToggleFullscreen?: () => void;
  onMenuAction?: (listener: (action: TerminalMenuAction) => void) => () => void;
}

export function viewportSelection(
  selection: { anchor: CellPoint; focus: CellPoint } | null,
  scrollbar: TerminalScrollbarState,
  cols: number,
  rows: number,
): { anchor: CellPoint; focus: CellPoint } | null {
  if (!selection) return null;
  const forward =
    selection.anchor.row < selection.focus.row ||
    (selection.anchor.row === selection.focus.row && selection.anchor.column <= selection.focus.column);
  const start = forward ? selection.anchor : selection.focus;
  const end = forward ? selection.focus : selection.anchor;
  const viewportStart = scrollbar.offset;
  const viewportEnd = viewportStart + rows - 1;
  if (end.row < viewportStart || start.row > viewportEnd) return null;
  return {
    anchor: {
      column: start.row < viewportStart ? 0 : start.column,
      row: Math.max(0, start.row - viewportStart),
    },
    focus: {
      column: end.row > viewportEnd ? Math.max(0, cols - 1) : end.column,
      row: Math.min(rows - 1, end.row - viewportStart),
    },
  };
}

export function TerminalSurface(props: TerminalSurfaceProps) {
  const { session } = props;
  return <TerminalSurfaceSession key={`${session.id}:${session.handle}`} {...props} />;
}

function TerminalSurfaceSession({
  session,
  theme,
  active = true,
  platform,
  visible = true,
  controlsResize = active,
  onActivate,
  readClipboard,
  onContextMenu,
  onToggleFullscreen,
  onMenuAction,
}: TerminalSurfaceProps) {
  const terminalRuntime = useGhostteaRuntime();
  const interactive = session.readWrite;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const gridRef = useRef({ cols: session.cols, rows: session.rows });
  const [viewId] = useState(() => crypto.randomUUID());
  const [inputFocused, setInputFocused] = useState(false);
  const selectionAnchorRef = useRef<CellPoint | null>(null);
  const selectionRef = useRef<{ anchor: CellPoint; focus: CellPoint } | null>(null);
  const selectionAllRef = useRef(false);
  const pointerModeRef = useRef<"mouse" | "selection" | null>(null);
  const wheelDeltaRef = useRef(0);
  const pendingScrollRowsRef = useRef(0);
  const scrollFrameRef = useRef<number | null>(null);
  const pendingScrollToRef = useRef<number | null>(null);
  const scrollToFrameRef = useRef<number | null>(null);
  const scrollbarHideTimerRef = useRef<number | null>(null);
  const selectionAutoScrollTimerRef = useRef<number | null>(null);
  const selectionAutoScrollEdgeRef = useRef<{ direction: -1 | 1; column: number } | null>(null);
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
  const scrollbarRef = useRef(scrollbar);
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
      const focused = document.activeElement;
      const editingAnotherControl =
        focused !== inputRef.current &&
        (focused instanceof HTMLInputElement ||
          focused instanceof HTMLTextAreaElement ||
          (focused instanceof HTMLElement && focused.isContentEditable));
      if (!active || editingAnotherControl) return;
      if (action === "copy" && selectionRef.current) {
        void terminalRuntime.copySelection(session.id, viewId, selectionRef.current, selectionAllRef.current);
      } else if (action === "paste") {
        if (!interactive) return;
        const text = readClipboard?.() ?? "";
        if (text) terminalRuntime.paste(session.id, viewId, text);
      } else if (action === "select-all") {
        const { cols, rows } = gridRef.current;
        const total = Math.max(rows, scrollbarRef.current.total);
        selectionRef.current = { anchor: { column: 0, row: 0 }, focus: { column: cols - 1, row: total - 1 } };
        selectionAllRef.current = true;
        terminalRuntime.setSelection(
          session.handle,
          viewportSelection(selectionRef.current, scrollbarRef.current, cols, rows),
        );
      } else if (action === "clear-screen") {
        terminalRuntime.sendText(session.id, viewId, "\u000c");
      }
    });
  }, [active, interactive, onMenuAction, readClipboard, session.handle, session.id, terminalRuntime, viewId]);

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
      if (detail.sessionHandle !== session.handle) return;
      scrollbarRef.current = detail.scrollbar;
      setScrollbar(detail.scrollbar);
      const { cols, rows } = gridRef.current;
      const edge = selectionAutoScrollEdgeRef.current;
      const anchor = selectionAnchorRef.current;
      if (edge && anchor && pointerModeRef.current === "selection") {
        selectionRef.current = {
          anchor,
          focus: {
            column: edge.column,
            row: detail.scrollbar.offset + (edge.direction < 0 ? 0 : rows - 1),
          },
        };
      }
      terminalRuntime.setSelection(
        session.handle,
        viewportSelection(selectionRef.current, detail.scrollbar, cols, rows),
      );
    };
    terminalRuntime.addEventListener("scrollbar-state", onScrollbar);
    return () => terminalRuntime.removeEventListener("scrollbar-state", onScrollbar);
  }, [session.handle, terminalRuntime]);

  useEffect(
    () => () => {
      if (scrollFrameRef.current !== null) window.cancelAnimationFrame(scrollFrameRef.current);
      if (scrollToFrameRef.current !== null) window.cancelAnimationFrame(scrollToFrameRef.current);
      if (scrollbarHideTimerRef.current !== null) window.clearTimeout(scrollbarHideTimerRef.current);
      if (selectionAutoScrollTimerRef.current !== null) window.clearInterval(selectionAutoScrollTimerRef.current);
    },
    [],
  );

  useEffect(() => {
    if (!controlsResize || !interactive) return;
    const { cols, rows } = gridRef.current;
    terminalRuntime.claimResizeControl(session.handle, viewId, cols, rows);
  }, [controlsResize, interactive, session.handle, terminalRuntime, viewId]);

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
    const binding = ghosttyTerminalBinding(event.nativeEvent, platform);
    if (binding && interactive && (binding.type !== "paste" || readClipboard)) {
      selectionAnchorRef.current = null;
      selectionRef.current = null;
      selectionAllRef.current = false;
      terminalRuntime.setSelection(session.handle, null);
      if (binding.type === "paste") {
        const text = readClipboard?.() ?? "";
        if (text) terminalRuntime.paste(session.id, viewId, text);
      } else {
        terminalRuntime.sendText(session.id, viewId, binding.text);
      }
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (event.metaKey) {
      if (event.key.toLowerCase() === "c" && selectionRef.current) {
        void terminalRuntime.copySelection(session.id, viewId, selectionRef.current, selectionAllRef.current);
        event.preventDefault();
      } else if (event.key.toLowerCase() === "k") {
        terminalRuntime.sendText(session.id, viewId, "\u000c");
        event.preventDefault();
      } else if (event.key.toLowerCase() === "a") {
        const { cols, rows } = gridRef.current;
        const total = Math.max(rows, scrollbarRef.current.total);
        selectionRef.current = { anchor: { column: 0, row: 0 }, focus: { column: cols - 1, row: total - 1 } };
        selectionAllRef.current = true;
        terminalRuntime.setSelection(
          session.handle,
          viewportSelection(selectionRef.current, scrollbarRef.current, cols, rows),
        );
        event.preventDefault();
      } else if (event.key === "Enter" || (event.ctrlKey && event.key.toLowerCase() === "f")) {
        onToggleFullscreen?.();
        event.preventDefault();
      }
      return;
    }
    if (!interactive) {
      event.preventDefault();
      return;
    }
    selectionAnchorRef.current = null;
    selectionRef.current = null;
    selectionAllRef.current = false;
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
    if (!interactive) {
      event.preventDefault();
      return;
    }
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
      row:
        scrollbarRef.current.offset +
        Math.max(0, Math.min(rows - 1, Math.floor((event.clientY - bounds.top - ORIGIN_Y) / LINE_HEIGHT))),
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

  const stopSelectionAutoScroll = (): void => {
    selectionAutoScrollEdgeRef.current = null;
    if (selectionAutoScrollTimerRef.current !== null) {
      window.clearInterval(selectionAutoScrollTimerRef.current);
      selectionAutoScrollTimerRef.current = null;
    }
  };

  const updateSelectionAutoScroll = (direction: -1 | 0 | 1, column: number): void => {
    if (direction === 0) {
      stopSelectionAutoScroll();
      return;
    }
    selectionAutoScrollEdgeRef.current = { direction, column };
    if (selectionAutoScrollTimerRef.current !== null) return;
    selectionAutoScrollTimerRef.current = window.setInterval(() => {
      const edge = selectionAutoScrollEdgeRef.current;
      if (edge) queueScrollRows(edge.direction);
    }, 40);
  };

  const onPointerDown = (event: PointerEvent<HTMLTextAreaElement>): void => {
    onActivate?.();
    event.currentTarget.focus({ preventScroll: true });
    const mouseTracking = terminalRuntime.isMouseTracking(session.handle);
    const localSelection = !interactive || usesLocalSelection(mouseTracking, event.shiftKey);
    if (event.button === 2 && localSelection) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
    if (!localSelection) {
      pointerModeRef.current = "mouse";
      selectionAnchorRef.current = null;
      selectionRef.current = null;
      selectionAllRef.current = false;
      terminalRuntime.setSelection(session.handle, null);
      sendMouse(event, "press", mouseButton(event.button));
      return;
    }
    pointerModeRef.current = "selection";
    const point = pointFromPointer(event);
    selectionAnchorRef.current = point;
    selectionRef.current = { anchor: point, focus: point };
    selectionAllRef.current = false;
    const { cols, rows } = gridRef.current;
    terminalRuntime.setSelection(
      session.handle,
      viewportSelection(selectionRef.current, scrollbarRef.current, cols, rows),
    );
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
    const point = pointFromPointer(event);
    const bounds = event.currentTarget.getBoundingClientRect();
    updateSelectionAutoScroll(event.clientY < bounds.top ? -1 : event.clientY > bounds.bottom ? 1 : 0, point.column);
    selectionRef.current = { anchor, focus: point };
    const { cols, rows } = gridRef.current;
    terminalRuntime.setSelection(
      session.handle,
      viewportSelection(selectionRef.current, scrollbarRef.current, cols, rows),
    );
  };

  const onPointerUp = (event: PointerEvent<HTMLTextAreaElement>): void => {
    stopSelectionAutoScroll();
    if (pointerModeRef.current === "mouse") {
      sendMouse(event, "release", mouseButton(event.button));
    } else if (pointerModeRef.current === "selection" && selectionRef.current) {
      const { anchor, focus } = selectionRef.current;
      if (anchor.row === focus.row && anchor.column === focus.column) {
        selectionRef.current = null;
        selectionAllRef.current = false;
        terminalRuntime.setSelection(session.handle, null);
      } else {
        void terminalRuntime.copySelection(session.id, viewId, selectionRef.current, selectionAllRef.current);
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
        readOnly={!interactive}
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
