import { describe, expect, it } from "vitest";
import { isServerEvent } from "./index";

describe("isServerEvent", () => {
  it("accepts validated responses and unsolicited lifecycle events", () => {
    expect(
      isServerEvent({ requestId: 1, type: "hello", protocolMajor: 1, protocolMinor: 0, serverBuild: "test" }),
    ).toBe(true);
    expect(isServerEvent({ requestId: 0, type: "session-exited", sessionId: "session", exitCode: 0 })).toBe(true);
    expect(isServerEvent({ requestId: 0, type: "bridge-error", message: "disconnected" })).toBe(true);
  });

  it("rejects unknown and structurally incomplete messages", () => {
    expect(isServerEvent({ requestId: 1, type: "surprise" })).toBe(false);
    expect(isServerEvent({ requestId: 1.5, type: "ok" })).toBe(false);
    expect(isServerEvent({ requestId: 1, type: "session", session: { id: "missing-fields" } })).toBe(false);
    expect(isServerEvent({ requestId: 0, type: "session-exited", sessionId: 3, exitCode: null })).toBe(false);
  });
});
