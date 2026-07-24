/**
 * Pure routing: GhostteaBindingAction → scoped effect.
 *
 * Match (L1) and route (L2) stay free of React/DOM. Executors in Workspace and
 * TerminalSurface interpret RoutedAction only.
 *
 * Rules:
 * - Every matched Ghostty/extension action must classify (never silent null from route).
 * - `performable` binds that are not yet performable in Ghosttea act as **absent**
 *   (resolve returns null) — matching Ghostty Binding.Flags.performable.
 * - Non-performable unhandled binds still consume so app shortcuts do not leak to PTY.
 * - Unmatched keys return null (fall through to terminal key encoding).
 */

import type { AdjustSelection, GhostteaBindingAction, GhosttyAction } from "./ghostty-actions.js";
import { matchGhostteaBindingEntry, type GhosttyBindingFlags, type MatchBindingOptions } from "./ghostty-bindings.js";
import type { KeyEventLike } from "./ghostty-triggers.js";

export type WorkspaceSplitAxis = "horizontal" | "vertical";

/**
 * Workspace chrome effects currently implemented by GhostteaWorkspace.
 * Stable product command IDs (`ghosttea.workspace.*`) derive from `type`.
 */
export type WorkspaceEffect =
  | { type: "remote-sessions" }
  | { type: "new-tab" }
  | { type: "select-tab"; target: "previous" | "next" | "last" | number }
  | { type: "close-tab" }
  | { type: "split"; axis: WorkspaceSplitAxis }
  | { type: "focus-relative"; offset: -1 | 1 }
  | { type: "focus-direction"; direction: "left" | "right" | "up" | "down" }
  | { type: "resize"; axis: WorkspaceSplitAxis; delta: number }
  | { type: "equalize" }
  | { type: "toggle-zoom" }
  | { type: "close-pane" };

export type TerminalEffect =
  | { type: "paste" }
  | { type: "text"; text: string }
  | { type: "copy" }
  | { type: "select_all" }
  | { type: "clear_screen" }
  | { type: "scroll_to_top" }
  | { type: "scroll_to_bottom" }
  | { type: "scroll_to_selection" }
  | { type: "scroll_to_row"; row: number }
  | { type: "scroll_page_up" }
  | { type: "scroll_page_down" }
  | { type: "scroll_page_fractional"; amount: number }
  | { type: "scroll_page_lines"; lines: number }
  | { type: "adjust_selection"; direction: AdjustSelection };

export type PlatformEffect =
  | { type: "toggle_fullscreen" }
  | { type: "close_window" }
  | { type: "close_all_windows" }
  | { type: "new_window" }
  | { type: "quit" }
  | { type: "open_config" }
  | { type: "reload_config" };

export type RoutedAction =
  | { kind: "workspace"; command: WorkspaceEffect; flags: GhosttyBindingFlags }
  | { kind: "terminal"; effect: TerminalEffect; flags: GhosttyBindingFlags }
  | { kind: "platform"; effect: PlatformEffect; flags: GhosttyBindingFlags }
  | { kind: "unhandled"; action: GhostteaBindingAction; flags: GhosttyBindingFlags; consume: true };

/**
 * Ghostty `resize_split` uses pixel steps (default 10). Workspace layout still
 * uses fractional pane ratios until pixel resize lands.
 */
const RESIZE_FRACTION_STEP = 0.05;

export function workspaceEffectFromAction(action: GhostteaBindingAction): WorkspaceEffect | null {
  if (action.type === "ghosttea.remote_sessions") {
    return { type: "remote-sessions" };
  }
  return workspaceEffectFromGhosttyAction(action);
}

export function workspaceEffectFromGhosttyAction(action: GhosttyAction): WorkspaceEffect | null {
  switch (action.type) {
    case "new_tab":
      return { type: "new-tab" };
    case "previous_tab":
      return { type: "select-tab", target: "previous" };
    case "next_tab":
      return { type: "select-tab", target: "next" };
    case "last_tab":
      return { type: "select-tab", target: "last" };
    case "goto_tab":
      return { type: "select-tab", target: action.index };
    case "close_tab":
      return action.mode === "this" ? { type: "close-tab" } : null;
    case "new_split":
      if (action.direction === "right" || action.direction === "left") {
        return { type: "split", axis: "horizontal" };
      }
      if (action.direction === "down" || action.direction === "up") {
        return { type: "split", axis: "vertical" };
      }
      return null;
    case "goto_split":
      if (action.direction === "previous") return { type: "focus-relative", offset: -1 };
      if (action.direction === "next") return { type: "focus-relative", offset: 1 };
      if (
        action.direction === "left" ||
        action.direction === "right" ||
        action.direction === "up" ||
        action.direction === "down"
      ) {
        return { type: "focus-direction", direction: action.direction };
      }
      return null;
    case "resize_split": {
      const axis: WorkspaceSplitAxis =
        action.direction === "left" || action.direction === "right" ? "horizontal" : "vertical";
      // Preserve relative step size from Ghostty's default 10px unit.
      const steps = Number.isFinite(action.amount) && action.amount !== 0 ? action.amount / 10 : 1;
      const delta =
        (action.direction === "left" || action.direction === "up" ? -RESIZE_FRACTION_STEP : RESIZE_FRACTION_STEP) *
        steps;
      return { type: "resize", axis, delta };
    }
    case "equalize_splits":
      return { type: "equalize" };
    case "toggle_split_zoom":
      return { type: "toggle-zoom" };
    case "close_surface":
      return { type: "close-pane" };
    default:
      return null;
  }
}

