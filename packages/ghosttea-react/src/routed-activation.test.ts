import { describe, expect, it } from "vitest";
import type { RoutedCellActivationStatus, RoutedPresentationStatus } from "@vibecook/ghosttea-protocol";
import { initialRoutedActivation, reduceRoutedActivation } from "./routed-activation";

const stamp = {
  sceneEpoch: { cellBootId: "cell-a", modelGeneration: 1 },
  sceneRevision: 4,
};

function attached() {
  let state = initialRoutedActivation("session", "activation");
  state = reduceRoutedActivation(state, { type: "ticket-minted", endpointsPresent: true });
  state = reduceRoutedActivation(state, { type: "transport-ready" });
  state = reduceRoutedActivation(state, { type: "control-attached", grantGeneration: 2, rights: ["input", "read"] });
  state = reduceRoutedActivation(state, {
    type: "frames-attached",
    outcome: { kind: "seed-required", reason: "no-cursor" },
    resumeToken: "resume-1",
    trfIdentity: { sessionHandle: "11", viewHandle: "12" },
  });
  return state;
}

function workerStatus(sequence = 1): RoutedPresentationStatus {
  return {
    activationId: "activation",
    workerStatusSequence: sequence,
    state: "active",
    sceneContent: stamp,
    leaseTtlMs: 2_000,
  };
}

function cellStatus(
  presentation: "presenting" | "stopped" | "revoked" = "presenting",
  input: "allowed" | "suspended" | "revoked" = "allowed",
  sequence = 1,
  reason?: string,
): RoutedCellActivationStatus {
  return {
    sessionId: "session",
    activationId: "activation",
    cellStatusSequence: sequence,
    leaseTtlMs: 6_000,
    acceptedContent: stamp,
    presentation: { state: presentation, ...(reason === undefined ? {} : { reason }) },
    input: { state: input, ...(reason === undefined ? {} : { reason }) },
  };
}

