import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawn = vi.fn();

vi.mock("node:child_process", () => ({ spawn }));
vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs")>()),
  existsSync: () => true,
}));
class FakeChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly kill = vi.fn(() => true);
}

function emitExit(child: FakeChild, code = 0, signal: NodeJS.Signals | null = null): void {
  child.exitCode = code;
  child.signalCode = signal;
  child.emit("exit", code, signal);
}

describe("TerminalSupervisor", () => {
  beforeEach(() => spawn.mockReset());
  afterEach(() => vi.useRealTimers());

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
      GHOSTTEA_PARENT_WATCH: "1",
    });
    expect(spawn.mock.calls[0]?.[2]?.stdio).toEqual(["pipe", "pipe", "pipe"]);
    const stopped = supervisor.stop();
    emitExit(child);
    await stopped;
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
    const stopped = supervisor.stop();
    emitExit(recovered);
    await stopped;
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

    await supervisor.stop();

    expect(readFileSync(sentinel, "utf8")).toBe("caller-owned");
    rmSync(runtimeDirectory, { recursive: true, force: true });
  });

  it("does not restart until the previous daemon has actually exited", async () => {
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
    const stopping = supervisor.stop();

    const secondStart = supervisor.start();
    await Promise.resolve();
    expect(spawn).toHaveBeenCalledTimes(1);
    emitExit(first, 0, "SIGTERM");
    await stopping;
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(2));
    second.stdout.write("ghosttead ready\n");
    await secondStart;

    expect(supervisor.running).toBe(true);
    expect(unexpectedExit).not.toHaveBeenCalled();
    const stopped = supervisor.stop();
    emitExit(second);
    await stopped;
  });

  it("keeps a cargo wrapper alive while the inherited parent pipe drains the daemon", async () => {
    const child = new FakeChild();
    spawn.mockReturnValue(child);
    const { TerminalSupervisor } = await import("./supervisor");
    const supervisor = new TerminalSupervisor({
      binary: { kind: "cargo", manifestPath: "/src/ghosttead/Cargo.toml", release: false },
    });
    const started = supervisor.start();
    child.stdout.write("ghosttead ready\n");
    await started;

    const stopping = supervisor.stop();
    expect(child.stdin.writableEnded).toBe(true);
    expect(child.kill).not.toHaveBeenCalled();
    emitExit(child);
    await stopping;
  });

  it("does not hard-kill the daemon before its ten-second drain budget", async () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    spawn.mockReturnValue(child);
    const { TerminalSupervisor } = await import("./supervisor");
    const supervisor = new TerminalSupervisor({ binary: { kind: "executable", path: "/opt/ghosttead" } });
    const started = supervisor.start();
    child.stdout.write("ghosttead ready\n");
    await started;

    let stopped = false;
    const stopping = supervisor.stop().then(() => {
      stopped = true;
    });
    expect(child.stdin.writableEnded).toBe(true);
    // Unix executables get a compatibility SIGTERM. Windows and `cargo run`
    // wrappers drain only through the inherited stdin pipe until the grace
    // expires — Node cannot address a Windows child with SIGTERM.
    const unixCompatibilitySignal = process.platform !== "win32";
    if (unixCompatibilitySignal) {
      expect(child.kill).toHaveBeenCalledExactlyOnceWith("SIGTERM");
    } else {
      expect(child.kill).not.toHaveBeenCalled();
    }
    await vi.advanceTimersByTimeAsync(10_000);
    expect(child.kill).toHaveBeenCalledTimes(unixCompatibilitySignal ? 1 : 0);
    expect(stopped).toBe(false);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(child.kill).toHaveBeenLastCalledWith("SIGKILL");
    expect(child.kill).toHaveBeenCalledTimes(unixCompatibilitySignal ? 2 : 1);
    emitExit(child, 0, "SIGKILL");
    await stopping;
    expect(stopped).toBe(true);
  });

  it("rejects a grace shorter than the daemon drain contract", async () => {
    const { TerminalSupervisor } = await import("./supervisor");
    expect(
      () =>
        new TerminalSupervisor({
          binary: { kind: "executable", path: "/opt/ghosttead" },
          shutdownTimeoutMs: 10_000,
        }),
    ).toThrow("must exceed the daemon's 10000 ms drain budget");
  });
});
