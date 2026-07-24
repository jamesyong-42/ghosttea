/**
 * Typed mirror of Ghostty's `input.Binding.Action` (src/input/Binding.zig).
 *
 * Action *names* and parameter formats are ground truth from Ghostty.
 * Ghosttea may not implement every action yet; parsing still accepts the full set
 * so golden binding tests can lock the catalog.
 */

export type SplitDirection = "right" | "down" | "left" | "up" | "auto";
export type SplitFocusDirection = "previous" | "next" | "up" | "left" | "down" | "right";
export type SplitResizeDirection = "up" | "down" | "left" | "right";
export type GotoWindow = "previous" | "next";
export type CopyToClipboard = "plain" | "vt" | "html" | "mixed";
export type WriteScreenAction = "copy" | "paste" | "open";
export type WriteScreenFormat = "plain" | "vt" | "html";
export type CloseTabMode = "this" | "other" | "right";
export type InspectorMode = "toggle" | "show" | "hide";
export type NavigateSearch = "previous" | "next";
export type AdjustSelection =
  "left" | "right" | "up" | "down" | "page_up" | "page_down" | "home" | "end" | "beginning_of_line" | "end_of_line";
export type CrashThread = "main" | "io" | "render";

export type GhosttyAction =
  | { type: "ignore" }
  | { type: "unbind" }
  | { type: "csi"; value: string }
  | { type: "esc"; value: string }
  | { type: "text"; value: string }
  | { type: "cursor_key"; normal: string; application: string }
  | { type: "reset" }
  | { type: "copy_to_clipboard"; format: CopyToClipboard }
  | { type: "paste_from_clipboard" }
  | { type: "paste_from_selection" }
  | { type: "copy_url_to_clipboard" }
  | { type: "copy_title_to_clipboard" }
  | { type: "increase_font_size"; amount: number }
  | { type: "decrease_font_size"; amount: number }
  | { type: "reset_font_size" }
  | { type: "set_font_size"; size: number }
  | { type: "search"; query: string }
  | { type: "search_selection" }
  | { type: "navigate_search"; direction: NavigateSearch }
  | { type: "start_search" }
  | { type: "end_search" }
  | { type: "clear_screen" }
  | { type: "select_all" }
  | { type: "scroll_to_top" }
  | { type: "scroll_to_bottom" }
  | { type: "scroll_to_selection" }
  | { type: "scroll_to_row"; row: number }
  | { type: "scroll_page_up" }
  | { type: "scroll_page_down" }
  | { type: "scroll_page_fractional"; amount: number }
  | { type: "scroll_page_lines"; lines: number }
  | { type: "adjust_selection"; direction: AdjustSelection }
  | { type: "jump_to_prompt"; offset: number }
  | {
      type: "write_scrollback_file";
      action: WriteScreenAction;
      format: WriteScreenFormat;
    }
  | {
      type: "write_screen_file";
      action: WriteScreenAction;
      format: WriteScreenFormat;
    }
  | {
      type: "write_selection_file";
      action: WriteScreenAction;
      format: WriteScreenFormat;
    }
  | { type: "new_window" }
  | { type: "new_tab" }
  | { type: "previous_tab" }
  | { type: "next_tab" }
  | { type: "last_tab" }
  | { type: "goto_tab"; index: number }
  | { type: "move_tab"; offset: number }
  | { type: "toggle_tab_overview" }
  | { type: "prompt_surface_title" }
  | { type: "prompt_tab_title" }
  | { type: "set_surface_title"; title: string }
  | { type: "set_tab_title"; title: string }
  | { type: "new_split"; direction: SplitDirection }
  | { type: "goto_split"; direction: SplitFocusDirection }
  | { type: "goto_window"; direction: GotoWindow }
  | { type: "toggle_split_zoom" }
  | { type: "toggle_readonly" }
  | { type: "resize_split"; direction: SplitResizeDirection; amount: number }
  | { type: "equalize_splits" }
  | { type: "reset_window_size" }
  | { type: "inspector"; mode: InspectorMode }
  | { type: "show_gtk_inspector" }
  | { type: "show_on_screen_keyboard" }
  | { type: "open_config" }
  | { type: "reload_config" }
  | { type: "close_surface" }
  | { type: "close_tab"; mode: CloseTabMode }
  | { type: "close_window" }
  | { type: "close_all_windows" }
  | { type: "toggle_maximize" }
  | { type: "toggle_fullscreen" }
  | { type: "toggle_window_decorations" }
  | { type: "toggle_window_float_on_top" }
  | { type: "toggle_secure_input" }
  | { type: "toggle_mouse_reporting" }
  | { type: "toggle_command_palette" }
  | { type: "toggle_quick_terminal" }
  | { type: "toggle_visibility" }
  | { type: "toggle_background_opacity" }
  | { type: "check_for_updates" }
  | { type: "undo" }
  | { type: "redo" }
  | { type: "end_key_sequence" }
  | { type: "activate_key_table"; name: string }
  | { type: "activate_key_table_once"; name: string }
  | { type: "deactivate_key_table" }
  | { type: "deactivate_all_key_tables" }
  | { type: "quit" }
  | { type: "crash"; thread: CrashThread };

