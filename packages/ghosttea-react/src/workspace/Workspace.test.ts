import { describe, expect, it, vi } from "vitest";
import { workspaceOwnsHotkey } from "./Workspace";

describe("workspaceOwnsHotkey", () => {
  it("allows only the active workspace containing the event or focused element", () => {
    const eventTarget = new EventTarget();
    const focused = new EventTarget();
    const root = { contains: vi.fn((candidate: EventTarget | null) => candidate === focused) };

    vi.stubGlobal("Node", EventTarget);
    expect(workspaceOwnsHotkey(true, root as never, eventTarget, focused as never)).toBe(true);
    expect(workspaceOwnsHotkey(false, root as never, eventTarget, focused as never)).toBe(false);
    expect(workspaceOwnsHotkey(true, { contains: () => false } as never, eventTarget, focused as never)).toBe(false);
    vi.unstubAllGlobals();
  });
});
