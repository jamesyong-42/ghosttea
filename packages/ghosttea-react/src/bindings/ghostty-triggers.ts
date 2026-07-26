/**
 * Ghostty keybind trigger parsing and keyboard-event matching.
 *
 * Trigger grammar mirrors Ghostty dumps from `+list-keybinds --default --plain`:
 *   super+shift+t
 *   ctrl+tab
 *   super+digit_1
 *   super+=
 *   copy / paste   (non-keyboard pseudo-triggers for edit menu)
 */

export type GhosttyMods = {
  super: boolean;
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
};

export type GhosttyTriggerKey =
  { kind: "unicode"; value: string } | { kind: "physical"; name: string } | { kind: "special"; name: "copy" | "paste" };

export type GhosttyTrigger = {
  mods: GhosttyMods;
  key: GhosttyTriggerKey;
};

export class GhosttyTriggerParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GhosttyTriggerParseError";
  }
}

const PHYSICAL_KEYS = new Set([
  "arrow_left",
  "arrow_right",
  "arrow_up",
  "arrow_down",
  "page_up",
  "page_down",
  "home",
  "end",
  "tab",
  "enter",
  "escape",
  "backspace",
  "delete",
  "insert",
  "space",
  "f1",
  "f2",
  "f3",
  "f4",
  "f5",
  "f6",
  "f7",
  "f8",
  "f9",
  "f10",
  "f11",
  "f12",
  "digit_0",
  "digit_1",
  "digit_2",
  "digit_3",
  "digit_4",
  "digit_5",
  "digit_6",
  "digit_7",
  "digit_8",
  "digit_9",
]);

/** DOM `code` → unshifted US-layout character for binding lookup. */
const CODE_UNSHIFTED: Readonly<Record<string, string>> = {
  Backquote: "`",
  Backslash: "\\",
  BracketLeft: "[",
  BracketRight: "]",
  Comma: ",",
  Equal: "=",
  Minus: "-",
  Period: ".",
  Quote: "'",
  Semicolon: ";",
  Slash: "/",
  Space: " ",
};

const CODE_PHYSICAL: Readonly<Record<string, string>> = {
  ArrowLeft: "arrow_left",
  ArrowRight: "arrow_right",
  ArrowUp: "arrow_up",
  ArrowDown: "arrow_down",
  PageUp: "page_up",
  PageDown: "page_down",
  Home: "home",
  End: "end",
  Tab: "tab",
  Enter: "enter",
  Escape: "escape",
  Backspace: "backspace",
  Delete: "delete",
  Insert: "insert",
  Space: "space",
  F1: "f1",
  F2: "f2",
  F3: "f3",
  F4: "f4",
  F5: "f5",
  F6: "f6",
  F7: "f7",
  F8: "f8",
  F9: "f9",
  F10: "f10",
  F11: "f11",
  F12: "f12",
  Digit0: "digit_0",
  Digit1: "digit_1",
  Digit2: "digit_2",
  Digit3: "digit_3",
  Digit4: "digit_4",
  Digit5: "digit_5",
  Digit6: "digit_6",
  Digit7: "digit_7",
  Digit8: "digit_8",
  Digit9: "digit_9",
};

export type KeyEventLike = Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey"> & {
  /** DOM `code` when available; matching still works from `key` alone. */
  code?: string;
};

export function emptyMods(): GhosttyMods {
  return { super: false, ctrl: false, shift: false, alt: false };
}

const MOD_PREFIX = /^(super|cmd|command|ctrl|control|shift|alt|opt|option)\+/i;

