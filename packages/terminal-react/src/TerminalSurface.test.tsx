import { isValidElement } from "react";
import type { SessionSummary } from "@vibecook/ghosttea-protocol";
import { describe, expect, it } from "vitest";
import { TerminalSurface } from "./TerminalSurface";
import { DEFAULT_THEME } from "./renderers/types";

function session(id: string, handle: string): SessionSummary {
  return {
    id,
    handle,
    executable: "/bin/sh",
    cols: 80,
    rows: 24,
    exited: false,
    title: null,
    cwd: null,
    bellCount: 0,
    pid: 1,
    createdAtMs: 1,
    exitCode: null,
    exitSignal: null,
    requestedTermination: null,
    exitOutcome: null,
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
