import { describe, expect, it } from "vitest";
import { PendingPromiseCache } from "./pending-cache";

describe("PendingPromiseCache", () => {
  it("deduplicates only while initialization is pending", async () => {
    const cache = new PendingPromiseCache<object, number>();
    const owner = {};
    let resolve!: (value: number) => void;
    const first = new Promise<number>((complete) => {
      resolve = complete;
    });

    expect(cache.get(owner, "workspace", () => first)).toBe(first);
    expect(cache.get(owner, "workspace", () => first)).toBe(first);
    resolve(1);
    await first;
    await Promise.resolve();

    const second = Promise.resolve(2);
    expect(cache.get(owner, "workspace", () => second)).toBe(second);
    await expect(second).resolves.toBe(2);
  });

  it("allows retry after a rejected initialization", async () => {
    const cache = new PendingPromiseCache<object, number>();
    const owner = {};
    const failed = Promise.reject(new Error("failed"));

    await expect(cache.get(owner, "workspace", () => failed)).rejects.toThrow("failed");
    await Promise.resolve();

    await expect(cache.get(owner, "workspace", () => Promise.resolve(3))).resolves.toBe(3);
  });
});