export function parseGhosttyTrigger(raw: string): GhosttyTrigger {
  const input = raw.trim();
  if (!input) throw new GhosttyTriggerParseError("empty trigger");

  if (input === "copy" || input === "paste") {
    return { mods: emptyMods(), key: { kind: "special", name: input } };
  }

  // Peel modifiers from the left so keys like `+` and `=` work:
  //   super++  → super + key "+"
  //   super+=  → super + key "="
  //   super+shift+, → super+shift + key ","
  const mods = emptyMods();
  let rest = input;
  while (true) {
    const match = rest.match(MOD_PREFIX);
    if (!match) break;
    switch (match[1]!.toLowerCase()) {
      case "super":
      case "cmd":
      case "command":
        mods.super = true;
        break;
      case "ctrl":
      case "control":
        mods.ctrl = true;
        break;
      case "shift":
        mods.shift = true;
        break;
      case "alt":
      case "opt":
      case "option":
        mods.alt = true;
        break;
      default:
        throw new GhosttyTriggerParseError(`unknown modifier: ${match[1]}`);
    }
    rest = rest.slice(match[0].length);
  }

  if (!rest) throw new GhosttyTriggerParseError(`missing key in trigger: ${raw}`);

  if (PHYSICAL_KEYS.has(rest)) {
    return { mods, key: { kind: "physical", name: rest } };
  }

  // Unicode key: typically one codepoint (`c`, `[`, `+`, `=`).
  return { mods, key: { kind: "unicode", value: rest } };
}

export function formatGhosttyTrigger(trigger: GhosttyTrigger): string {
  if (trigger.key.kind === "special") return trigger.key.name;
  const parts: string[] = [];
  if (trigger.mods.super) parts.push("super");
  if (trigger.mods.ctrl) parts.push("ctrl");
  if (trigger.mods.alt) parts.push("alt");
  if (trigger.mods.shift) parts.push("shift");
  parts.push(trigger.key.kind === "physical" ? trigger.key.name : trigger.key.value);
  return parts.join("+");
}

export function modsMatch(a: GhosttyMods, b: GhosttyMods): boolean {
  return a.super === b.super && a.ctrl === b.ctrl && a.shift === b.shift && a.alt === b.alt;
}

export function eventMods(event: KeyEventLike): GhosttyMods {
  return {
    super: event.metaKey,
    ctrl: event.ctrlKey,
    shift: event.shiftKey,
    alt: event.altKey,
  };
}

function physicalFromEvent(event: KeyEventLike): string | undefined {
  if (event.code && CODE_PHYSICAL[event.code]) return CODE_PHYSICAL[event.code];
  const key = event.key.toLowerCase();
  const fromKey: Record<string, string> = {
    arrowleft: "arrow_left",
    arrowright: "arrow_right",
    arrowup: "arrow_up",
    arrowdown: "arrow_down",
    pageup: "page_up",
    pagedown: "page_down",
    home: "home",
    end: "end",
    tab: "tab",
    enter: "enter",
    escape: "escape",
    backspace: "backspace",
    delete: "delete",
    insert: "insert",
    " ": "space",
  };
  return fromKey[key];
}

function unicodeCandidates(event: KeyEventLike): string[] {
  const out: string[] = [];
  const key = event.key;
  if (key && key !== "Dead" && key !== "Unidentified") {
    // Letters: Ghostty dumps lowercase unicode.
    if (/^\p{L}$/u.test(key)) out.push(key.toLowerCase());
    else if (key.length === 1) out.push(key);
    // Shifted punctuation still needs the unshifted binding key.
    if (key === "{") out.push("[");
    if (key === "}") out.push("]");
    if (key === "_") out.push("-");
    if (key === "+") out.push("=");
    if (key === "<") out.push(",");
    if (key === ">") out.push(".");
    if (key === "?" || key === "/") out.push("/");
    if (key === ":" || key === ";") out.push(";");
    if (key === '"' || key === "'") out.push("'");
  }
  const code = event.code;
  if (code) {
    const fromCode = CODE_UNSHIFTED[code];
    if (fromCode) out.push(fromCode);
    if (/^Key[A-Z]$/.test(code)) out.push(code.slice(3).toLowerCase());
    if (/^Digit[0-9]$/.test(code)) out.push(code.slice(5));
    if (code === "Equal") out.push("+");
  }
  // Also accept "+" as its own unicode key (German layouts / dedicated plus).
  if (key === "+") out.push("+");
  return [...new Set(out)];
}

/** True if this keyboard event satisfies the Ghostty trigger. */
export function triggerMatchesEvent(trigger: GhosttyTrigger, event: KeyEventLike): boolean {
  if (trigger.key.kind === "special") return false;
  if (!modsMatch(trigger.mods, eventMods(event))) return false;

  if (trigger.key.kind === "physical") {
    return physicalFromEvent(event) === trigger.key.name;
  }

  const candidates = unicodeCandidates(event);
  return candidates.includes(trigger.key.value);
}