/** Ghosttea product extensions (not Ghostty). */
export type GhostteaExtensionAction = { type: "ghosttea.remote_sessions" };

export type GhostteaBindingAction = GhosttyAction | GhostteaExtensionAction;

export class GhosttyActionParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GhosttyActionParseError";
  }
}

function requireParam(raw: string, name: string): string {
  const idx = raw.indexOf(":");
  if (idx < 0) throw new GhosttyActionParseError(`${name} requires a parameter`);
  return raw.slice(idx + 1);
}

function parseEnum<T extends string>(value: string, allowed: readonly T[], label: string): T {
  if ((allowed as readonly string[]).includes(value)) return value as T;
  throw new GhosttyActionParseError(`invalid ${label}: ${value}`);
}

function parseNumber(value: string, label: string): number {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new GhosttyActionParseError(`invalid ${label}: ${value}`);
  return n;
}

function parseWriteScreen(param: string): { action: WriteScreenAction; format: WriteScreenFormat } {
  const [actionRaw, formatRaw] = param.split(",", 2);
  const action = parseEnum(actionRaw ?? "", ["copy", "paste", "open"] as const, "write screen action");
  const format = formatRaw ? parseEnum(formatRaw, ["plain", "vt", "html"] as const, "write screen format") : "plain";
  return { action, format };
}

