import type { ClientCommand, ServerEvent } from "@electron-ghostty/terminal-protocol";
import { isServerEvent } from "@electron-ghostty/terminal-protocol";

type CommandPayload = ClientCommand extends infer Command
  ? Command extends { requestId: number }
    ? Omit<Command, "requestId">
    : never
  : never;

type PendingRequest = {
  resolve: (event: ServerEvent) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
};

export class ControlClient extends EventTarget {
  readonly #port: MessagePort;
  readonly #pending = new Map<number, PendingRequest>();
  #nextRequestId = 1;

  constructor(port: MessagePort) {
    super();
    this.#port = port;
    this.#port.addEventListener("message", this.#onMessage);
    this.#port.start();
  }

  request(command: CommandPayload, timeoutMs = 10_000): Promise<ServerEvent> {
    const requestId = this.#nextRequestId++;
    const envelope = { ...command, requestId } as ClientCommand;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#pending.delete(requestId);
        reject(new Error(`Terminal request timed out: ${command.type}`));
      }, timeoutMs);
      this.#pending.set(requestId, { resolve, reject, timeout });
      this.#port.postMessage(envelope);
    });
  }

  notify(command: CommandPayload): void {
    this.#port.postMessage({ ...command, requestId: this.#nextRequestId++ });
  }

  dispose(): void {
    this.#port.removeEventListener("message", this.#onMessage);
    this.#port.close();
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error("Terminal control channel closed"));
    }
    this.#pending.clear();
  }

  readonly #onMessage = (message: MessageEvent<unknown>): void => {
    if (!isServerEvent(message.data)) return;
    const event = message.data;
    if (event.requestId === 0) {
      this.dispatchEvent(new CustomEvent(event.type, { detail: event }));
      return;
    }
    const pending = this.#pending.get(event.requestId);
    if (!pending) return;
    this.#pending.delete(event.requestId);
    clearTimeout(pending.timeout);
    if (event.type === "error") pending.reject(new Error(event.message));
    else pending.resolve(event);
  };
}
