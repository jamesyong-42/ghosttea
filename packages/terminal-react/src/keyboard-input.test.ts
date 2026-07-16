import { describe, expect, it } from "vitest";
import { KeyboardLayoutResolver, terminalKeyDown, terminalKeyUp } from "./keyboard-input";

const key = (overrides: Partial<KeyboardEvent> = {}): KeyboardEvent =>
  ({
    key: "w",
    code: "KeyW",
    location: 0,
    repeat: false,
    shiftKey: false,
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    timeStamp: 10,
    ...overrides,
  }) as KeyboardEvent;

describe("terminal keyboard events", () => {
  it("resolves unshifted printable keys and preserves them on release", () => {
    const resolver = new KeyboardLayoutResolver();
    const down = terminalKeyDown(key(), resolver);
    const up = terminalKeyUp(down, key({ key: "w", timeStamp: 20 }));

    expect(down.unshiftedCodepoint).toBe("w".codePointAt(0));
    expect(up).toMatchObject({
      type: "up",
      key: "w",
      code: "KeyW",
      repeat: false,
      unshiftedCodepoint: "w".codePointAt(0),
      timestamp: 20,
    });
  });

  it("uses the browser keyboard layout for shifted and non-US keys", async () => {
    const resolver = new KeyboardLayoutResolver();
    await resolver.refresh({ getLayoutMap: async () => new Map([["KeyW", "z"]]) });

    expect(resolver.resolve(key({ key: "Z", shiftKey: true }))).toBe("z".codePointAt(0));
  });

  it("falls back conservatively before the asynchronous layout map is ready", () => {
    const resolver = new KeyboardLayoutResolver();

    expect(resolver.resolve(key({ key: "W", shiftKey: true }))).toBe("w".codePointAt(0));
    expect(resolver.resolve(key({ key: "!", code: "Digit1", shiftKey: true }))).toBe("1".codePointAt(0));
    expect(resolver.resolve(key({ key: "ArrowUp", code: "ArrowUp" }))).toBe(0);
  });
});