/** Decode a Ghostty action string such as `goto_tab:3` or `new_split:right`. */
export function parseGhosttyAction(raw: string): GhosttyAction {
  const input = raw.trim();
  if (!input) throw new GhosttyActionParseError("empty action");

  const colon = input.indexOf(":");
  const name = colon < 0 ? input : input.slice(0, colon);
  const param = colon < 0 ? "" : input.slice(colon + 1);

  switch (name) {
    case "ignore":
      return { type: "ignore" };
    case "unbind":
      return { type: "unbind" };
    case "csi":
      return { type: "csi", value: param };
    case "esc":
      return { type: "esc", value: param };
    case "text":
      return { type: "text", value: decodeZigStringLiteral(param) };
    case "cursor_key": {
      const [normal, application] = param.split(",", 2);
      if (!normal || application === undefined) {
        throw new GhosttyActionParseError("cursor_key requires normal,application");
      }
      return { type: "cursor_key", normal, application };
    }
    case "reset":
      return { type: "reset" };
    case "copy_to_clipboard":
      return {
        type: "copy_to_clipboard",
        format: param ? parseEnum(param, ["plain", "vt", "html", "mixed"] as const, "copy format") : "mixed",
      };
    case "paste_from_clipboard":
      return { type: "paste_from_clipboard" };
    case "paste_from_selection":
      return { type: "paste_from_selection" };
    case "copy_url_to_clipboard":
      return { type: "copy_url_to_clipboard" };
    case "copy_title_to_clipboard":
      return { type: "copy_title_to_clipboard" };
    case "increase_font_size":
      return { type: "increase_font_size", amount: parseNumber(param || "1", "font size") };
    case "decrease_font_size":
      return { type: "decrease_font_size", amount: parseNumber(param || "1", "font size") };
    case "reset_font_size":
      return { type: "reset_font_size" };
    case "set_font_size":
      return { type: "set_font_size", size: parseNumber(requireParam(input, "set_font_size"), "font size") };
    case "search":
      return { type: "search", query: param };
    case "search_selection":
      return { type: "search_selection" };
    case "navigate_search":
      return {
        type: "navigate_search",
        direction: parseEnum(param, ["previous", "next"] as const, "navigate_search"),
      };
    case "start_search":
      return { type: "start_search" };
    case "end_search":
      return { type: "end_search" };
    case "clear_screen":
      return { type: "clear_screen" };
    case "select_all":
      return { type: "select_all" };
    case "scroll_to_top":
      return { type: "scroll_to_top" };
    case "scroll_to_bottom":
      return { type: "scroll_to_bottom" };
    case "scroll_to_selection":
      return { type: "scroll_to_selection" };
    case "scroll_to_row":
      return { type: "scroll_to_row", row: parseNumber(requireParam(input, "scroll_to_row"), "row") };
    case "scroll_page_up":
      return { type: "scroll_page_up" };
    case "scroll_page_down":
      return { type: "scroll_page_down" };
    case "scroll_page_fractional":
      return {
        type: "scroll_page_fractional",
        amount: parseNumber(requireParam(input, "scroll_page_fractional"), "fraction"),
      };
    case "scroll_page_lines":
      return {
        type: "scroll_page_lines",
        lines: parseNumber(requireParam(input, "scroll_page_lines"), "lines"),
      };
    case "adjust_selection":
      return {
        type: "adjust_selection",
        direction: parseEnum(
          param,
          [
            "left",
            "right",
            "up",
            "down",
            "page_up",
            "page_down",
            "home",
            "end",
            "beginning_of_line",
            "end_of_line",
          ] as const,
          "adjust_selection",
        ),
      };
    case "jump_to_prompt":
      return { type: "jump_to_prompt", offset: parseNumber(requireParam(input, "jump_to_prompt"), "offset") };
    case "write_scrollback_file": {
      const parsed = parseWriteScreen(param || "copy");
      return { type: "write_scrollback_file", ...parsed };
    }
    case "write_screen_file": {
      const parsed = parseWriteScreen(param || "copy");
      return { type: "write_screen_file", ...parsed };
    }
    case "write_selection_file": {
      const parsed = parseWriteScreen(param || "copy");
      return { type: "write_selection_file", ...parsed };
    }
    case "new_window":
      return { type: "new_window" };
    case "new_tab":
      return { type: "new_tab" };
    case "previous_tab":
      return { type: "previous_tab" };
    case "next_tab":
      return { type: "next_tab" };
    case "last_tab":
      return { type: "last_tab" };
    case "goto_tab":
      return { type: "goto_tab", index: parseNumber(requireParam(input, "goto_tab"), "tab index") };
    case "move_tab":
      return { type: "move_tab", offset: parseNumber(requireParam(input, "move_tab"), "offset") };
    case "toggle_tab_overview":
      return { type: "toggle_tab_overview" };
    case "prompt_surface_title":
      return { type: "prompt_surface_title" };
    case "prompt_tab_title":
      return { type: "prompt_tab_title" };
    case "set_surface_title":
      return { type: "set_surface_title", title: param };
    case "set_tab_title":
      return { type: "set_tab_title", title: param };
    case "new_split":
      return {
        type: "new_split",
        direction: parseEnum(param || "auto", ["right", "down", "left", "up", "auto"] as const, "split"),
      };
    case "goto_split": {
      // Ghostty accepts top/bottom as aliases for up/down.
      const normalized = param === "top" ? "up" : param === "bottom" ? "down" : param;
      return {
        type: "goto_split",
        direction: parseEnum(normalized, ["previous", "next", "up", "left", "down", "right"] as const, "goto_split"),
      };
    }
    case "goto_window":
      return {
        type: "goto_window",
        direction: parseEnum(param, ["previous", "next"] as const, "goto_window"),
      };
    case "toggle_split_zoom":
      return { type: "toggle_split_zoom" };
    case "toggle_readonly":
      return { type: "toggle_readonly" };
    case "resize_split": {
      const [dir, amountRaw] = param.split(",", 2);
      return {
        type: "resize_split",
        direction: parseEnum(dir ?? "", ["up", "down", "left", "right"] as const, "resize_split"),
        amount: parseNumber(amountRaw || "10", "resize amount"),
      };
    }
    case "equalize_splits":
      return { type: "equalize_splits" };
    case "reset_window_size":
      return { type: "reset_window_size" };
    case "inspector":
      return {
        type: "inspector",
        mode: parseEnum(param || "toggle", ["toggle", "show", "hide"] as const, "inspector"),
      };
    case "show_gtk_inspector":
      return { type: "show_gtk_inspector" };
    case "show_on_screen_keyboard":
      return { type: "show_on_screen_keyboard" };
    case "open_config":
      return { type: "open_config" };
    case "reload_config":
      return { type: "reload_config" };
    case "close_surface":
      return { type: "close_surface" };
    case "close_tab":
      return {
        type: "close_tab",
        mode: parseEnum(param || "this", ["this", "other", "right"] as const, "close_tab"),
      };
    case "close_window":
      return { type: "close_window" };
    case "close_all_windows":
      return { type: "close_all_windows" };
    case "toggle_maximize":
      return { type: "toggle_maximize" };
    case "toggle_fullscreen":
      return { type: "toggle_fullscreen" };
    case "toggle_window_decorations":
      return { type: "toggle_window_decorations" };
    case "toggle_window_float_on_top":
      return { type: "toggle_window_float_on_top" };
    case "toggle_secure_input":
      return { type: "toggle_secure_input" };
    case "toggle_mouse_reporting":
      return { type: "toggle_mouse_reporting" };
    case "toggle_command_palette":
      return { type: "toggle_command_palette" };
    case "toggle_quick_terminal":
      return { type: "toggle_quick_terminal" };
    case "toggle_visibility":
      return { type: "toggle_visibility" };
    case "toggle_background_opacity":
      return { type: "toggle_background_opacity" };
    case "check_for_updates":
      return { type: "check_for_updates" };
    case "undo":
      return { type: "undo" };
    case "redo":
      return { type: "redo" };
    case "end_key_sequence":
      return { type: "end_key_sequence" };
    case "activate_key_table":
      return { type: "activate_key_table", name: param };
    case "activate_key_table_once":
      return { type: "activate_key_table_once", name: param };
    case "deactivate_key_table":
      return { type: "deactivate_key_table" };
    case "deactivate_all_key_tables":
      return { type: "deactivate_all_key_tables" };
    case "quit":
      return { type: "quit" };
    case "crash":
      return {
        type: "crash",
        thread: parseEnum(param || "main", ["main", "io", "render"] as const, "crash"),
      };
    default:
      throw new GhosttyActionParseError(`unknown action: ${name}`);
  }
}

