import { describe, expect, it } from "vitest";
import { classifyFrame, type AppliedFrameState } from "./frame-sequence";

const previous: AppliedFrameState = { sessionEpoch: 1n, layoutEpoch: 2n, sequence: 10n, awaitingResync: false };

describe("frame sequencing", () => {
  it("accepts the next incremental frame", () => {
    expect(classifyFrame(previous, { sessionEpoch: 1n, layoutEpoch: 2n, sequence: 11n, full: false })).toBe("accept");
  });

  it("rejects stale frames and requests resync for sequence gaps", () => {
    expect(classifyFrame(previous, { sessionEpoch: 1n, layoutEpoch: 2n, sequence: 10n, full: false })).toBe("stale");
    expect(classifyFrame(previous, { sessionEpoch: 1n, layoutEpoch: 2n, sequence: 12n, full: false })).toBe("resync");
  });

  it("accepts a full snapshot across gaps and session epochs", () => {
    expect(classifyFrame(previous, { sessionEpoch: 1n, layoutEpoch: 3n, sequence: 20n, full: true })).toBe("accept");
    expect(classifyFrame(previous, { sessionEpoch: 2n, layoutEpoch: 1n, sequence: 1n, full: true })).toBe("accept");
  });
});