export function terminalEffectFromAction(action: GhostteaBindingAction): TerminalEffect | null {
  if (action.type === "ghosttea.remote_sessions") return null;
  switch (action.type) {
    case "paste_from_clipboard":
    case "paste_from_selection":
      // Selection clipboard is not a separate store on macOS Electron; use system paste.
      return { type: "paste" };
    case "text":
      return { type: "text", text: action.value };
    case "esc":
      return { type: "text", text: `\u001b${action.value}` };
    case "csi":
      return { type: "text", text: `\u001b[${action.value}` };
    case "copy_to_clipboard":
      return { type: "copy" };
    case "select_all":
      return { type: "select_all" };
    case "clear_screen":
      return { type: "clear_screen" };
    case "scroll_to_top":
      return { type: "scroll_to_top" };
    case "scroll_to_bottom":
      return { type: "scroll_to_bottom" };
    case "scroll_to_selection":
      return { type: "scroll_to_selection" };
    case "scroll_to_row":
      return { type: "scroll_to_row", row: action.row };
    case "scroll_page_up":
      return { type: "scroll_page_up" };
    case "scroll_page_down":
      return { type: "scroll_page_down" };
    case "scroll_page_fractional":
      return { type: "scroll_page_fractional", amount: action.amount };
    case "scroll_page_lines":
      return { type: "scroll_page_lines", lines: action.lines };
    case "adjust_selection":
      return { type: "adjust_selection", direction: action.direction };
    default:
      return null;
  }
}

export function platformEffectFromAction(action: GhostteaBindingAction): PlatformEffect | null {
  switch (action.type) {
    case "toggle_fullscreen":
      return { type: "toggle_fullscreen" };
    case "close_window":
      return { type: "close_window" };
    case "close_all_windows":
      return { type: "close_all_windows" };
    case "new_window":
      return { type: "new_window" };
    case "quit":
      return { type: "quit" };
    case "open_config":
      return { type: "open_config" };
    case "reload_config":
      return { type: "reload_config" };
    default:
      return null;
  }
}

/**
 * Classify a matched binding action into an executor scope.
 * Always returns a RoutedAction (never null) for a known action.
 */
export function routeBindingAction(
  action: GhostteaBindingAction,
  flags: GhosttyBindingFlags = { performable: false },
): RoutedAction {
  const workspace = workspaceEffectFromAction(action);
  if (workspace) return { kind: "workspace", command: workspace, flags };

  const terminal = terminalEffectFromAction(action);
  if (terminal) return { kind: "terminal", effect: terminal, flags };

  const platform = platformEffectFromAction(action);
  if (platform) return { kind: "platform", effect: platform, flags };

  return { kind: "unhandled", action, flags, consume: true };
}

export type ResolveKeyEventOptions = MatchBindingOptions & {
  /**
   * Only return routes the caller will execute.
   * - workspace capture: workspace | platform | unhandled
   * - terminal surface: terminal
   * - full: all kinds
   */
  scopes?: ReadonlyArray<RoutedAction["kind"]>;
};

/**
 * Match key event against Ghostty defaults + Ghosttea extensions, then route.
 *
 * Returns null when:
 * - the event is not an application binding, or
 * - the bind is `performable` and currently unhandled (cannot perform → acts absent), or
 * - the route kind is filtered out by `scopes`.
 */
export function resolveKeyEvent(event: KeyEventLike, options: ResolveKeyEventOptions = {}): RoutedAction | null {
  const match = matchGhostteaBindingEntry(event, options);
  if (!match) return null;
  const routed = routeBindingAction(match.action, match.flags);

  // Ghostty: performable binds that cannot run do not exist.
  // Until Ghosttea can perform search/undo/etc., pass the key through.
  if (routed.flags.performable && routed.kind === "unhandled") {
    return null;
  }

  if (options.scopes && !options.scopes.includes(routed.kind)) return null;
  return routed;
}

/**
 * Whether this route should preventDefault / stopPropagation after a successful match.
 * Callers that no-op an effect (missing hooks) should still consume.
 */
export function routeConsumesInput(route: RoutedAction): boolean {
  if (route.kind === "unhandled") return route.consume;
  return true;
}

/**
 * Terminal effects that are performable in Ghostty only consume when the
 * executor actually applied them (selection present, clipboard non-empty, …).
 */
export function terminalEffectShouldConsume(
  effect: TerminalEffect,
  applied: boolean,
  flags: GhosttyBindingFlags,
): boolean {
  if (flags.performable) return applied;
  return true;
}
