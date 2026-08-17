import { randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { endpointPersists, localEndpoints } from "@vibecook/ghosttea-client";
import type { TerminalDaemonConnection } from "./types.js";

const DAEMON_DRAIN_BUDGET_MS = 10_000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 12_000;
const FORCE_EXIT_TIMEOUT_MS = 2_000;

function childHasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

export type GhostteaBinary =
  | { kind: "executable"; path: string; args?: string[]; cwd?: string }
  | { kind: "cargo"; manifestPath: string; release: boolean; cargoPath?: string; args?: string[] };

export interface TerminalSupervisorOptions {
  binary: GhostteaBinary;
  runtimeDirectory?: string;
  environment?: NodeJS.ProcessEnv;
  startupTimeoutMs?: number;
  /** Grace after the shutdown request before SIGKILL. Must exceed the daemon's drain budget. */
  shutdownTimeoutMs?: number;
  onStderr?: (line: string) => void;
}

export class TerminalSupervisor extends EventEmitter {
  #child: ChildProcess | undefined;
  #startPromise: Promise<void> | undefined;
  #stopPromise: Promise<void> | undefined;
  #ready = false;
  readonly #expectedExits = new WeakSet<ChildProcess>();
  readonly #childStops = new WeakMap<ChildProcess, Promise<void>>();
  readonly #options: TerminalSupervisorOptions;
  readonly #runtimeDir: string;
  readonly #ownsRuntimeDir: boolean;
  readonly connection: TerminalDaemonConnection;

  constructor(options: TerminalSupervisorOptions) {
    super();
    if (
      options.shutdownTimeoutMs !== undefined &&
      (!Number.isFinite(options.shutdownTimeoutMs) || options.shutdownTimeoutMs <= DAEMON_DRAIN_BUDGET_MS)
    ) {
      throw new RangeError(`shutdownTimeoutMs must exceed the daemon's ${DAEMON_DRAIN_BUDGET_MS} ms drain budget`);
    }
    this.#options = options;
    this.#ownsRuntimeDir = options.runtimeDirectory === undefined;
    this.#runtimeDir =
      options.runtimeDirectory !== undefined
        ? options.runtimeDirectory
        : mkdtempSync(join(tmpdir(), `ghosttea-${process.getuid?.() ?? "user"}-${process.pid}-`));
    if (options.runtimeDirectory !== undefined) mkdirSync(this.#runtimeDir, { recursive: true, mode: 0o700 });
    this.connection = {
      ...localEndpoints(this.#runtimeDir),
      authToken: randomBytes(32).toString("hex"),
    };
  }

  async start(): Promise<void> {
    if (this.#stopPromise) await this.#stopPromise;
    if (this.#ready) return;
    this.#startPromise ??= this.#start().finally(() => {
      this.#startPromise = undefined;
    });
    return this.#startPromise;
  }

  async #start(): Promise<void> {
    this.#ready = false;
    mkdirSync(this.#runtimeDir, { recursive: true, mode: 0o700 });
    if (endpointPersists()) {
      // A socket left by a previous run would make the daemon's bind fail.
      rmSync(this.connection.controlSocket, { force: true });
      rmSync(this.connection.frameSocket, { force: true });
    }
    const environment = {
      ...process.env,
      ...this.#options.environment,
      GHOSTTEA_CONTROL_SOCKET: this.connection.controlSocket,
      GHOSTTEA_FRAME_SOCKET: this.connection.frameSocket,
      GHOSTTEA_AUTH_TOKEN: this.connection.authToken,
      // EOF is a portable parent-death signal. It covers crashes and force
      // termination, where Electron never gets a chance to call stop().
      GHOSTTEA_PARENT_WATCH: "1",
    };

    const binary = this.#options.binary;
    if (binary.kind === "executable") {
      if (!existsSync(binary.path)) throw new Error(`ghosttead executable not found at ${binary.path}`);
      this.#child = spawn(binary.path, binary.args ?? [], {
        cwd: binary.cwd,
        env: environment,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } else {
      if (!existsSync(binary.manifestPath)) throw new Error(`ghosttead manifest not found at ${binary.manifestPath}`);
      this.#child = spawn(
        binary.cargoPath ?? "cargo",
        [
          "run",
          "--quiet",
          ...(binary.release ? ["--release"] : []),
          "--manifest-path",
          binary.manifestPath,
          ...(binary.args ?? []),
        ],
        {
          cwd: dirname(binary.manifestPath),
          env: environment,
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
    }
    const running = this.#child;
    if (!running) throw new Error("ghosttead failed to start");
    running.stderr?.on("data", (chunk) => {
      const line = String(chunk).trimEnd();
      if (this.#options.onStderr) this.#options.onStderr(line);
      else console.error(`[ghosttead] ${line}`);
    });
    try {
      await this.#waitUntilReady(running);
      if (childHasExited(running) || this.#expectedExits.has(running)) {
        throw new Error("ghosttead exited immediately after startup");
      }
    } catch (error) {
      this.#expectedExits.add(running);
      try {
        await this.#stopChild(running);
        this.#cleanupRuntime();
      } catch (stopError) {
        throw new Error(`ghosttead startup failed (${String(error)}) and cleanup also failed`, { cause: stopError });
      } finally {
        if (childHasExited(running) && this.#child === running) this.#child = undefined;
      }
      throw error;
    }
    this.#ready = true;
    running.once("exit", (code, signal) => {
      const expected = this.#expectedExits.delete(running);
      if (this.#child !== running) return;
      this.#child = undefined;
      this.#ready = false;
      if (!expected) this.emit("unexpected-exit", { code, signal });
    });
  }

  get running(): boolean {
    return this.#ready && this.#child !== undefined;
  }

  async stop(): Promise<void> {
    this.#stopPromise ??= this.#stop().finally(() => {
      this.#stopPromise = undefined;
    });
    return this.#stopPromise;
  }

  async #stop(): Promise<void> {
    this.#ready = false;
    const child = this.#child;
    if (child) {
      this.#expectedExits.add(child);
      await this.#stopChild(child);
      if (this.#child === child) this.#child = undefined;
    }
    this.#cleanupRuntime();
  }

  #stopChild(child: ChildProcess): Promise<void> {
    const existing = this.#childStops.get(child);
    if (existing) return existing;
    const stopping = new Promise<void>((resolve, reject) => {
      if (childHasExited(child)) {
        resolve();
        return;
      }
      let forceExit: ReturnType<typeof setTimeout> | undefined;
      let settled = false;
      const cleanup = (): void => {
        clearTimeout(escalation);
        if (forceExit) clearTimeout(forceExit);
        child.off("exit", onExit);
        child.off("close", onExit);
      };
      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error) reject(error);
        else resolve();
      };
      const onExit = (): void => finish();
      child.once("exit", onExit);
      child.once("close", onExit);
      const escalation = setTimeout(() => {
        if (!childHasExited(child)) child.kill("SIGKILL");
        forceExit = setTimeout(
          () => finish(new Error("ghosttead did not exit after forced termination")),
          FORCE_EXIT_TIMEOUT_MS,
        );
      }, this.#options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS);

      // Closing stdin is both the ordinary managed-shutdown request and the
      // parent-death channel. A direct Unix executable also receives the
      // compatibility signal for older daemon binaries. A `cargo run` wrapper
      // must stay alive to wait for the actual daemon that inherited the pipe.
      try {
        child.stdin?.end();
      } catch {
        // A concurrently exiting child can close the stream first; the exit
        // listener above is still the authority for completion.
      }
      if (this.#options.binary.kind === "executable" && process.platform !== "win32" && !childHasExited(child)) {
        child.kill("SIGTERM");
      }
    });
    const tracked = stopping.finally(() => this.#childStops.delete(child));
    this.#childStops.set(child, tracked);
    return tracked;
  }

  #cleanupRuntime(): void {
    rmSync(this.connection.controlSocket, { force: true });
    rmSync(this.connection.frameSocket, { force: true });
    if (this.#ownsRuntimeDir) rmSync(this.#runtimeDir, { recursive: true, force: true });
  }

  async #waitUntilReady(child: ChildProcess): Promise<void> {
    if (!child?.stdout) throw new Error("ghosttead did not expose stdout");
    const stdout = child.stdout;
    await new Promise<void>((resolveReady, reject) => {
      let output = "";
      let settled = false;
      const cleanup = (): void => {
        clearTimeout(timeout);
        stdout.off("data", onData);
        child.off("error", onError);
        child.off("exit", onExit);
      };
      const fail = (error: Error): void => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };
      const timeout = setTimeout(
        () => fail(new Error("ghosttead startup timed out")),
        this.#options.startupTimeoutMs ?? 120_000,
      );
      const onData = (chunk: Buffer): void => {
        output = `${output}${String(chunk)}`.slice(-4096);
        if (!output.includes("ghosttead ready") || settled) return;
        settled = true;
        cleanup();
        resolveReady();
      };
      const onError = (error: Error): void => fail(error);
      const onExit = (code: number | null): void => fail(new Error(`ghosttead exited during startup (${code})`));
      child.once("error", onError);
      child.once("exit", onExit);
      stdout.on("data", onData);
    });
  }
}
