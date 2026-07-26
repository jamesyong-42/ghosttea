import { describe, expect, it } from "vitest";
import { allSettledWithin } from "./deadline";

describe("allSettledWithin", () => {
  it("waits for fulfilled and rejected cleanup tasks", async () => {
    await expect(allSettledWithin([Promise.resolve(), Promise.reject(new Error("expected"))], 100)).resolves.toBe(true);
  });

  it("stops waiting at the deadline", async () => {
    await expect(allSettledWithin([new Promise(() => {})], 5)).resolves.toBe(false);
  });
});
