import type { SessionSummary } from "@vibecook/ghosttea-protocol";
import { describe, expect, it } from "vitest";
import { sessionsToClaim } from "./session-scope";

const session = (id: string, exited = false): SessionSummary => ({ id, handle: id, exited }) as SessionSummary;

describe("sessionsToClaim", () => {
  it("claims only live sessions not already restored", () => {
    expect(
      sessionsToClaim([session("restored"), session("orphan"), session("exited", true)], new Set(["restored"]), true),
    ).toEqual([session("orphan")]);
  });

  it("keeps a new tab isolated from sessions owned by other tabs", () => {
    expect(sessionsToClaim([session("other-tab")], new Set(), false)).toEqual([]);
  });
});
