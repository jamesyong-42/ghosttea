import { isValidElement } from "react";
import { unknownSessionActivity, type SessionSummary } from "@vibecook/ghosttea-protocol";
import { describe, expect, it } from "vitest";
import { TerminalSurface, viewportSelection } from "./TerminalSurface";
import { DEFAULT_THEME } from "./renderers/types";

function session(id: string, handle: string): SessionSummary {
  return {
    id,
    handle,
    executable: "/bin/sh",
    cols: 80,
    rows: 24,
    exited: false,
    readWrite: true,
    title: null,
    cwd: null,
    bellCount: 0,
    pid: 1,
    createdAtMs: 1,
    exitCode: null,
    exitSignal: null,
    requestedTermination: null,
    exitOutcome: null,
    ownerId: null,
    activity: unknownSessionActivity(),
  };
}

describe("TerminalSurface session ownership", () => {
  it("gives each session a distinct component boundary", () => {
    const first = TerminalSurface({ session: session("first", "11"), theme: DEFAULT_THEME });
    const second = TerminalSurface({ session: session("second", "22"), theme: DEFAULT_THEME });

    expect(isValidElement(first)).toBe(true);
    expect(isValidElement(second)).toBe(true);
    expect(first.key).toBe("first:11");
    expect(second.key).toBe("second:22");
  });
});

describe("viewportSelection", () => {
  it("keeps absolute selections attached to their scrollback rows", () => {
    const selection = { anchor: { column: 3, row: 40 }, focus: { column: 8, row: 60 } };
    expect(viewportSelection(selection, { total: 100, offset: 50, length: 10 }, 80, 10)).toEqual({
      anchor: { column: 0, row: 0 },
      focus: { column: 79, row: 9 },
    });
    expect(viewportSelection(selection, { total: 100, offset: 70, length: 10 }, 80, 10)).toBeNull();
  });
});
