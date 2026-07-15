import { useCallback, useEffect, useRef, useState } from "react";
import type { ClipboardEvent, KeyboardEvent, PointerEvent, WheelEvent } from "react";
import type { SessionSummary, TerminalKeyEvent } from "@vibecook/ghosttea-protocol";
import { terminalRuntime } from "./runtime";
import { CELL_WIDTH, LINE_HEIGHT, ORIGIN_X, ORIGIN_Y, type CellPoint, type TerminalTheme } from "./renderers/types";

interface TerminalSurfaceProps {
  session: SessionSummary;
  theme: TerminalTheme;
  active?: boolean;
  onActivate?: () => void;
}

export function TerminalSurface({ session, theme, active = true, onActivate }: TerminalSurfaceProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const gridRef = useRef({ cols: session.cols, rows: session.rows });
  const [viewId] = useState(() => crypto.randomUUID());
  const selectionAnchorRef = useRef<CellPoint | null>(null);
  const selectionRef = useRef<{ anchor: CellPoint; focus: CellPoint } | null>(null);
  const pointerModeRef = useRef<"mouse" | "selection" | null>(null);
  const wheelDeltaRef = useRef(0);
  const forwardedKeysRef = useRef(new Map<string, TerminalKeyEvent>());

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
  }, [session.id, viewId]);

  useEffect(() => {
    terminalRuntime.setTheme(session.handle, theme);
  }, [session.handle, theme]);

  useEffect(
    () =>
      window.desktop.onMenuAction((action) => {
        if (!active) return;
        if (action === "copy" && selectionRef.current) {
          void terminalRuntime.copySelection(session.handle, selectionRef.current);
        } else if (action === "paste") {
          const text = window.desktop.readClipboard();
          if (text) terminalRuntime.paste(session.id, viewId, text);
        } else if (action === "select-all") {
          const { cols, rows } = gridRef.current;
          selectionRef.current = { anchor: { column: 0, row: 0 }, focus: { column: cols - 1, row: rows - 1 } };
          terminalRuntime.setSelection(session.handle, selectionRef.current);
        } else if (action === "clear-screen") {
          terminalRuntime.sendText(session.id, viewId, "\u000c");
        }
      }),
    [active, session.handle, session.id, viewId],
  );

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
  }, [session.handle, session.id, viewId]);

  useEffect(() => {
    const syncFocus = (): void => {
      const { cols, rows } = gridRef.current;
      terminalRuntime.setFocused(session.handle, viewId, active && document.hasFocus(), cols, rows);
    };
    const onWindowBlur = (): void => {
      releaseForwardedKeys();
      const { cols, rows } = gridRef.current;
      terminalRuntime.setFocused(session.handle, viewId, false, cols, rows);
    };
    const onWindowFocus = (): void => {
      if (active) inputRef.current?.focus({ preventScroll: true });
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
  }, [active, releaseForwardedKeys, session.handle, viewId]);

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
        window.desktop.toggleFullscreen();
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
    const terminalEvent: TerminalKeyEvent = {
      type: "down",
      key: event.key,
      code: event.code,
      location: event.location,
      repeat: event.repeat,
      shift: event.shiftKey,
      control: event.ctrlKey,
      alt: event.altKey,
      meta: event.metaKey,
      timestamp: event.timeStamp,
    };
    terminalRuntime.sendKey(session.id, viewId, terminalEvent);
    forwardedKeysRef.current.set(event.code, terminalEvent);
    event.preventDefault();
    event.stopPropagation();
  };

  const onKeyUp = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (!forwardedKeysRef.current.delete(event.code)) return;
    terminalRuntime.sendKey(session.id, viewId, {
      type: "up",
      key: event.key,
      code: event.code,
      location: event.location,
      repeat: false,
      shift: event.shiftKey,
      control: event.ctrlKey,
      alt: event.altKey,
      meta: event.metaKey,
      timestamp: event.timeStamp,
    });
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
    const multiplier =
      event.deltaMode === 1 ? LINE_HEIGHT : event.deltaMode === 2 ? gridRef.current.rows * LINE_HEIGHT : 1;
    wheelDeltaRef.current += event.deltaY * multiplier;
    const rows = Math.trunc(wheelDeltaRef.current / LINE_HEIGHT);
    if (rows === 0) return;
    wheelDeltaRef.current -= rows * LINE_HEIGHT;
    if (terminalRuntime.isMouseTracking(session.handle) && !event.shiftKey) {
      const button = rows < 0 ? 4 : 5;
      for (let count = 0; count < Math.min(12, Math.abs(rows)); count += 1) {
        sendMouse(event, "press", button);
      }
    } else {
      terminalRuntime.scroll(session.id, viewId, Math.max(-100, Math.min(100, rows)));
    }
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
          window.desktop.showContextMenu(selectionRef.current !== null);
        }}
        onCompositionEnd={(event) => {
          terminalRuntime.sendText(session.id, viewId, event.currentTarget.value);
          event.currentTarget.value = "";
        }}
        onInput={(event) => {
          if (!event.nativeEvent.isComposing) event.currentTarget.value = "";
        }}
      />
    </div>
  );
}