/**
 * Decode the subset of Zig string-literal escapes used in Ghostty config dumps.
 *
 * Ghostty `+list-keybinds` prints text actions with a doubled backslash
 * (`text:\\x05`) so the line is pasteable into a config file. Accept both
 * `\\xNN` (dump form) and `\xNN` (single-escaped).
 */
export function decodeZigStringLiteral(value: string): string {
  let out = "";
  for (let i = 0; i < value.length; i++) {
    const ch = value[i]!;
    if (ch !== "\\") {
      out += ch;
      continue;
    }
    const next = value[i + 1];
    // Dump form: \\x05  → one control character
    if (next === "\\" && (value[i + 2] === "x" || value[i + 2] === "X")) {
      const hex = value.slice(i + 3, i + 5);
      if (/^[0-9a-fA-F]{2}$/.test(hex)) {
        out += String.fromCharCode(parseInt(hex, 16));
        i += 4;
        continue;
      }
    }
    if (next === "x" || next === "X") {
      const hex = value.slice(i + 2, i + 4);
      if (/^[0-9a-fA-F]{2}$/.test(hex)) {
        out += String.fromCharCode(parseInt(hex, 16));
        i += 3;
        continue;
      }
    }
    if (next === "n") {
      out += "\n";
      i += 1;
      continue;
    }
    if (next === "r") {
      out += "\r";
      i += 1;
      continue;
    }
    if (next === "t") {
      out += "\t";
      i += 1;
      continue;
    }
    if (next === "\\" || next === '"' || next === "'") {
      out += next;
      i += 1;
      continue;
    }
    // Unknown escape: keep the following char.
    if (next !== undefined) {
      out += next;
      i += 1;
    }
  }
  return out;
}

