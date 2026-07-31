import { describe, expect, it } from "vitest";
import { rendererCommandRejection } from "./renderer-control.js";

describe("renderer control command boundary", () => {
  it.each(["get-config-document", "validate-config-document", "replace-config-document", "future-privileged-command"])(
    "rejects %s without losing the request identity",
    (type) => {
      expect(rendererCommandRejection({ requestId: 42, type })).toEqual({
        requestId: 42,
        type: "error",
        message: "Control command is not available to terminal renderers",
      });
    },
  );

  it("allows reviewed renderer commands through", () => {
    expect(rendererCommandRejection({ requestId: 7, type: "get-config" })).toBeUndefined();
    expect(
      rendererCommandRejection({
        requestId: 8,
        type: "send-text",
        sessionId: "session",
        viewId: "view",
        attachmentEpoch: 1,
        inputSequence: 2,
        text: "hello",
      }),
    ).toBeUndefined();
  });

  it("uses an unsolicited response id for malformed envelopes", () => {
    expect(rendererCommandRejection(null)).toMatchObject({ requestId: 0, type: "error" });
    expect(rendererCommandRejection({ requestId: -1, type: "get-config-document" })).toMatchObject({
      requestId: 0,
      type: "error",
    });
  });
});
