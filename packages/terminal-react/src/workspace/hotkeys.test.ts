import { describe, expect, it } from "vitest";
import fixtureJSON from "../../../../apple/GhostteaKit/Tests/GhostteaWorkspaceTests/Fixtures/workspace-command-conformance-v1.json";
import { ghosttyHotkey, workspaceCommandId, type GhosttyHotkey } from "./hotkeys";

interface CommandFixture {
  vectors: Array<{
    key: string;
    meta?: boolean;
    shift?: boolean;
    alt?: boolean;
    control?: boolean;
    expected: GhosttyHotkey | null;
    commandId: string | null;
  }>;
}

describe("workspace command shortcuts", () => {
  it("matches every shared desktop/iOS command vector", () => {
    for (const vector of (fixtureJSON as CommandFixture).vectors) {
      const command = ghosttyHotkey({
        key: vector.key,
        metaKey: vector.meta ?? false,
        shiftKey: vector.shift ?? false,
        altKey: vector.alt ?? false,
        ctrlKey: vector.control ?? false,
      });
      expect(command, vector.key).toEqual(vector.expected);
      expect(command ? workspaceCommandId(command) : null, vector.key).toBe(vector.commandId);
    }
  });
});
