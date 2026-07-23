import { describe, expect, it } from "vitest";
import fixtureJSON from "../../../../apple/GhostteaKit/Tests/GhostteaWorkspaceTests/Fixtures/workspace-tabs-conformance-v1.json";
import type { WorkspaceDocumentV1 } from "./workspace-model";
import {
  applyWorkspaceTabsAction,
  decodeWorkspaceTabsDocument,
  restoreWorkspaceTabsDocument,
  type WorkspaceTabV1,
  type WorkspaceTabsAction,
  type WorkspaceTabsDocumentV1,
} from "./workspace-tabs";

interface TabFixture {
  schemaVersion: number;
  initial: WorkspaceTabsDocumentV1;
  steps: Array<{
    action: WorkspaceTabsAction;
    expected: {
      selectedTabId: string;
      tabIds: string[];
      closedTabId: string | null;
      closedSessionIds: string[];
      shouldCloseWindow: boolean;
    };
  }>;
}

const fixture = fixtureJSON as TabFixture;

describe("workspace tabs model", () => {
  it("matches every shared cross-platform tab transition", () => {
    expect(fixture.schemaVersion).toBe(1);
    let document = decodeWorkspaceTabsDocument(fixture.initial)!;
    expect(document).not.toBeNull();
    for (const [index, step] of fixture.steps.entries()) {
      const transition = applyWorkspaceTabsAction(document, step.action);
      expect(
        {
          selectedTabId: transition.document.selectedTabId,
          tabIds: transition.document.tabs.map((tab) => tab.id),
          closedTabId: transition.closedTabId,
          closedSessionIds: transition.closedSessionIds,
          shouldCloseWindow: transition.shouldCloseWindow,
        },
        `step ${index + 1}`,
      ).toEqual(step.expected);
      document = transition.document;
    }
  });

  it("rejects empty, duplicate, stale, and cross-tab duplicate identities", () => {
    const initial = fixture.initial;
    expect(decodeWorkspaceTabsDocument({ ...initial, version: 2 })).toBeNull();
    expect(decodeWorkspaceTabsDocument({ ...initial, tabs: [] })).toBeNull();
    expect(decodeWorkspaceTabsDocument({ ...initial, selectedTabId: "missing" })).toBeNull();
    expect(decodeWorkspaceTabsDocument({ ...initial, tabs: [initial.tabs[0], initial.tabs[0]] })).toBeNull();
    const duplicateSession: WorkspaceTabV1 = {
      id: "tab-duplicate-session",
      workspace: {
        version: 1,
        root: { kind: "pane", id: "different-pane", sessionId: "session-a" },
        activePaneId: "different-pane",
        zoomedPaneId: null,
      },
    };
    expect(decodeWorkspaceTabsDocument({ ...initial, tabs: [...initial.tabs, duplicateSession] })).toBeNull();
  });

  it("restores only live sessions, collapses panes, and drops empty tabs", () => {
    const restored = restoreWorkspaceTabsDocument(fixture.initial, new Set(["session-b2"]));
    expect(restored).toEqual({
      version: 1,
      selectedTabId: "tab-b",
      tabs: [
        {
          id: "tab-b",
          workspace: {
            version: 1,
            root: { kind: "pane", id: "pane-b2", sessionId: "session-b2" },
            activePaneId: "pane-b2",
            zoomedPaneId: null,
          },
        },
      ],
    });
    expect(restoreWorkspaceTabsDocument(fixture.initial, new Set())).toBeNull();
  });

  it("does not create malformed tabs or reuse a session across tabs", () => {
    const document = decodeWorkspaceTabsDocument(fixture.initial)!;
    const duplicateWorkspace: WorkspaceDocumentV1 = {
      version: 1,
      root: { kind: "pane", id: "new-pane", sessionId: "session-a" },
      activePaneId: "new-pane",
      zoomedPaneId: null,
    };
    expect(
      applyWorkspaceTabsAction(document, {
        type: "create-tab",
        tab: { id: "new-tab", workspace: duplicateWorkspace },
      }).document,
    ).toBe(document);
  });

  it("accepts mirrors within a tab and reports each closed session once", () => {
    const mirrored: WorkspaceDocumentV1 = {
      version: 1,
      root: {
        kind: "split",
        id: "mirror-split",
        axis: "horizontal",
        ratio: 0.5,
        first: { kind: "pane", id: "mirror-a", sessionId: "mirrored-session" },
        second: { kind: "pane", id: "mirror-b", sessionId: "mirrored-session" },
      },
      activePaneId: "mirror-a",
      zoomedPaneId: null,
    };
    const document = decodeWorkspaceTabsDocument({
      version: 1,
      selectedTabId: "mirrored-tab",
      tabs: [
        { id: "mirrored-tab", workspace: mirrored },
        {
          id: "other-tab",
          workspace: {
            version: 1,
            root: { kind: "pane", id: "other-pane", sessionId: "other-session" },
            activePaneId: "other-pane",
            zoomedPaneId: null,
          },
        },
      ],
    });

    expect(document).not.toBeNull();
    expect(applyWorkspaceTabsAction(document!, { type: "close-tab", tabId: "mirrored-tab" }).closedSessionIds).toEqual([
      "mirrored-session",
    ]);
  });
});
