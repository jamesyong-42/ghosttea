import { describe, expect, it } from "vitest";
import fixtureJSON from "../../../../apple/GhostteaKit/Tests/GhostteaWorkspaceTests/Fixtures/workspace-conformance-v1.json";
import {
  applyWorkspaceAction,
  decodeWorkspaceDocument,
  type WorkspaceAction,
  type WorkspaceDocumentV1,
  type WorkspaceTransition,
} from "./workspace-model";

interface ConformanceFixture {
  schemaVersion: number;
  scenarios: Array<{
    name: string;
    initial: WorkspaceDocumentV1;
    steps: Array<{ action: WorkspaceAction; expected: WorkspaceTransition }>;
  }>;
}

const fixture = fixtureJSON as ConformanceFixture;

describe("workspace model", () => {
  it("matches every shared cross-platform action vector", () => {
    expect(fixture.schemaVersion).toBe(1);
    for (const scenario of fixture.scenarios) {
      let document = decodeWorkspaceDocument(scenario.initial);
      expect(document, scenario.name).not.toBeNull();
      for (const [index, step] of scenario.steps.entries()) {
        const transition = applyWorkspaceAction(document!, step.action);
        expect(transition, `${scenario.name} step ${index + 1}`).toEqual(step.expected);
        document = transition.document;
      }
    }
  });

  it("rejects stale active panes, duplicate sessions, and unknown versions", () => {
    const initial = fixture.scenarios[0]!.initial;
    expect(decodeWorkspaceDocument({ ...initial, version: 2 })).toBeNull();
    expect(decodeWorkspaceDocument({ ...initial, activePaneId: "missing" })).toBeNull();
    expect(
      decodeWorkspaceDocument({
        ...initial,
        root: {
          kind: "split",
          id: "split",
          axis: "horizontal",
          ratio: 0.5,
          first: initial.root,
          second: { kind: "pane", id: "pane-2", sessionId: "session-1" },
        },
      }),
    ).toBeNull();
  });

  it("clamps finite persisted ratios and defaults malformed ratio values", () => {
    const initial = fixture.scenarios[0]!.initial;
    const split = (ratio: unknown): unknown => ({
      ...initial,
      root: {
        kind: "split",
        id: "split",
        axis: "horizontal",
        ratio,
        first: initial.root,
        second: { kind: "pane", id: "pane-2", sessionId: "session-2" },
      },
    });
    expect((decodeWorkspaceDocument(split(4))!.root as { ratio: number }).ratio).toBe(0.9);
    expect((decodeWorkspaceDocument(split("bad"))!.root as { ratio: number }).ratio).toBe(0.5);
  });
});
