import { describe, expect, it } from "vitest";
import type { SessionSummary } from "@vibecook/ghosttea-protocol";
import { insertPane, leaves, pane } from "./pane-layout";

function session(id: string): SessionSummary {
  return {
    id,
    handle: id,
    executable: "/bin/zsh",
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
  };
}

describe("insertPane", () => {
  it("composes synchronous session additions without losing either pane", () => {
    const first = pane("pane-1", session("one"));
    const second = insertPane(first, pane("pane-2", session("two")), first.id, "horizontal", "split-1");
    const third = insertPane(second, pane("pane-3", session("three")), "pane-2", "vertical", "split-2");
    expect(leaves(third).map((leaf) => leaf.session.id)).toEqual(["one", "two", "three"]);
  });

  it("does not add the same session twice", () => {
    const first = pane("pane-1", session("one"));
    expect(insertPane(first, pane("pane-2", session("one")), first.id, "horizontal", "split-1")).toBe(first);
  });
});
