import { describe, expect, it } from "vitest";
import { CursorStyle, type CursorState } from "@vibecook/ghosttea-frame";
import { cursorActivityChangesPixels } from "./cursor-invalidation";

const blinkingCursor: CursorState = {
  x: 1,
  y: 2,
  visible: true,
  blinking: true,
  style: CursorStyle.Block,
};

describe("cursor activity invalidation", () => {
  it("redraws only when activity reveals a focused blinking cursor", () => {
    expect(cursorActivityChangesPixels(blinkingCursor, true, false)).toBe(true);
    expect(cursorActivityChangesPixels(blinkingCursor, true, true)).toBe(false);
    expect(cursorActivityChangesPixels(blinkingCursor, false, false)).toBe(false);
    expect(cursorActivityChangesPixels({ ...blinkingCursor, blinking: false }, true, false)).toBe(false);
    expect(cursorActivityChangesPixels({ ...blinkingCursor, visible: false }, true, false)).toBe(false);
  });
});
