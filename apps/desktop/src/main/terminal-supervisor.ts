import { randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { app } from "electron";
import type { TerminalDaemonConnection } from "../shared/terminal-ipc";

export class TerminalSupervisor extends EventEmitter {
  #child: ChildProcess | undefined;
  #startPromise: Promise<void> | undefined;
  #ready = false;
  #stopping = false;
  readonly #runtimeDir = join(tmpdir(), `electron-ghostty-${process.getuid?.() ?? "user"}-${process.pid}`);
  readonly connection: TerminalDaemonConnection;

  constructor() {
    super();
    mkdirSync(this.#runtimeDir, { recursive: true, mode: 0o700 });
    this.connection = {
      controlSocket: join(this.#runtimeDir, "control.sock"),
      frameSocket: join(this.#runtimeDir, "frames.sock"),
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
    this.#stopping = false;
    this.#ready = false;
    mkdirSync(this.#runtimeDir, { recursive: true, mode: 0o700 });
    rmSync(this.connection.controlSocket, { force: true });
    rmSync(this.connection.frameSocket, { force: true });
    const environment = {
      ...process.env,
      TERMINALD_CONTROL_SOCKET: this.connection.controlSocket,
      TERMINALD_FRAME_SOCKET: this.connection.frameSocket,
      TERMINALD_AUTH_TOKEN: this.connection.authToken,
    };

    const configuredBinary =
      process.env.TERMINALD_BIN ??
      (app.isPackaged
        ? join(process.resourcesPath, "bin", process.platform === "win32" ? "terminald.exe" : "terminald")
        : undefined);
    if (configuredBinary) {
      if (!existsSync(configuredBinary)) throw new Error(`terminald executable not found at ${configuredBinary}`);
      this.#child = spawn(configuredBinary, [], { env: environment, stdio: ["ignore", "pipe", "pipe"] });
    } else {
      const repositoryRoot = resolve(app.getAppPath(), "../..");
      const manifest = join(repositoryRoot, "native/terminald/Cargo.toml");
      if (!existsSync(manifest)) throw new Error(`terminald manifest not found at ${manifest}`);
      const profileArgs = process.env.TERMINALD_DEV_PROFILE === "debug" ? [] : ["--release"];
      this.#child = spawn("cargo", ["run", "--quiet", ...profileArgs, "--manifest-path", manifest], {
        cwd: repositoryRoot,
        env: environment,
        stdio: ["ignore", "pipe", "pipe"],
      });
    }
    this.#child.stderr?.on("data", (chunk) => console.error(`[terminald] ${String(chunk).trimEnd()}`));
    await this.#waitUntilReady();
    const running = this.#child;
    if (!running || running.exitCode !== null || running.signalCode !== null) {
      this.#child = undefined;
      throw new Error("terminald exited immediately after startup");
    }
    this.#ready = true;
    running?.once("exit", (code, signal) => {
      if (this.#child === running) this.#child = undefined;
      this.#ready = false;
      if (!this.#stopping) this.emit("unexpected-exit", { code, signal });
    });
  }

  get running(): boolean {
    return this.#ready && this.#child !== undefined;
  }

  stop(): void {
    this.#stopping = true;
    this.#ready = false;
    this.#child?.kill("SIGTERM");
    this.#child = undefined;
    rmSync(this.#runtimeDir, { recursive: true, force: true });
  }

  async #waitUntilReady(): Promise<void> {
    const child = this.#child;
    if (!child?.stdout) throw new Error("terminald did not expose stdout");
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
      const timeout = setTimeout(() => fail(new Error("terminald startup timed out")), 120_000);
      const onData = (chunk: Buffer): void => {
        output = `${output}${String(chunk)}`.slice(-4096);
        if (!output.includes("terminald ready") || settled) return;
        settled = true;
        cleanup();
        resolveReady();
      };
      const onError = (error: Error): void => fail(error);
      const onExit = (code: number | null): void => fail(new Error(`terminald exited during startup (${code})`));
      child.once("error", onError);
      child.once("exit", onExit);
      stdout.on("data", onData);
    });
  }
}