describe("routed activation authority", () => {
  it("abandons an activation on attach-deadline and preserves the replacement CAS", () => {
    let state = initialRoutedActivation("session", "activation");
    state = reduceRoutedActivation(state, { type: "ticket-minted", endpointsPresent: true });
    state = reduceRoutedActivation(state, { type: "transport-ready" });
    state = reduceRoutedActivation(state, { type: "attach-deadline" });
    expect(state.phase).toBe("recovering");
    expect(state.replacesActivationId).toBe("activation");
  });

  it("keeps presentation ready while lag suspends input", () => {
    let state = attached();
    state = reduceRoutedActivation(state, { type: "presentation-status", status: workerStatus(), now: 100 });
    state = reduceRoutedActivation(state, { type: "cell-status", status: cellStatus(), now: 100 });
    expect(state.phase).toBe("presenting");
    expect(state.presentationReady).toBe(true);
    expect(state.inputAllowed).toBe(true);

    state = reduceRoutedActivation(state, {
      type: "cell-status",
      status: cellStatus("presenting", "suspended", 2, "lagging"),
      now: 200,
    });
    expect(state.presentationReady).toBe(true);
    expect(state.inputAllowed).toBe(false);
  });

  it("becomes ready when the cell lease arrives before the legs and scene commit", () => {
    let state = initialRoutedActivation("session", "activation");
    state = reduceRoutedActivation(state, { type: "ticket-minted", endpointsPresent: true });
    state = reduceRoutedActivation(state, { type: "transport-ready" });
    state = reduceRoutedActivation(state, { type: "cell-status", status: cellStatus(), now: 100 });
    state = reduceRoutedActivation(state, {
      type: "control-attached",
      grantGeneration: 2,
      rights: ["input", "read"],
    });
    state = reduceRoutedActivation(state, {
      type: "frames-attached",
      outcome: { kind: "seed-required", reason: "no-cursor" },
      resumeToken: "resume-1",
      trfIdentity: { sessionHandle: "11", viewHandle: "12" },
    });
    state = reduceRoutedActivation(state, { type: "presentation-status", status: workerStatus(), now: 100 });
    expect(state.phase).toBe("seeding");
    expect(state.presentationReady).toBe(false);

    state = reduceRoutedActivation(state, { type: "sync-complete", appliedContent: stamp });
    expect(state.phase).toBe("presenting");
    expect(state.presentationReady).toBe(true);
    expect(state.inputAllowed).toBe(true);
  });

  it("moves a presenting activation to stalled when presentation stops", () => {
    let state = attached();
    state = reduceRoutedActivation(state, { type: "presentation-status", status: workerStatus(), now: 100 });
    state = reduceRoutedActivation(state, { type: "cell-status", status: cellStatus(), now: 100 });
    state = reduceRoutedActivation(state, {
      type: "cell-status",
      status: cellStatus("stopped", "suspended", 2, "overload"),
      now: 200,
    });
    expect(state.phase).toBe("stalled");
    expect(state.presentationReady).toBe(false);
    expect(state.inputAllowed).toBe(false);
  });

  it("waits until the local scene covers the cell's accepted content", () => {
    let state = attached();
    state = reduceRoutedActivation(state, { type: "presentation-status", status: workerStatus(), now: 100 });
    state = reduceRoutedActivation(state, {
      type: "cell-status",
      status: { ...cellStatus(), acceptedContent: { ...stamp, sceneRevision: 5 } },
      now: 100,
    });
    expect(state.phase).toBe("presenting");
    expect(state.presentationReady).toBe(false);
    expect(state.inputAllowed).toBe(false);

    state = reduceRoutedActivation(state, {
      type: "presentation-status",
      status: { ...workerStatus(2), sceneContent: { ...stamp, sceneRevision: 5 } },
      now: 200,
    });
    expect(state.presentationReady).toBe(true);
    expect(state.inputAllowed).toBe(true);
  });

  it("recovers on leg loss and fences route-stale input immediately", () => {
    let state = attached();
    state = reduceRoutedActivation(state, { type: "leg-lost", channel: "frames", resumeCapable: true });
    expect(state.phase).toBe("recovering");
    expect(state.replacesActivationId).toBeUndefined();

    state = reduceRoutedActivation(state, { type: "route-stale" });
    expect(state.phase).toBe("recovering");
    expect(state.replacesActivationId).toBe("activation");
    expect(state.inputAllowed).toBe(false);
  });

  it("surfaces a persistent protocol failure with the failure-matrix reason", () => {
    let state = attached();
    state = reduceRoutedActivation(state, { type: "leg-lost", channel: "frames", resumeCapable: false });
    state = reduceRoutedActivation(state, {
      type: "transport-failed",
      recoveryExhausted: true,
      reason: "protocol",
    });
    expect(state.phase).toBe("unavailable");
    expect(state.unavailableReason).toBe("protocol");
  });

  it("never opens input for a client-declared read-only view", () => {
    let state = attached();
    state = reduceRoutedActivation(state, { type: "input-policy", policy: "read-only" });
    state = reduceRoutedActivation(state, { type: "presentation-status", status: workerStatus(), now: 100 });
    state = reduceRoutedActivation(state, { type: "cell-status", status: cellStatus(), now: 100 });
    expect(state.presentationReady).toBe(true);
    expect(state.inputAllowed).toBe(false);
  });

  it("applies a renewal rights downgrade without interrupting presentation", () => {
    let state = attached();
    state = reduceRoutedActivation(state, { type: "presentation-status", status: workerStatus(), now: 100 });
    state = reduceRoutedActivation(state, { type: "cell-status", status: cellStatus(), now: 100 });
    state = reduceRoutedActivation(state, { type: "control-attached", grantGeneration: 3, rights: ["read"] });
    expect(state.phase).toBe("presenting");
    expect(state.presentationReady).toBe(true);
    expect(state.inputAllowed).toBe(false);
    expect(state.grantGeneration).toBe(3);
  });

  it("closes input at the local renewal margin until a newer grant is accepted", () => {
    let state = attached();
    state = reduceRoutedActivation(state, { type: "presentation-status", status: workerStatus(), now: 100 });
    state = reduceRoutedActivation(state, { type: "cell-status", status: cellStatus(), now: 100 });
    expect(state.inputAllowed).toBe(true);

    state = reduceRoutedActivation(state, { type: "grant-expiring" });
    expect(state.presentationReady).toBe(true);
    expect(state.inputAllowed).toBe(false);

    state = reduceRoutedActivation(state, {
      type: "control-attached",
      grantGeneration: 3,
      rights: ["input", "read"],
    });
    expect(state.presentationReady).toBe(true);
    expect(state.inputAllowed).toBe(true);
  });

  it("recovers when the cell refuses a renewal without reopening input", () => {
    let state = attached();
    state = reduceRoutedActivation(state, { type: "presentation-status", status: workerStatus(), now: 100 });
    state = reduceRoutedActivation(state, { type: "cell-status", status: cellStatus(), now: 100 });
    state = reduceRoutedActivation(state, { type: "grant-expiring" });
    state = reduceRoutedActivation(state, {
      type: "attach-refused",
      code: "GRANT_INVALID",
      retryable: false,
    });

    expect(state.phase).toBe("recovering");
    expect(state.presentationReady).toBe(false);
    expect(state.inputAllowed).toBe(false);
    expect(state.grantInputValid).toBe(false);
    expect(state.replacesActivationId).toBe("activation");
  });
});
