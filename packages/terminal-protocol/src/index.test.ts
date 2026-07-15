import { describe, expect, it } from "vitest";
import { isServerEvent } from "./index";

describe("isServerEvent", () => {
  it("accepts validated responses and unsolicited lifecycle events", () => {
    expect(
      isServerEvent({ requestId: 1, type: "hello", protocolMajor: 1, protocolMinor: 0, serverBuild: "test" }),
    ).toBe(true);
    expect(isServerEvent({ requestId: 0, type: "session-exited", sessionId: "session", exitCode: 0 })).toBe(true);
    expect(isServerEvent({ requestId: 0, type: "bridge-error", message: "disconnected" })).toBe(true);
    expect(
      isServerEvent({
        requestId: 0,
        type: "control-changed",
        sessionId: "session",
        controllerViewId: "view",
        controlEpoch: 2,
        cols: 120,
        rows: 40,
        layoutEpoch: 3,
      }),
    ).toBe(true);
    expect(
      isServerEvent({
        requestId: 2,
        type: "remote-hosts",
        hosts: [
          {
            deviceId: "device-a",
            deviceName: "Studio",
            online: true,
            protocolMajor: 1,
            protocolMinor: 0,
            hostInstanceId: "host-a",
            sessions: [
              {
                sessionId: "session-a",
                title: "codex",
                cwdLabel: "/work",
                running: true,
                attachable: true,
                readWrite: false,
                createdAtMs: 42,
              },
            ],
          },
        ],
      }),
    ).toBe(true);
  });

  it("rejects unknown and structurally incomplete messages", () => {
    expect(isServerEvent({ requestId: 1, type: "surprise" })).toBe(false);
    expect(isServerEvent({ requestId: 1.5, type: "ok" })).toBe(false);
    expect(isServerEvent({ requestId: 1, type: "session", session: { id: "missing-fields" } })).toBe(false);
    expect(isServerEvent({ requestId: 0, type: "session-exited", sessionId: 3, exitCode: null })).toBe(false);
    expect(isServerEvent({ requestId: 2, type: "remote-sessions", deviceId: "device-a", sessions: [{}] })).toBe(false);
  });
});
