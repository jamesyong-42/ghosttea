import { EventEmitter } from "node:events";
import type { WebContents } from "electron";
import { GhostteaAutomationClient, type GhostteaAutomationClientOptions } from "./automation.js";
import { GhostteaElectronBridge, type GhostteaElectronBridgeOptions } from "./bridge.js";
import { TerminalSupervisor, type TerminalSupervisorOptions } from "./supervisor.js";
import type { TerminalDaemonConnection } from "./types.js";

export type GhostteaElectronBackendOptions =
  | {
      mode: "managed";
      daemon: TerminalSupervisorOptions;
      bridge?: Omit<GhostteaElectronBridgeOptions, "connection">;
      automation?: GhostteaAutomationClientOptions;
    }
  | {
      mode: "external";
      connection: TerminalDaemonConnection;
      bridge?: Omit<GhostteaElectronBridgeOptions, "connection">;
      automation?: GhostteaAutomationClientOptions;
    };

export class GhostteaElectronBackend extends EventEmitter {
  readonly #options: GhostteaElectronBackendOptions;
  readonly #supervisor: TerminalSupervisor | undefined;
  #bridge: GhostteaElectronBridge | undefined;
  #automation: GhostteaAutomationClient | undefined;

  constructor(options: GhostteaElectronBackendOptions) {
    super();
    this.#options = options;
    this.#supervisor = options.mode === "managed" ? new TerminalSupervisor(options.daemon) : undefined;
    this.#supervisor?.on("unexpected-exit", (detail) => {
      this.#resetClients();
      this.emit("unexpected-exit", { source: "daemon", ...detail });
    });
  }

  #resetClients(): void {
    this.#automation?.dispose();
    this.#automation = undefined;
    this.#bridge?.stop();
    this.#bridge = undefined;
  }

  get connection(): TerminalDaemonConnection {
    return this.#options.mode === "managed" ? this.#supervisor!.connection : this.#options.connection;
  }

  get running(): boolean {
    const daemonReady = this.#options.mode === "external" || this.#supervisor?.running === true;
    return daemonReady && this.#bridge?.running === true;
  }

  get automation(): GhostteaAutomationClient {
    this.#automation ??= new GhostteaAutomationClient(this.connection, this.#options.automation);
    return this.#automation;
  }

  async start(): Promise<void> {
    await this.#supervisor?.start();
    await this.automation.connect();
    if (!this.#bridge) {
      this.#bridge = new GhostteaElectronBridge({
        ...this.#options.bridge,
        connection: this.connection,
      });
      this.#bridge.on("unexpected-exit", (detail) => {
        this.#bridge = undefined;
        this.emit("unexpected-exit", { source: "bridge", ...detail });
      });
      this.#bridge.on("connection-lost", (detail) => {
        this.#resetClients();
        this.emit("unexpected-exit", { source: "connection", code: null, signal: null, ...detail });
      });
    }
    this.#bridge.start();
  }

  attachRenderer(webContents: WebContents): void {
    this.#bridge?.attachRenderer(webContents);
  }

  async stop(): Promise<void> {
    this.#resetClients();
    await this.#supervisor?.stop();
  }
}
