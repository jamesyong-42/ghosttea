import { describe, expect, it } from "vitest";
import type { SessionSummary } from "@vibecook/ghosttea-protocol";
import {
  containsPane,
  equalize,
  leaves,
  pane,
  removePane,
  resizeForPane,
  restoreNode,
  type PaneNode,
} from "@vibecook/ghosttea-react/workspace";

const session = (id: string): SessionSummary => ({
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
  pid: 123,
  createdAtMs: 1,
  exitCode: null,
  exitSignal: null,
  requestedTermination: null,
  exitOutcome: null,
});

describe("pane layout", () => {
  it("restores live sessions and collapses branches whose sessions disappeared", () => {
    const saved = {
      kind: "split",
      id: "split",
      axis: "horizontal",
      ratio: 0.7,
      first: { kind: "pane", id: "left", session: session("live") },
      second: { kind: "pane", id: "right", session: session("gone") },
    };
    const restored = restoreNode(saved, new Map([["live", session("live")]]));
    expect(restored).toEqual(pane("left", session("live")));
  });

  it("removes a nested pane without leaving an empty split", () => {
    const layout: PaneNode = {
      kind: "split",
      id: "root",
      axis: "horizontal",
      ratio: 0.5,
      first: pane("one", session("one")),
      second: {
        kind: "split",
        id: "nested",
        axis: "vertical",
        ratio: 0.4,
        first: pane("two", session("two")),
        second: pane("three", session("three")),
      },
    };
    const next = removePane(layout, "two");
    expect(leaves(next ?? undefined).map((leaf) => leaf.id)).toEqual(["one", "three"]);
    expect(containsPane(next!, "two")).toBe(false);
  });

  it("resizes the nearest matching split with safe bounds and can equalize the tree", () => {
    const layout: PaneNode = {
      kind: "split",
      id: "root",
      axis: "horizontal",
      ratio: 0.88,
      first: pane("one", session("one")),
      second: pane("two", session("two")),
    };
    const [resized, changed] = resizeForPane(layout, "one", "horizontal", 0.5);
    expect(changed).toBe(true);
    expect(resized.kind === "split" && resized.ratio).toBe(0.9);
    const equal = equalize(resized);
    expect(equal.kind === "split" && equal.ratio).toBe(0.5);
  });
});
