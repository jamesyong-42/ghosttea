import { describe, expect, it } from "vitest";
import { isServerEvent, unknownSessionActivity } from "./index";

describe("isServerEvent", () => {
  it("accepts validated responses and unsolicited lifecycle events", () => {
    expect(
      isServerEvent({ requestId: 1, type: "hello", protocolMajor: 1, protocolMinor: 0, serverBuild: "test" }),
    ).toBe(true);
    expect(
      isServerEvent({
        requestId: 0,
        type: "session-exited",
        sessionId: "session",
        exitCode: 0,
        exitSignal: null,
        requestedTermination: null,
        exitOutcome: "completed",
      }),
    ).toBe(true);
    expect(
      isServerEvent({
        requestId: 0,
        type: "session-activity-changed",
        sessionId: "session",
        activity: {
          kind: "foreground-job",
          source: "process-group",
          confidence: "heuristic",
          rootProcessGroupId: 42,
          foregroundProcessGroupId: 43,
          observedAtMs: 100,
        },
      }),
    ).toBe(true);
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
        requestId: 3,
        type: "automation-input-result",
        sessionId: "session",
        accepted: false,
        humanInputEpoch: 7,
        inputSequence: null,
        reason: "human-input-conflict",
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

  it("normalizes activity omitted by an older peer to unknown", () => {
    const message = {
      requestId: 1,
      type: "sessions",
      sessions: [
        {
          id: "session",
          handle: "handle",
          executable: "/bin/zsh",
          cols: 80,
          rows: 24,
          exited: false,
          readWrite: true,
          title: null,
          cwd: null,
          bellCount: 0,
          pid: 42,
          createdAtMs: 1,
          exitCode: null,
          exitSignal: null,
          requestedTermination: null,
          exitOutcome: null,
          ownerId: null,
        },
      ],
    };

    expect(isServerEvent(message)).toBe(true);
    expect(message.sessions[0]).toMatchObject({ activity: unknownSessionActivity() });
  });

  it("rejects unknown and structurally incomplete messages", () => {
    expect(isServerEvent({ requestId: 1, type: "surprise" })).toBe(false);
    expect(isServerEvent({ requestId: 1.5, type: "ok" })).toBe(false);
    expect(isServerEvent({ requestId: 1, type: "session", session: { id: "missing-fields" } })).toBe(false);
    expect(isServerEvent({ requestId: 0, type: "session-exited", sessionId: 3, exitCode: null })).toBe(false);
    expect(isServerEvent({ requestId: 2, type: "remote-sessions", deviceId: "device-a", sessions: [{}] })).toBe(false);
    expect(
      isServerEvent({
        requestId: 0,
        type: "session-activity-changed",
        sessionId: "session",
        activity: {
          kind: "idle",
          source: "process-group",
          confidence: "heuristic",
          rootProcessGroupId: 42,
          foregroundProcessGroupId: 42,
          observedAtMs: 100,
        },
      }),
    ).toBe(false);
  });
});