/** Build a synthetic keyboard event that should match the given trigger (for tests). */
export function synthesizeKeyEvent(trigger: GhosttyTrigger): KeyEventLike | null {
  if (trigger.key.kind === "special") return null;

  const base = {
    metaKey: trigger.mods.super,
    ctrlKey: trigger.mods.ctrl,
    altKey: trigger.mods.alt,
    shiftKey: trigger.mods.shift,
  };

  if (trigger.key.kind === "physical") {
    const name = trigger.key.name;
    const physicalToDom: Record<string, { key: string; code: string }> = {
      arrow_left: { key: "ArrowLeft", code: "ArrowLeft" },
      arrow_right: { key: "ArrowRight", code: "ArrowRight" },
      arrow_up: { key: "ArrowUp", code: "ArrowUp" },
      arrow_down: { key: "ArrowDown", code: "ArrowDown" },
      page_up: { key: "PageUp", code: "PageUp" },
      page_down: { key: "PageDown", code: "PageDown" },
      home: { key: "Home", code: "Home" },
      end: { key: "End", code: "End" },
      tab: { key: "Tab", code: "Tab" },
      enter: { key: "Enter", code: "Enter" },
      escape: { key: "Escape", code: "Escape" },
      backspace: { key: "Backspace", code: "Backspace" },
      delete: { key: "Delete", code: "Delete" },
      insert: { key: "Insert", code: "Insert" },
      space: { key: " ", code: "Space" },
      f1: { key: "F1", code: "F1" },
      f2: { key: "F2", code: "F2" },
      f3: { key: "F3", code: "F3" },
      f4: { key: "F4", code: "F4" },
      f5: { key: "F5", code: "F5" },
      f6: { key: "F6", code: "F6" },
      f7: { key: "F7", code: "F7" },
      f8: { key: "F8", code: "F8" },
      f9: { key: "F9", code: "F9" },
      f10: { key: "F10", code: "F10" },
      f11: { key: "F11", code: "F11" },
      f12: { key: "F12", code: "F12" },
      digit_0: { key: "0", code: "Digit0" },
      digit_1: { key: "1", code: "Digit1" },
      digit_2: { key: "2", code: "Digit2" },
      digit_3: { key: "3", code: "Digit3" },
      digit_4: { key: "4", code: "Digit4" },
      digit_5: { key: "5", code: "Digit5" },
      digit_6: { key: "6", code: "Digit6" },
      digit_7: { key: "7", code: "Digit7" },
      digit_8: { key: "8", code: "Digit8" },
      digit_9: { key: "9", code: "Digit9" },
    };
    const mapped = physicalToDom[name];
    if (!mapped) return null;
    return { ...base, ...mapped };
  }

  const value = trigger.key.value;
  if (/^[a-z0-9]$/i.test(value)) {
    const lower = value.toLowerCase();
    const isDigit = /^[0-9]$/.test(lower);
    return {
      ...base,
      key: trigger.mods.shift && !isDigit ? lower.toUpperCase() : lower,
      code: isDigit ? `Digit${lower}` : `Key${lower.toUpperCase()}`,
    };
  }

  const unicodeToCode: Record<string, string> = {
    "[": "BracketLeft",
    "]": "BracketRight",
    "=": "Equal",
    "+": "Equal",
    "-": "Minus",
    ",": "Comma",
    ".": "Period",
    "/": "Slash",
    ";": "Semicolon",
    "'": "Quote",
    "`": "Backquote",
    "\\": "Backslash",
    " ": "Space",
  };

  // When shift is part of the binding, browsers often report the shifted glyph.
  let key = value;
  if (trigger.mods.shift) {
    if (value === "[") key = "{";
    else if (value === "]") key = "}";
    else if (value === "=") key = "+";
    else if (value === "-") key = "_";
    else if (value === ",") key = "<";
    else if (value === ".") key = ">";
    else if (value === "/") key = "?";
    else if (value === ";") key = ":";
    else if (value === "'") key = '"';
  }

  return {
    ...base,
    key,
    code: unicodeToCode[value] ?? `Key${value.toUpperCase()}`,
  };
}
