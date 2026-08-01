import { describe, expect, it } from "vitest";
import { unknownSessionActivity, type SessionSummary } from "@vibecook/ghosttea-protocol";
import {
  collectDeadPanes,
  insertPane,
  leaves,
  mountSessionInPane,
  pane,
  persistedWorkspace,
  restoreNode,
} from "./pane-layout";

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
    persistence: null,
    activity: unknownSessionActivity(),
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

describe("pane meta and rehydration", () => {
  it("persists paneMeta verbatim and omits the key when unset or undefined", () => {
    const first = pane("pane-1", session("one"));
    const layout = insertPane(first, pane("pane-2", session("two")), first.id, "vertical", "split-1");
    const withMeta = persistedWorkspace(layout, "pane-1", null, (candidate, paneId) =>
      candidate.id === "one" ? { cwd: "/repo/api", paneId } : undefined,
    );
    expect(withMeta.root).toEqual({
      kind: "split",
      id: "split-1",
      axis: "vertical",
      ratio: 0.5,
      first: { kind: "pane", id: "pane-1", sessionId: "one", meta: { cwd: "/repo/api", paneId: "pane-1" } },
      second: { kind: "pane", id: "pane-2", sessionId: "two" },
    });
    expect(JSON.stringify(persistedWorkspace(layout, "pane-1", null))).not.toContain("meta");
  });

  it("collects dead panes with their meta in tree order and skips live ones", () => {
    const layout = insertPane(
      insertPane(pane("pane-1", session("one")), pane("pane-2", session("two")), "pane-1", "horizontal", "split-1"),
      pane("pane-3", session("three")),
      "pane-2",
      "vertical",
      "split-2",
    );
    const document = persistedWorkspace(layout, "pane-1", null, (candidate) => ({ from: candidate.id }));
    const live = new Map([["two", session("two")]]);
    expect(collectDeadPanes(document.root, live)).toEqual([
      { paneId: "pane-1", sessionId: "one", meta: { from: "one" } },
      { paneId: "pane-3", sessionId: "three", meta: { from: "three" } },
    ]);
  });

  it("collects dead panes from legacy documents that stored whole sessions", () => {
    const legacy = { kind: "pane", id: "pane-1", session: { id: "old" } };
    expect(collectDeadPanes(legacy, new Map())).toEqual([{ paneId: "pane-1", sessionId: "old", meta: undefined }]);
  });

  it("revives dead panes by pane id, preserving split shape and saved ratio", () => {
    const savedRoot = {
      kind: "split",
      id: "split-1",
      axis: "vertical",
      ratio: 0.3,
      first: { kind: "pane", id: "pane-1", sessionId: "one" },
      second: { kind: "pane", id: "pane-2", sessionId: "gone", meta: { cwd: "/repo" } },
    };
    const live = new Map([["one", session("one")]]);
    const revived = session("fresh");
    expect(restoreNode(savedRoot, live, new Map([["pane-2", revived]]))).toEqual({
      kind: "split",
      id: "split-1",
      axis: "vertical",
      ratio: 0.3,
      first: pane("pane-1", session("one")),
      second: pane("pane-2", revived),
    });
    expect(restoreNode(savedRoot, live)).toEqual(pane("pane-1", session("one")));
  });
});
