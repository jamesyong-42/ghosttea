import { afterEach, describe, expect, it, vi } from "vitest";
import { FrameResyncController } from "./frame-resync";

afterEach(() => {
  vi.useRealTimers();
});

describe("FrameResyncController", () => {
  it("retries until a full frame completes resynchronization", async () => {
    vi.useFakeTimers();
    const refresh = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(undefined);
    const controller = new FrameResyncController(refresh, { retryDelaysMs: [10, 20], startIntervalMs: 0 });

    controller.request("7");
    await vi.advanceTimersByTimeAsync(10);
    expect(refresh).toHaveBeenCalledTimes(2);

    controller.complete("7");
    await vi.advanceTimersByTimeAsync(100);
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("bounds retries and allows a later frame to start a fresh cycle", async () => {
    vi.useFakeTimers();
    const refresh = vi.fn().mockRejectedValue(new Error("offline"));
    const exhausted = vi.fn();
    const controller = new FrameResyncController(refresh, {
      retryDelaysMs: [5],
      startIntervalMs: 0,
      onExhausted: exhausted,
    });

    controller.request("9");
    await vi.advanceTimersByTimeAsync(5);
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(exhausted).toHaveBeenCalledTimes(1);

    controller.request("9");
    await Promise.resolve();
    expect(refresh).toHaveBeenCalledTimes(3);
    controller.cancel("9");
  });

  it("cancels an in-flight cycle without scheduling another attempt", async () => {
    vi.useFakeTimers();
    let resolveRefresh: (() => void) | undefined;
    const refresh = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveRefresh = resolve;
        }),
    );
    const controller = new FrameResyncController(refresh, { retryDelaysMs: [5] });

    controller.request("11");
    controller.cancel("11");
    resolveRefresh?.();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(20);

    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("bounds simultaneous full-refresh requests after a broad transport gap", async () => {
    const pending: Array<() => void> = [];
    let active = 0;
    let maximumActive = 0;
    const refresh = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          active += 1;
          maximumActive = Math.max(maximumActive, active);
          pending.push(() => {
            active -= 1;
            resolve();
          });
        }),
    );
    const controller = new FrameResyncController(refresh, {
      retryDelaysMs: [],
      maxConcurrent: 2,
      startIntervalMs: 0,
    });

    for (let index = 0; index < 8; index += 1) controller.request(String(index));
    await Promise.resolve();
    expect(refresh).toHaveBeenCalledTimes(2);

    while (pending.length > 0) {
      pending.shift()?.();
      await Promise.resolve();
    }

    expect(refresh).toHaveBeenCalledTimes(8);
    expect(maximumActive).toBe(2);
    controller.dispose();
  });

  it("paces refresh starts so a broad gap cannot become a request storm", async () => {
    vi.useFakeTimers();
    const refresh = vi.fn().mockResolvedValue(undefined);
    const controller = new FrameResyncController(refresh, {
      retryDelaysMs: [],
      maxConcurrent: 2,
      startIntervalMs: 20,
    });

    controller.request("a");
    controller.request("b");
    controller.request("c");
    await Promise.resolve();
    expect(refresh).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(19);
    expect(refresh).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(refresh).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(20);
    expect(refresh).toHaveBeenCalledTimes(3);
    controller.dispose();
  });
});
