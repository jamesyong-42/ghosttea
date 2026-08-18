import { describe, expect, it, vi } from "vitest";
import { validatedNativeOrder } from "./native-tab-order";

const electronImport = vi.hoisted(() => ({ loaded: false }));
vi.mock("electron", () => {
  electronImport.loaded = true;
  return { app: {} };
});

describe("validatedNativeOrder", () => {
  it("does not load the Electron runtime for the pure validator", () => {
    expect(electronImport.loaded).toBe(false);
  });

  it("accepts exactly one index for every native tab", () => {
    expect(validatedNativeOrder(3, [2, 0, 1])).toEqual([2, 0, 1]);
  });

  it("rejects incomplete, duplicated, and out-of-range native results", () => {
    expect(validatedNativeOrder(3, [0, 1])).toBeNull();
    expect(validatedNativeOrder(3, [0, 0, 2])).toBeNull();
    expect(validatedNativeOrder(3, [0, 1, 3])).toBeNull();
  });
});
