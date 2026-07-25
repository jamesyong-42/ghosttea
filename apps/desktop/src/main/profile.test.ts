import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { desktopProfile, parseProfileName } from "./profile";

describe("desktop profiles", () => {
  it("keeps default storage compatible and isolates named profiles", () => {
    expect(desktopProfile("/app/Ghostty", undefined)).toEqual({
      name: "default",
      root: "/app/Ghostty",
      electronData: "/app/Ghostty",
      truffleState: join("/app/Ghostty", "truffle"),
    });
    expect(desktopProfile("/app/Ghostty", "alpha")).toEqual({
      name: "alpha",
      root: join("/app/Ghostty", "profiles", "alpha"),
      electronData: join("/app/Ghostty", "profiles", "alpha", "electron"),
      truffleState: join("/app/Ghostty", "profiles", "alpha", "truffle"),
    });
  });

  it("accepts safe profile names and rejects path-like names", () => {
    expect(parseProfileName(" beta-2 ")).toBe("beta-2");
    expect(() => parseProfileName("../beta")).toThrow(/must be 1-64 characters/);
    expect(() => parseProfileName("beta/other")).toThrow(/must be 1-64 characters/);
  });
});
