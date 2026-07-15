import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";

const spawn = vi.fn();

vi.mock("node:child_process", () => ({ spawn }));
vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs")>()),
  existsSync: () => true,
}));
vi.mock("electron", () => ({
  app: {
    getAppPath: () => "/workspace/apps/desktop",
    isPackaged: false,
  },
}));

class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly kill = vi.fn(() => true);
}

describe("TerminalSupervisor", () => {
  beforeEach(() => spawn.mockReset());

  it("shares startup readiness across concurrent callers", async () => {
    const child = new FakeChild();
    spawn.mockReturnValue(child);
    const { TerminalSupervisor } = await import("./terminal-supervisor");
    const supervisor = new TerminalSupervisor();

    let secondResolved = false;
    const first = supervisor.start();
    const second = supervisor.start().then(() => {
      secondResolved = true;
    });
    await Promise.resolve();

    expect(spawn).toHaveBeenCalledTimes(1);
    expect(secondResolved).toBe(false);
    expect(supervisor.running).toBe(false);

    child.stdout.write("terminald ready (Menlo)\n");
    await Promise.all([first, second]);
    expect(supervisor.running).toBe(true);
    expect(spawn.mock.calls[0]?.[2]?.env).toMatchObject({
      TRUFFLE_SIDECAR_PATH: "/p008/truffle/packages/sidecar-slim/sidecar-slim",
    });
    supervisor.stop();
  });

  it("allows a clean retry after startup fails", async () => {
    const failed = new FakeChild();
    const recovered = new FakeChild();
    spawn.mockReturnValueOnce(failed).mockReturnValueOnce(recovered);
    const { TerminalSupervisor } = await import("./terminal-supervisor");
    const supervisor = new TerminalSupervisor();

    const first = supervisor.start();
    failed.exitCode = 1;
    failed.emit("exit", 1, null);
    await expect(first).rejects.toThrow("exited during startup");

    const second = supervisor.start();
    recovered.stdout.write("terminald ready (Menlo)\n");
    await second;
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(supervisor.running).toBe(true);
    supervisor.stop();
  });
});
