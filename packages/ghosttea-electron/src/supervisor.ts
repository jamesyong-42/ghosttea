import { randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { endpointPersists, localEndpoints } from "@vibecook/ghosttea-client";
import type { TerminalDaemonConnection } from "./types.js";

export type GhostteaBinary =
  | { kind: "executable"; path: string; args?: string[]; cwd?: string }
  | { kind: "cargo"; manifestPath: string; release: boolean; cargoPath?: string; args?: string[] };

export interface TerminalSupervisorOptions {
  binary: GhostteaBinary;
  runtimeDirectory?: string;
  environment?: NodeJS.ProcessEnv;
  startupTimeoutMs?: number;
  onStderr?: (line: string) => void;
}

export class TerminalSupervisor extends EventEmitter {
  #child: ChildProcess | undefined;
  #startPromise: Promise<void> | undefined;
  #ready = false;
  readonly #expectedExits = new WeakSet<ChildProcess>();
  readonly #options: TerminalSupervisorOptions;
  readonly #runtimeDir: string;
  readonly #ownsRuntimeDir: boolean;
  readonly connection: TerminalDaemonConnection;

  constructor(options: TerminalSupervisorOptions) {
    super();
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
    };

    const binary = this.#options.binary;
    if (binary.kind === "executable") {
      if (!existsSync(binary.path)) throw new Error(`ghosttead executable not found at ${binary.path}`);
      this.#child = spawn(binary.path, binary.args ?? [], {
        cwd: binary.cwd,
        env: environment,
        stdio: ["ignore", "pipe", "pipe"],
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
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
    }
    this.#child.stderr?.on("data", (chunk) => {
      const line = String(chunk).trimEnd();
      if (this.#options.onStderr) this.#options.onStderr(line);
      else console.error(`[ghosttead] ${line}`);
    });
    await this.#waitUntilReady();
    const running = this.#child;
    if (!running || running.exitCode !== null || running.signalCode !== null) {
      this.#child = undefined;
      throw new Error("ghosttead exited immediately after startup");
    }
    this.#ready = true;
    running?.once("exit", (code, signal) => {
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

  stop(): void {
    this.#ready = false;
    const child = this.#child;
    if (child) {
      this.#expectedExits.add(child);
      child.kill("SIGTERM");
      // A daemon wedged past SIGTERM would linger holding PTYs and sockets.
      // The timer is unref'd so a quitting app never waits on it; if the app
      // exits first the daemon dies with its pipes as before.
      const escalation = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }, 3_000);
      escalation.unref?.();
      child.once("exit", () => clearTimeout(escalation));
      if (this.#child === child) this.#child = undefined;
    }
    rmSync(this.connection.controlSocket, { force: true });
    rmSync(this.connection.frameSocket, { force: true });
    if (this.#ownsRuntimeDir) rmSync(this.#runtimeDir, { recursive: true, force: true });
  }

  async #waitUntilReady(): Promise<void> {
    const child = this.#child;
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
        child.kill("SIGTERM");
        if (this.#child === child) this.#child = undefined;
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
