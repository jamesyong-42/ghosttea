import type { TerminalKeyEvent } from "@vibecook/ghosttea-protocol";

type KeyboardEventLike = Pick<
  KeyboardEvent,
  "key" | "code" | "location" | "repeat" | "shiftKey" | "ctrlKey" | "altKey" | "metaKey" | "timeStamp"
>;

export interface KeyboardLayoutMapLike {
  get(code: string): string | undefined;
}

export interface KeyboardLayoutSource {
  getLayoutMap(): Promise<KeyboardLayoutMapLike>;
}

const US_CODE_FALLBACKS: Readonly<Record<string, string>> = {
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

function singleCodepoint(text: string | undefined): number {
  if (!text) return 0;
  const scalars = [...text];
  if (scalars.length !== 1) return 0;
  const codepoint = scalars[0]!.codePointAt(0) ?? 0;
  return codepoint >= 0x20 && codepoint !== 0x7f ? codepoint : 0;
}

function normalizedLetter(text: string): string | undefined {
  if (![...text].length || !/^\p{L}$/u.test(text)) return undefined;
  const lower = text.toLocaleLowerCase();
  return [...lower].length === 1 ? lower : undefined;
}

function codeFallback(code: string): string | undefined {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3).toLowerCase();
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  return US_CODE_FALLBACKS[code];
}

function browserKeyboard(): KeyboardLayoutSource | undefined {
  if (typeof navigator === "undefined") return undefined;
  return (navigator as Navigator & { keyboard?: KeyboardLayoutSource }).keyboard;
}

export class KeyboardLayoutResolver {
  #layout: KeyboardLayoutMapLike | undefined;
  readonly #observed = new Map<string, string>();
  #refreshing: Promise<void> | undefined;

  refresh(source: KeyboardLayoutSource | undefined = browserKeyboard()): Promise<void> {
    if (!source) return Promise.resolve();
    this.#refreshing ??= source
      .getLayoutMap()
      .then((layout) => {
        this.#layout = layout;
      })
      .catch(() => undefined)
      .finally(() => {
        this.#refreshing = undefined;
      });
    return this.#refreshing;
  }

  resolve(event: Pick<KeyboardEventLike, "key" | "code" | "shiftKey" | "altKey">): number {
    const letter = normalizedLetter(event.key);
    if (!event.shiftKey && !event.altKey) {
      const observed = letter ?? (singleCodepoint(event.key) ? event.key : undefined);
      if (observed) this.#observed.set(event.code, observed);
    }

    const mapped = this.#layout?.get(event.code);
    const observed = this.#observed.get(event.code);
    const unmodifiedKey = !event.shiftKey && !event.altKey ? event.key : letter;
    return singleCodepoint(mapped ?? observed ?? unmodifiedKey ?? codeFallback(event.code));
  }
}

export const terminalKeyboardLayout = new KeyboardLayoutResolver();

export function terminalKeyDown(
  event: KeyboardEventLike,
  resolver: KeyboardLayoutResolver = terminalKeyboardLayout,
): TerminalKeyEvent {
  return {
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
    unshiftedCodepoint: resolver.resolve(event),
  };
}

export function terminalKeyUp(pressed: TerminalKeyEvent, event: KeyboardEventLike): TerminalKeyEvent {
  return {
    ...pressed,
    type: "up",
    repeat: false,
    shift: event.shiftKey,
    control: event.ctrlKey,
    alt: event.altKey,
    meta: event.metaKey,
    timestamp: event.timeStamp,
  };
}
