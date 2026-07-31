import { describe, expect, it } from "vitest";
import { unknownSessionActivity, type RemoteHostSummary } from "@vibecook/ghosttea-protocol";
import type { RemoteSessionRuntimeState } from "../runtime";
import {
  contactElapsedMs,
  inputSuppressionHint,
  paneIsFrozen,
  remoteBannerActionLabel,
  remoteBannerContent,
  retryCountdownMs,
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
    awaitingRecoveryFrame: false,
    ...overrides,
  };
}

describe("remoteBannerContent", () => {
  it("acknowledges a resume only once the restored screen is on display", () => {
    const live = lifecycle({ state: "live" });
    expect(remoteBannerContent(live, null, { reconnected: true })).toMatchObject({
      glyph: "✓",
      spinning: false,
      message: "Reconnected",
      actions: [],
    });
    // Still showing the pre-outage frame: claiming "Reconnected" over it would
    // be the lie the cooling exists to prevent.
    expect(
      remoteBannerContent(lifecycle({ state: "live", awaitingRecoveryFrame: true }), null, { reconnected: true }),
    ).toBeNull();
    expect(remoteBannerContent(live, null, { reconnected: false })).toBeNull();
  });

  it("reports the attempt and the countdown to the next dial", () => {
    const reconnecting = lifecycle({ state: "reconnecting", attempt: 3 });
    expect(remoteBannerContent(reconnecting, 12_400, { retryMs: 4_000 })?.message).toBe(
      "Connection to studio-mac lost — reconnecting… · last contact 12 s ago · attempt 3 · retrying in 4 s",
    );
    // A countdown that has run out says nothing: the dial is already going out.
    expect(remoteBannerContent(reconnecting, null, { retryMs: 0 })?.message).toBe(
      "Connection to studio-mac lost — reconnecting… · attempt 3",
    );
    expect(remoteBannerContent(lifecycle({ state: "reconnecting" }), null, {})?.message).toBe(
      "Connection to studio-mac lost — reconnecting…",
    );
  });

  it("marks only work in flight as spinning", () => {
    expect(remoteBannerContent(lifecycle({ state: "reconnecting" }), null)?.spinning).toBe(true);
    expect(remoteBannerContent(lifecycle({ state: "synchronizing" }), null)?.spinning).toBe(true);
    expect(remoteBannerContent(lifecycle({ state: "suspended" }), null)?.spinning).toBe(false);
    expect(remoteBannerContent(lifecycle({ state: "ended" }), null)?.spinning).toBe(false);
  });

  it("shows nothing while the session is live or still opening", () => {
    expect(remoteBannerContent(lifecycle({ state: "live" }), null)).toBeNull();
    // Opening is the normal path to a first frame, not a fault to announce.
    expect(remoteBannerContent(lifecycle({ state: "opening" }), null)).toBeNull();
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

describe("retryCountdownMs", () => {
  it("counts the scheduled dial down from when the state was observed", () => {
    expect(retryCountdownMs(lifecycle({ nextRetryMs: 5_000, observedAt: 1_000 }), 3_000)).toBe(3_000);
    expect(retryCountdownMs(lifecycle({ nextRetryMs: 5_000, observedAt: 1_000 }), 9_000)).toBe(0);
    expect(retryCountdownMs(lifecycle({ nextRetryMs: null }), 9_000)).toBeNull();
  });

  it("restarts from the newest event rather than continuing the old countdown", () => {
    const first = lifecycle({ nextRetryMs: 4_000, observedAt: 1_000 });
    expect(retryCountdownMs(first, 4_500)).toBe(500);
    // The engine backed off further; the banner counts the new value down from
    // when it arrived, not from where the previous one had got to.
    const second = lifecycle({ nextRetryMs: 8_000, observedAt: 5_000 });
    expect(retryCountdownMs(second, 5_500)).toBe(7_500);
  });
});

describe("paneIsFrozen", () => {
  it("cools every pane whose session is not live, once it has something to show", () => {
    expect(paneIsFrozen(undefined)).toBe(false);
    expect(paneIsFrozen(lifecycle({ state: "live" }))).toBe(false);
    expect(paneIsFrozen(lifecycle({ state: "opening" }))).toBe(false);
    // Live again, but the screen is still the one from before the outage.
    expect(paneIsFrozen(lifecycle({ state: "live", awaitingRecoveryFrame: true }))).toBe(true);
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
    expect(inputSuppressionHint("opening")).toBe("Keystrokes are not delivered while the session is offline");
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
