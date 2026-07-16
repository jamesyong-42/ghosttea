import type { SplitAxis } from "./pane-layout";

export type GhosttyHotkey =
  | { type: "remote-sessions" }
  | { type: "new-tab" }
  | { type: "select-tab"; target: "previous" | "next" | number }
  | { type: "close-tab" }
  | { type: "split"; axis: SplitAxis }
  | { type: "focus-relative"; offset: -1 | 1 }
  | { type: "focus-direction"; direction: "left" | "right" | "up" | "down" }
  | { type: "resize"; axis: SplitAxis; delta: number }
  | { type: "equalize" }
  | { type: "toggle-zoom" }
  | { type: "close-pane" };

type KeyLike = Pick<KeyboardEvent, "key" | "metaKey" | "shiftKey" | "altKey" | "ctrlKey">;

export function ghosttyHotkey(event: KeyLike): GhosttyHotkey | null {
  const key = event.key.toLowerCase();
  if (!event.metaKey && event.ctrlKey && !event.altKey && key === "tab") {
    return { type: "select-tab", target: event.shiftKey ? "previous" : "next" };
  }
  if (!event.metaKey) return null;
  if (key === "t" && !event.shiftKey && !event.altKey && !event.ctrlKey) return { type: "new-tab" };
  if (event.shiftKey && !event.altKey && !event.ctrlKey && (key === "[" || key === "{")) {
    return { type: "select-tab", target: "previous" };
  }
  if (event.shiftKey && !event.altKey && !event.ctrlKey && (key === "]" || key === "}")) {
    return { type: "select-tab", target: "next" };
  }
  if (/^[1-9]$/.test(key) && !event.shiftKey && !event.altKey && !event.ctrlKey) {
    return { type: "select-tab", target: Number(key) };
  }
  if (key === "w" && !event.shiftKey && event.altKey && !event.ctrlKey) return { type: "close-tab" };
  if (key === "o" && event.shiftKey && !event.altKey && !event.ctrlKey) return { type: "remote-sessions" };
  if (key === "d" && !event.altKey && !event.ctrlKey)
    return { type: "split", axis: event.shiftKey ? "vertical" : "horizontal" };
  if (key === "[" && !event.shiftKey && !event.altKey && !event.ctrlKey) return { type: "focus-relative", offset: -1 };
  if (key === "]" && !event.shiftKey && !event.altKey && !event.ctrlKey) return { type: "focus-relative", offset: 1 };
  if (event.altKey && ["arrowleft", "arrowright", "arrowup", "arrowdown"].includes(key)) {
    return { type: "focus-direction", direction: key.slice(5) as "left" | "right" | "up" | "down" };
  }
  if (event.ctrlKey && ["arrowleft", "arrowright", "arrowup", "arrowdown"].includes(key)) {
    return {
      type: "resize",
      axis: key === "arrowleft" || key === "arrowright" ? "horizontal" : "vertical",
      delta: key === "arrowleft" || key === "arrowup" ? -0.05 : 0.05,
    };
  }
  if (event.ctrlKey && (key === "=" || key === "+")) return { type: "equalize" };
  if (key === "enter" && event.shiftKey && !event.altKey && !event.ctrlKey) return { type: "toggle-zoom" };
  if (key === "w" && !event.shiftKey && !event.altKey && !event.ctrlKey) return { type: "close-pane" };
  return null;
}
