import { afterEach, describe, expect, it, vi } from "vitest";
import { unknownSessionActivity, type SessionSummary } from "@vibecook/ghosttea-protocol";
import { initializeWorkspace, workspaceOwnsHotkey, type GhostteaPaneRehydration } from "./Workspace";
import { pane } from "./pane-layout";

describe("workspaceOwnsHotkey", () => {
  it("allows only the active workspace containing the event or focused element", () => {
    const eventTarget = new EventTarget();
    const focused = new EventTarget();
    const root = { contains: vi.fn((candidate: EventTarget | null) => candidate === focused) };

    vi.stubGlobal("Node", EventTarget);
    expect(workspaceOwnsHotkey(true, root as never, eventTarget, focused as never)).toBe(true);
    expect(workspaceOwnsHotkey(false, root as never, eventTarget, focused as never)).toBe(false);
    expect(workspaceOwnsHotkey(true, { contains: () => false } as never, eventTarget, focused as never)).toBe(false);
    expect(workspaceOwnsHotkey(true, root as never, eventTarget, focused as never, true)).toBe(false);
    vi.unstubAllGlobals();
  });
});

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

const SAVED = {
  version: 1,
  root: {
    kind: "split",
    id: "split-1",
    axis: "vertical",
    ratio: 0.3,
    first: { kind: "pane", id: "pane-1", sessionId: "live" },
    second: { kind: "pane", id: "pane-2", sessionId: "gone", meta: { cwd: "/repo" } },
  },
  activePaneId: "pane-2",
  zoomedPaneId: null,
};

function stubStorage(saved: unknown): void {
  const storage = new Map([["ghosttea:test", JSON.stringify(saved)]]);
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => void storage.set(key, value),
  });
}

function fakeRuntime(live: SessionSummary[]) {
  return {
    connect: async () => {},
    listSessions: async () => live,
    registerSession: vi.fn(),
    createSession: async () => {
      throw new Error("initialization should not create a fallback session");
    },
  };
}

describe("initializeWorkspace pane rehydration", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("keeps a dead pane and its split in place when the embedder revives it", async () => {
    const live = session("live");
    const revived = session("fresh");
    stubStorage(SAVED);
    const runtime = fakeRuntime([live]);
    const rehydrate = vi.fn((_context: GhostteaPaneRehydration) => Promise.resolve<SessionSummary | null>(revived));

    const workspace = await initializeWorkspace(
      runtime as never,
      "ghosttea:test",
      "/bin/zsh",
      true,
      undefined,
      rehydrate,
    );

    expect(rehydrate).toHaveBeenCalledExactlyOnceWith({ meta: { cwd: "/repo" }, sessionId: "gone", paneId: "pane-2" });
    expect(workspace.layout).toEqual({
      kind: "split",
      id: "split-1",
      axis: "vertical",
      ratio: 0.3,
      first: pane("pane-1", live),
      second: pane("pane-2", revived),
    });
    expect(workspace.activePaneId).toBe("pane-2");
    expect(runtime.registerSession).toHaveBeenCalledWith(revived);
  });

  it("collapses to today's behavior when rehydration declines or fails", async () => {
    const live = session("live");
    for (const rehydrate of [
      () => null,
      () => {
        throw new Error("boom");
      },
      () => Promise.reject(new Error("boom")),
    ]) {
      stubStorage(SAVED);
      const runtime = fakeRuntime([live]);
      const workspace = await initializeWorkspace(
        runtime as never,
        "ghosttea:test",
        "/bin/zsh",
        true,
        undefined,
        rehydrate,
      );
      expect(workspace.layout).toEqual(pane("pane-1", live));
      expect(workspace.activePaneId).toBe("pane-1");
      expect(runtime.registerSession).not.toHaveBeenCalled();
    }
  });
});
