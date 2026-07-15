import { randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { app } from "electron";

export interface TerminalDaemonConnection {
  controlSocket: string;
  frameSocket: string;
  authToken: string;
}

export class TerminalSupervisor {
  #child: ChildProcess | undefined;
  readonly #runtimeDir = join(tmpdir(), `electron-ghostty-${process.getuid?.() ?? "user"}-${process.pid}`);
  readonly connection: TerminalDaemonConnection;

  constructor() {
    mkdirSync(this.#runtimeDir, { recursive: true, mode: 0o700 });
    this.connection = {
      controlSocket: join(this.#runtimeDir, "control.sock"),
      frameSocket: join(this.#runtimeDir, "frames.sock"),
      authToken: randomBytes(32).toString("hex"),
    };
  }

  async start(): Promise<void> {
    rmSync(this.connection.controlSocket, { force: true });
    rmSync(this.connection.frameSocket, { force: true });
    const environment = {
      ...process.env,
      TERMINALD_CONTROL_SOCKET: this.connection.controlSocket,
      TERMINALD_FRAME_SOCKET: this.connection.frameSocket,
      TERMINALD_AUTH_TOKEN: this.connection.authToken,
    };

    const configuredBinary = process.env.TERMINALD_BIN;
    if (configuredBinary) {
      this.#child = spawn(configuredBinary, [], { env: environment, stdio: ["ignore", "pipe", "pipe"] });
    } else {
      const repositoryRoot = app.isPackaged
        ? process.resourcesPath
        : resolve(app.getAppPath(), "../..");
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
  }

  stop(): void {
    this.#child?.kill("SIGTERM");
    this.#child = undefined;
    rmSync(this.#runtimeDir, { recursive: true, force: true });
  }

  async #waitUntilReady(): Promise<void> {
    const child = this.#child;
    if (!child?.stdout) throw new Error("terminald did not expose stdout");
    const stdout = child.stdout;
    await new Promise<void>((resolveReady, reject) => {
      const timeout = setTimeout(() => reject(new Error("terminald startup timed out")), 120_000);
      const onData = (chunk: Buffer): void => {
        if (!String(chunk).includes("terminald ready")) return;
        clearTimeout(timeout);
        stdout.off("data", onData);
        resolveReady();
      };
      child.once("error", reject);
      child.once("exit", (code) => reject(new Error(`terminald exited during startup (${code})`)));
      stdout.on("data", onData);
    });
  }
}