export function formatGhosttyAction(action: GhosttyAction): string {
  switch (action.type) {
    case "csi":
    case "esc":
      return `${action.type}:${action.value}`;
    case "text":
      return `text:${encodeZigStringLiteral(action.value)}`;
    case "cursor_key":
      return `cursor_key:${action.normal},${action.application}`;
    case "copy_to_clipboard":
      return `copy_to_clipboard:${action.format}`;
    case "increase_font_size":
      return `increase_font_size:${action.amount}`;
    case "decrease_font_size":
      return `decrease_font_size:${action.amount}`;
    case "set_font_size":
      return `set_font_size:${action.size}`;
    case "search":
      return `search:${action.query}`;
    case "navigate_search":
      return `navigate_search:${action.direction}`;
    case "scroll_to_row":
      return `scroll_to_row:${action.row}`;
    case "scroll_page_fractional":
      return `scroll_page_fractional:${action.amount}`;
    case "scroll_page_lines":
      return `scroll_page_lines:${action.lines}`;
    case "adjust_selection":
      return `adjust_selection:${action.direction}`;
    case "jump_to_prompt":
      return `jump_to_prompt:${action.offset}`;
    case "write_scrollback_file":
    case "write_screen_file":
    case "write_selection_file":
      return `${action.type}:${action.action},${action.format}`;
    case "goto_tab":
      return `goto_tab:${action.index}`;
    case "move_tab":
      return `move_tab:${action.offset}`;
    case "set_surface_title":
      return `set_surface_title:${action.title}`;
    case "set_tab_title":
      return `set_tab_title:${action.title}`;
    case "new_split":
      return `new_split:${action.direction}`;
    case "goto_split":
      return `goto_split:${action.direction}`;
    case "goto_window":
      return `goto_window:${action.direction}`;
    case "resize_split":
      return `resize_split:${action.direction},${action.amount}`;
    case "inspector":
      return `inspector:${action.mode}`;
    case "close_tab":
      return `close_tab:${action.mode}`;
    case "activate_key_table":
      return `activate_key_table:${action.name}`;
    case "activate_key_table_once":
      return `activate_key_table_once:${action.name}`;
    case "crash":
      return `crash:${action.thread}`;
    default:
      return action.type;
  }
}

function encodeZigStringLiteral(value: string): string {
  let out = "";
  for (const ch of value) {
    const code = ch.codePointAt(0)!;
    if (code < 0x20 || code === 0x7f) {
      out += `\\x${code.toString(16).padStart(2, "0")}`;
    } else if (ch === "\\") {
      out += "\\\\";
    } else {
      out += ch;
    }
  }
  return out;
}

export function parseGhostteaBindingAction(raw: string): GhostteaBindingAction {
  if (raw === "ghosttea.remote_sessions") return { type: "ghosttea.remote_sessions" };
  return parseGhosttyAction(raw);
}
