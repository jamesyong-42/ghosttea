import { describe, expect, it } from "vitest";
import { unknownSessionActivity, type RemoteHostSummary } from "@vibecook/ghosttea-protocol";
import type { RemoteSessionRuntimeState } from "../runtime";
import {
  contactElapsedMs,
  inputSuppressionHint,
  paneIsFrozen,
  remoteBannerActionLabel,
  remoteBannerContent,
} from "./remote-banner";
import { remoteSessionChoices } from "./RemoteSessionPalette";

function lifecycle(overrides: Partial<RemoteSessionRuntimeState> = {}): RemoteSessionRuntimeState {
  return {
    sessionId: "session",
    state: "live",
    reason: null,
    exit: null,
    lifecycleSeq: 1,
    deviceId: "device",
    deviceName: "studio-mac",
    attempt: null,
    nextRetryMs: null,
    lastContactMs: null,
    observedAt: 0,
    ...overrides,
  };
}

describe("remoteBannerContent", () => {
  it("shows nothing while the session is live", () => {
    expect(remoteBannerContent(lifecycle({ state: "live" }), null)).toBeNull();
  });

  it("offers a manual retry and a close while the host is away", () => {
    const content = remoteBannerContent(lifecycle({ state: "suspended" }), null);
    expect(content).toMatchObject({
      glyph: null,
      message: "studio-mac is offline · waiting for it to return",
      actions: ["retry", "close"],
    });
    expect(remoteBannerActionLabel("retry", lifecycle())).toBe("Retry now");
    expect(remoteBannerActionLabel("close", lifecycle())).toBe("Close");
  });

  it("reports an honest last-contact clock while reconnecting", () => {
    expect(remoteBannerContent(lifecycle({ state: "reconnecting" }), 12_400)).toMatchObject({
      glyph: "⟳",
      message: "Connection to studio-mac lost — reconnecting… · last contact 12 s ago",
      actions: [],
    });
    // No contact time reported is stated as no clock at all, never as zero.
    expect(remoteBannerContent(lifecycle({ state: "reconnecting" }), null)?.message).toBe(
      "Connection to studio-mac lost — reconnecting…",
    );
  });

  it("names the recovery step while restoring", () => {
    expect(remoteBannerContent(lifecycle({ state: "synchronizing" }), null)).toMatchObject({
      glyph: "⟳",
      message: "Restoring session…",
      actions: [],
    });
  });

  it("states each end reason with the evidence it has", () => {
    const ended = (reason: RemoteSessionRuntimeState["reason"], exit: RemoteSessionRuntimeState["exit"] = null) =>
      remoteBannerContent(lifecycle({ state: "ended", reason, exit }), null);

    expect(ended("host-restarted")?.message).toBe(
      "Session ended — the host restarted. This is a frozen snapshot of the last screen.",
    );
    expect(ended("session-exited", { code: 1 })?.message).toBe("Process exited (code 1) on studio-mac.");
    expect(ended("session-exited", { code: null })?.message).toBe("Process exited on studio-mac.");
    expect(ended("session-closed")?.message).toBe("Session was closed on studio-mac.");
    expect(ended("session-unavailable")?.message).toBe("This session is no longer available on studio-mac.");
    // Without evidence the daemon reports no reason, and neither do we.
    expect(ended(null)?.message).toBe("This session is no longer available on studio-mac.");
    expect(ended("session-closed")?.actions).toEqual(["browse", "close"]);
    expect(remoteBannerActionLabel("browse", lifecycle())).toBe("Browse sessions on studio-mac");
  });
});

describe("contactElapsedMs", () => {
  it("carries the daemon's contact time forward from when it was observed", () => {
    expect(contactElapsedMs(lifecycle({ lastContactMs: 5_000, observedAt: 1_000 }), 3_500)).toBe(7_500);
    expect(contactElapsedMs(lifecycle({ lastContactMs: null }), 3_500)).toBeNull();
    // A clock that appears to run backwards never produces a shrinking count.
    expect(contactElapsedMs(lifecycle({ lastContactMs: 5_000, observedAt: 9_000 }), 1_000)).toBe(5_000);
  });
});

describe("paneIsFrozen", () => {
  it("cools every pane whose session is not live", () => {
    expect(paneIsFrozen(undefined)).toBe(false);
    expect(paneIsFrozen(lifecycle({ state: "live" }))).toBe(false);
    for (const state of ["reconnecting", "synchronizing", "suspended", "ended"] as const) {
      expect(paneIsFrozen(lifecycle({ state }))).toBe(true);
    }
  });
});

describe("inputSuppressionHint", () => {
  it("explains why the keystroke went nowhere", () => {
    expect(inputSuppressionHint("reconnecting")).toBe("Keystrokes are not delivered while reconnecting");
    expect(inputSuppressionHint("synchronizing")).toBe("Keystrokes are not delivered while reconnecting");
    expect(inputSuppressionHint("suspended")).toBe("Keystrokes are not delivered while the session is offline");
    expect(inputSuppressionHint("ended")).toBe("Keystrokes are not delivered while the session is offline");
    expect(inputSuppressionHint("live")).toBe("Keystrokes are not delivered while the session is offline");
  });
});

describe("remoteSessionChoices", () => {
  const host = (deviceId: string, deviceName: string): RemoteHostSummary => ({
    deviceId,
    deviceName,
    online: true,
    protocolMajor: 1,
    protocolMinor: 4,
    hostInstanceId: `${deviceId}-instance`,
    sessions: [
      {
        sessionId: `${deviceId}-session`,
        title: "zsh",
        cwdLabel: "~/code",
        running: true,
        attachable: true,
        readWrite: true,
        createdAtMs: 1,
        activity: unknownSessionActivity(),
      },
    ],
  });
  const hosts = [host("device-a", "studio-mac"), host("device-b", "loft-linux")];

  it("lists every host by default and one host when asked", () => {
    expect(remoteSessionChoices(hosts, "").map((choice) => choice.host.deviceId)).toEqual(["device-a", "device-b"]);
    expect(remoteSessionChoices(hosts, "", "device-b").map((choice) => choice.host.deviceId)).toEqual(["device-b"]);
    expect(remoteSessionChoices(hosts, "", "device-missing")).toEqual([]);
  });

  it("keeps the search text applying inside a pre-filtered host", () => {
    expect(remoteSessionChoices(hosts, "loft", "device-b")).toHaveLength(1);
    expect(remoteSessionChoices(hosts, "studio", "device-b")).toEqual([]);
  });

  it("omits sessions the host will not attach", () => {
    const stopped = [
      { ...hosts[0]!, sessions: [{ ...hosts[0]!.sessions[0]!, running: false }] },
      { ...hosts[1]!, sessions: [{ ...hosts[1]!.sessions[0]!, attachable: false }] },
    ];
    expect(remoteSessionChoices(stopped, "")).toEqual([]);
  });
});
