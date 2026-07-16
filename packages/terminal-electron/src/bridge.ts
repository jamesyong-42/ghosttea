import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";
import { MessageChannelMain, utilityProcess, type UtilityProcess, type WebContents } from "electron";
import type { MainToBridgeMessage, TerminalDaemonConnection } from "./types.js";

export interface GhostteaElectronBridgeOptions {
  connection: TerminalDaemonConnection;
  entryPoint?: string;
  serviceName?: string;
  rendererChannel?: string;
}

export class GhostteaElectronBridge extends EventEmitter {
  readonly #options: GhostteaElectronBridgeOptions;
  #process: UtilityProcess | undefined;

  constructor(options: GhostteaElectronBridgeOptions) {
    super();
    this.#options = options;
  }

  get running(): boolean {
    return this.#process !== undefined;
  }

  start(): void {
    if (this.#process) return;
    const entryPoint = this.#options.entryPoint ?? fileURLToPath(new URL("./bridge-entry.js", import.meta.url));
    const child = utilityProcess.fork(entryPoint, [], {
      serviceName: this.#options.serviceName ?? "ghosttea-terminal-bridge",
    });
    this.#process = child;
    child.once("exit", (code) => {
      if (this.#process === child) this.#process = undefined;
      this.emit("unexpected-exit", { code });
    });
  }

  attachRenderer(webContents: WebContents): void {
    const child = this.#process;
    if (!child) throw new Error("Ghosttea Electron bridge is not running");
    const control = new MessageChannelMain();
    const frames = new MessageChannelMain();
    child.postMessage({ type: "connect", connection: this.#options.connection } satisfies MainToBridgeMessage, [
      control.port1,
      frames.port1,
    ]);
    webContents.postMessage(this.#options.rendererChannel ?? "terminal-ports", null, [control.port2, frames.port2]);
  }

  stop(): void {
    const child = this.#process;
    this.#process = undefined;
    child?.kill();
  }
}
