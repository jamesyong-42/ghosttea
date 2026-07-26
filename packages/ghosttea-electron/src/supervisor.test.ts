import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";

const spawn = vi.fn();

vi.mock("node:child_process", () => ({ spawn }));
vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs")>()),
  existsSync: () => true,
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
    const { TerminalSupervisor } = await import("./supervisor");
    const supervisor = new TerminalSupervisor({
      binary: { kind: "executable", path: "/opt/ghosttead" },
      environment: { TRUFFLE_SIDECAR_PATH: "/opt/truffle-sidecar" },
    });

    let secondResolved = false;
    const first = supervisor.start();
    const second = supervisor.start().then(() => {
      secondResolved = true;
    });
    await Promise.resolve();

    expect(spawn).toHaveBeenCalledTimes(1);
    expect(secondResolved).toBe(false);
    expect(supervisor.running).toBe(false);

    child.stdout.write("ghosttead ready (Menlo)\n");
    await Promise.all([first, second]);
    expect(supervisor.running).toBe(true);
    expect(spawn.mock.calls[0]?.[2]?.env).toMatchObject({
      TRUFFLE_SIDECAR_PATH: "/opt/truffle-sidecar",
    });
    supervisor.stop();
  });

  it("allows a clean retry after startup fails", async () => {
    const failed = new FakeChild();
    const recovered = new FakeChild();
    spawn.mockReturnValueOnce(failed).mockReturnValueOnce(recovered);
    const { TerminalSupervisor } = await import("./supervisor");
    const supervisor = new TerminalSupervisor({ binary: { kind: "executable", path: "/opt/ghosttead" } });

    const first = supervisor.start();
    failed.exitCode = 1;
    failed.emit("exit", 1, null);
    await expect(first).rejects.toThrow("exited during startup");

    const second = supervisor.start();
    recovered.stdout.write("ghosttead ready (Menlo)\n");
    await second;
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(supervisor.running).toBe(true);
    supervisor.stop();
  });

  it("preserves a caller-owned runtime directory on stop", async () => {
    const runtimeDirectory = mkdtempSync(join(tmpdir(), "ghosttea-supervisor-test-"));
    const sentinel = join(runtimeDirectory, "keep.txt");
    writeFileSync(sentinel, "caller-owned");
    const { TerminalSupervisor } = await import("./supervisor");
    const supervisor = new TerminalSupervisor({
      binary: { kind: "executable", path: "/opt/ghosttead" },
      runtimeDirectory,
    });

    supervisor.stop();

    expect(readFileSync(sentinel, "utf8")).toBe("caller-owned");
    rmSync(runtimeDirectory, { recursive: true, force: true });
  });

  it("ignores the delayed exit of a stopped child after a restart", async () => {
    const first = new FakeChild();
    const second = new FakeChild();
    spawn.mockReturnValueOnce(first).mockReturnValueOnce(second);
    const { TerminalSupervisor } = await import("./supervisor");
    const supervisor = new TerminalSupervisor({ binary: { kind: "executable", path: "/opt/ghosttead" } });
    const unexpectedExit = vi.fn();
    supervisor.on("unexpected-exit", unexpectedExit);

    const firstStart = supervisor.start();
    first.stdout.write("ghosttead ready\n");
    await firstStart;
    supervisor.stop();

    const secondStart = supervisor.start();
    second.stdout.write("ghosttead ready\n");
    await secondStart;
    first.emit("exit", 0, "SIGTERM");

    expect(supervisor.running).toBe(true);
    expect(unexpectedExit).not.toHaveBeenCalled();
    supervisor.stop();
  });
});
