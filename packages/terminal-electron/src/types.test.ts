import { describe, expect, it } from "vitest";
import { isMainToBridgeMessage } from "./types";

describe("main-to-bridge bootstrap validation", () => {
  it("accepts a complete connection descriptor", () => {
    expect(
      isMainToBridgeMessage({
        type: "connect",
        connection: {
          controlSocket: "/tmp/control.sock",
          frameSocket: "/tmp/frame.sock",
          authToken: "secret",
        },
      }),
    ).toBe(true);
  });

  it("rejects malformed or partial descriptors", () => {
    expect(isMainToBridgeMessage(null)).toBe(false);
    expect(isMainToBridgeMessage({ type: "other", connection: {} })).toBe(false);
    expect(
      isMainToBridgeMessage({
        type: "connect",
        connection: { controlSocket: "/tmp/control.sock", frameSocket: 3, authToken: "secret" },
      }),
    ).toBe(false);
  });
});
