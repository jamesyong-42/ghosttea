import { EventEmitter } from "node:events";
import type { WebContents } from "electron";
import { GhostteaElectronBridge, type GhostteaElectronBridgeOptions } from "./bridge.js";
import { TerminalSupervisor, type TerminalSupervisorOptions } from "./supervisor.js";
import type { TerminalDaemonConnection } from "./types.js";

export type GhostteaElectronBackendOptions =
  | {
      mode: "managed";
      daemon: TerminalSupervisorOptions;
      bridge?: Omit<GhostteaElectronBridgeOptions, "connection">;
    }
  | {
      mode: "external";
      connection: TerminalDaemonConnection;
      bridge?: Omit<GhostteaElectronBridgeOptions, "connection">;
    };

export class GhostteaElectronBackend extends EventEmitter {
  readonly #options: GhostteaElectronBackendOptions;
  readonly #supervisor: TerminalSupervisor | undefined;
  #bridge: GhostteaElectronBridge | undefined;

  constructor(options: GhostteaElectronBackendOptions) {
    super();
    this.#options = options;
    this.#supervisor = options.mode === "managed" ? new TerminalSupervisor(options.daemon) : undefined;
    this.#supervisor?.on("unexpected-exit", (detail) => this.emit("unexpected-exit", { source: "daemon", ...detail }));
  }

  get connection(): TerminalDaemonConnection {
    return this.#options.mode === "managed" ? this.#supervisor!.connection : this.#options.connection;
  }

  get running(): boolean {
    const daemonReady = this.#options.mode === "external" || this.#supervisor?.running === true;
    return daemonReady && this.#bridge?.running === true;
  }

  async start(): Promise<void> {
    await this.#supervisor?.start();
    if (!this.#bridge) {
      this.#bridge = new GhostteaElectronBridge({
        ...this.#options.bridge,
        connection: this.connection,
      });
      this.#bridge.on("unexpected-exit", (detail) => {
        this.#bridge = undefined;
        this.emit("unexpected-exit", { source: "bridge", ...detail });
      });
    }
    this.#bridge.start();
  }

  attachRenderer(webContents: WebContents): void {
    this.#bridge?.attachRenderer(webContents);
  }

  stop(): void {
    this.#bridge?.stop();
    this.#bridge = undefined;
    this.#supervisor?.stop();
  }
}
