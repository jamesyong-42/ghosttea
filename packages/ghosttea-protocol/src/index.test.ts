import { describe, expect, it } from "vitest";
import { isRendererClientCommandAllowed, isServerEvent, unknownSessionActivity } from "./index";

describe("isServerEvent", () => {
  it("allows reviewed renderer commands and rejects privileged or unknown commands", () => {
    expect(isRendererClientCommandAllowed({ requestId: 1, type: "get-config" })).toBe(true);
    expect(isRendererClientCommandAllowed({ requestId: 2, type: "replace-config-document" })).toBe(false);
    expect(isRendererClientCommandAllowed({ requestId: 3, type: "future-command" })).toBe(false);
  });

  const config = {
    schemaVersion: 1,
    revision: "abc123",
    compatibility: {
      ghosttyVersion: "1.3.1",
      ghosttyCommit: "f8041e7",
      knownKeyCount: 200,
    },
    sources: [{ path: "/tmp/config.ghostty", kind: "ghosttea-overlay" }],
    diagnostics: [],
    configuredKeys: [{ key: "background", support: "applied", occurrences: 1 }],
    terminal: {
      scrollbackBytes: 10_000_000,
      foreground: [255, 255, 255],
      background: [40, 44, 52],
      cursor: [255, 255, 255],
    },
    renderer: {
      foreground: [255, 255, 255],
      background: [40, 44, 52],
      cursor: [255, 255, 255],
      selectionBackground: [255, 255, 255],
      selectionForeground: [40, 44, 52],
      fontSize: 13,
      fontFamilies: [],
      paddingX: [2, 2],
      paddingY: [2, 2],
      postProcess: "none",
      customShaderPaths: [],
    },
    workspace: {
      keybindings: [],
      clearKeybindings: false,
    },
  };
  const document = {
    schemaVersion: 1,
    revision: "raw-123",
    path: "/tmp/config.ghostty",
    exists: true,
    contents: "# exact comment\r\nbackground = 112233\r\n",
  };

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
    expect(isServerEvent({ requestId: 4, type: "config", config })).toBe(true);
    expect(isServerEvent({ requestId: 0, type: "config-changed", config })).toBe(true);
    expect(isServerEvent({ requestId: 5, type: "config-document", document })).toBe(true);
    expect(
      isServerEvent({
        requestId: 6,
        type: "config-document-validation",
        documentRevision: "candidate-456",
        config,
      }),
    ).toBe(true);
    expect(isServerEvent({ requestId: 7, type: "config-document-updated", document, config })).toBe(true);
    expect(isServerEvent({ requestId: 8, type: "config-document-conflict", document })).toBe(true);
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
        type: "config-changed",
        config: { ...config, renderer: { ...config.renderer, postProcess: "mystery" } },
      }),
    ).toBe(false);
    expect(isServerEvent({ requestId: 4, type: "config", config: { ...config, schemaVersion: 2 } })).toBe(false);
    expect(
      isServerEvent({
        requestId: 5,
        type: "config-document",
        document: { ...document, schemaVersion: 2 },
      }),
    ).toBe(false);
    expect(
      isServerEvent({
        requestId: 6,
        type: "config-document-validation",
        documentRevision: 7,
        config,
      }),
    ).toBe(false);
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
