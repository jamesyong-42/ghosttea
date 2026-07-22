import { describe, expect, it } from "vitest";
import type { SessionSummary } from "@vibecook/ghosttea-protocol";
import { insertPane, leaves, mountSessionInPane, pane, persistedWorkspace, restoreNode } from "./pane-layout";

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
    ownerId: null,
  };
}

describe("insertPane", () => {
  it("composes synchronous session additions without losing either pane", () => {
    const first = pane("pane-1", session("one"));
    const second = insertPane(first, pane("pane-2", session("two")), first.id, "horizontal", "split-1");
    const third = insertPane(second, pane("pane-3", session("three")), "pane-2", "vertical", "split-2");
    expect(leaves(third).map((leaf) => leaf.session.id)).toEqual(["one", "two", "three"]);
  });

  it("allows multiple panes to mirror the same session", () => {
    const first = pane("pane-1", session("one"));
    const mirrored = insertPane(first, pane("pane-2", session("one")), first.id, "horizontal", "split-1");
    expect(leaves(mirrored).map((leaf) => leaf.session.id)).toEqual(["one", "one"]);
  });

  it("persists only opaque layout and session identities", () => {
    const sensitive = {
      ...session("one"),
      executable: "/secret/bin/zsh",
      cwd: "/Users/example/private",
      title: "production@example.internal",
      ownerId: "live-owner-claim",
    };
    const first = pane("pane-1", sensitive);
    const document = persistedWorkspace(first, first.id, null);
    expect(document).toEqual({
      version: 1,
      root: { kind: "pane", id: "pane-1", sessionId: "one" },
      activePaneId: "pane-1",
      zoomedPaneId: null,
    });
    const serialized = JSON.stringify(document);
    expect(serialized).not.toContain("secret");
    expect(serialized).not.toContain("private");
    expect(serialized).not.toContain("live-owner-claim");
    expect(restoreNode(document.root, new Map([[sensitive.id, sensitive]]))).toEqual(first);
  });
});

describe("mountSessionInPane", () => {
  it("mounts an existing session without changing another pane that already shows it", () => {
    const first = pane("pane-1", session("one"));
    const layout = insertPane(first, pane("pane-2", session("two")), first.id, "horizontal", "split-1");
    const placed = mountSessionInPane(layout, "pane-1", session("two"));
    expect(leaves(placed).map((leaf) => [leaf.id, leaf.session.id])).toEqual([
      ["pane-1", "two"],
      ["pane-2", "two"],
    ]);
  });

  it("replaces the target when the session is not already visible", () => {
    const layout = pane("pane-1", session("one"));
    expect(leaves(mountSessionInPane(layout, "pane-1", session("three")))[0]?.session.id).toBe("three");
  });
});
