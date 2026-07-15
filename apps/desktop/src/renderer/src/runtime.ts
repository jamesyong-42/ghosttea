import { ControlClient } from "@electron-ghostty/terminal-client";
import {
  PROTOCOL_MAJOR,
  PROTOCOL_MINOR,
  type CreateSessionOptions,
  type SessionSummary,
  type TerminalKeyEvent,
  type TerminalMouseEvent,
} from "@electron-ghostty/terminal-protocol";
import { FrameFlag } from "@electron-ghostty/terminal-frame";
import type { CellSelection, TerminalTheme } from "./renderers/types";

type Ports = { control: MessagePort; frames: MessagePort };
type TerminalMount = {
  resize: (width: number, height: number, dpr: number) => void;
  dispose: () => void;
};

interface MountedCanvas {
  canvas: HTMLCanvasElement;
  sessionHandle: string;
  generation: number;
  references: number;
  disposeTimer: number | undefined;
}

function waitForPorts(): Promise<Ports> {
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      window.removeEventListener("message", listener);
      reject(new Error("Electron did not transfer the terminal control and frame ports"));
    }, 10_000);
    const listener = (event: MessageEvent): void => {
      if (event.data?.type !== "electron-ghostty:ports" || event.ports.length !== 2) return;
      window.clearTimeout(timeout);
      window.removeEventListener("message", listener);
      resolve({ control: event.ports[0]!, frames: event.ports[1]! });
    };
    window.addEventListener("message", listener);
  });
}

export class DesktopTerminalRuntime extends EventTarget {
  readonly #worker = new Worker(new URL("./terminal-render.worker.ts", import.meta.url), { type: "module" });
  #control: ControlClient | undefined;
  #frames: MessagePort | undefined;
  #ready: Promise<void> | undefined;
  readonly #sessionByHandle = new Map<string, SessionSummary>();
  readonly #mountedCanvases = new WeakMap<HTMLCanvasElement, MountedCanvas>();
  readonly #mountGenerationByHandle = new Map<string, number>();
  readonly #mouseTrackingByHandle = new Map<string, boolean>();
  readonly #focusByHandle = new Map<string, boolean>();
  readonly #selectionRequests = new Map<number, (text: string) => void>();
  #nextSelectionRequest = 1;
  #rendererBackend = "starting";
  readonly #metadataTimers = new Map<string, number>();

  constructor() {
    super();
    this.#worker.addEventListener("message", ({ data }: MessageEvent) => {
      if (data?.type === "renderer-status") {
        this.#rendererBackend = data.backend;
        console.info(`[terminal-runtime] renderer backend: ${data.backend}${data.textEngine ? ` + ${data.textEngine} text` : ""}${data.recovered ? " (recovered)" : ""}`);
        this.dispatchEvent(new CustomEvent("renderer-status", { detail: data }));
      } else if (data?.type === "clipboard-write" && typeof data.text === "string") {
        window.desktop.writeClipboard(data.text);
      } else if (data?.type === "selection-text" && typeof data.requestId === "number" && typeof data.text === "string") {
        const resolve = this.#selectionRequests.get(data.requestId);
        if (!resolve) return;
        this.#selectionRequests.delete(data.requestId);
        resolve(data.text);
      }
    });
  }

  get rendererBackend(): string {
    return this.#rendererBackend;
  }

  connect(): Promise<void> {
    this.#ready ??= this.#connect();
    return this.#ready;
  }

  async #connect(): Promise<void> {
    const ports = await waitForPorts();
    console.info("[terminal-runtime] received control and frame ports");
    this.#control = new ControlClient(ports.control);
    this.#frames = ports.frames;
    this.#frames.onmessage = ({ data }: MessageEvent<ArrayBuffer>) => {
      if (data.byteLength >= 16) {
        const view = new DataView(data);
        const sessionHandle = view.getBigUint64(8, true).toString();
        const tracking = (view.getUint16(6, true) & FrameFlag.MouseTracking) !== 0;
        if (this.#mouseTrackingByHandle.get(sessionHandle) !== tracking) {
          this.#mouseTrackingByHandle.set(sessionHandle, tracking);
          this.dispatchEvent(new CustomEvent("terminal-modes", { detail: { sessionHandle, mouseTracking: tracking } }));
        }
        this.#scheduleMetadataRefresh(sessionHandle);
      }
      this.#worker.postMessage({ type: "frame", packet: data }, [data]);
    };
    this.#frames.start();
    const hello = await this.#control.request({ type: "hello", protocolMajor: PROTOCOL_MAJOR, protocolMinor: PROTOCOL_MINOR, clientBuild: "desktop-dev" });
    if (hello.type !== "hello" || hello.protocolMajor !== PROTOCOL_MAJOR) throw new Error("terminald protocol mismatch");
    console.info("[terminal-runtime] authenticated terminald protocol");
  }

  #scheduleMetadataRefresh(sessionHandle: string): void {
    if (this.#metadataTimers.has(sessionHandle)) return;
    const timer = window.setTimeout(() => {
      this.#metadataTimers.delete(sessionHandle);
      const session = this.#sessionByHandle.get(sessionHandle);
      if (!session || !this.#control) return;
      void this.#control.request({ type: "get-session", sessionId: session.id }).then((response) => {
        if (response.type !== "session") return;
        const previous = this.#sessionByHandle.get(sessionHandle);
        this.#sessionByHandle.set(sessionHandle, response.session);
        if (!previous || previous.title !== response.session.title || previous.cwd !== response.session.cwd || previous.exited !== response.session.exited) {
          this.dispatchEvent(new CustomEvent("session-metadata", { detail: response.session }));
        }
      }).catch((error) => console.warn("[terminal-runtime] session metadata refresh failed", error));
    }, 200);
    this.#metadataTimers.set(sessionHandle, timer);
  }

  sessionMetadata(sessionHandle: string): SessionSummary | undefined {
    return this.#sessionByHandle.get(sessionHandle);
  }

  async createSession(options: CreateSessionOptions): Promise<SessionSummary> {
    await this.connect();
    const response = await this.#control!.request({ type: "create-session", options });
    if (response.type !== "session-created") throw new Error("terminald returned an unexpected response");
    this.#sessionByHandle.set(response.session.handle, response.session);
    console.info(`[terminal-runtime] created session ${response.session.id}`);
    return response.session;
  }

  async listSessions(): Promise<SessionSummary[]> {
    await this.connect();
    const response = await this.#control!.request({ type: "list-sessions" });
    if (response.type !== "sessions") throw new Error("terminald returned an unexpected response");
    for (const session of response.sessions) this.#sessionByHandle.set(session.handle, session);
    return response.sessions;
  }

  mount(session: SessionSummary, canvas: HTMLCanvasElement): TerminalMount {
    const mounted = this.#mountedCanvases.get(canvas);
    if (mounted) {
      if (mounted.sessionHandle !== session.handle) {
        throw new Error("A terminal canvas cannot be reassigned to another session");
      }
      mounted.references += 1;
      if (mounted.disposeTimer !== undefined) {
        window.clearTimeout(mounted.disposeTimer);
        mounted.disposeTimer = undefined;
      }
      return this.#createMountLease(mounted);
    }

    const offscreen = canvas.transferControlToOffscreen();
    const generation = (this.#mountGenerationByHandle.get(session.handle) ?? 0) + 1;
    this.#mountGenerationByHandle.set(session.handle, generation);
    this.#worker.postMessage({ type: "mount", sessionHandle: session.handle, canvas: offscreen }, [offscreen]);
    const entry: MountedCanvas = {
      canvas,
      sessionHandle: session.handle,
      generation,
      references: 1,
      disposeTimer: undefined,
    };
    this.#mountedCanvases.set(canvas, entry);
    return this.#createMountLease(entry);
  }

  #createMountLease(mounted: MountedCanvas): TerminalMount {
    let disposed = false;
    return {
      resize: (width, height, dpr) => this.#worker.postMessage({ type: "resize", sessionHandle: mounted.sessionHandle, width, height, dpr }),
      dispose: () => {
        if (disposed) return;
        disposed = true;
        mounted.references -= 1;
        if (mounted.references !== 0) return;
        mounted.disposeTimer = window.setTimeout(() => {
          mounted.disposeTimer = undefined;
          if (mounted.references !== 0) return;
          if (this.#mountGenerationByHandle.get(mounted.sessionHandle) !== mounted.generation) return;
          this.#worker.postMessage({ type: "unmount", sessionHandle: mounted.sessionHandle });
          this.#mountGenerationByHandle.delete(mounted.sessionHandle);
          this.#mountedCanvases.delete(mounted.canvas);
        }, 0);
      },
    };
  }

  sendText(sessionId: string, text: string): void {
    this.#control?.notify({ type: "send-text", sessionId, text });
    const session = [...this.#sessionByHandle.values()].find((candidate) => candidate.id === sessionId);
    if (session) this.#worker.postMessage({ type: "cursor-activity", sessionHandle: session.handle });
  }

  sendKey(sessionId: string, event: TerminalKeyEvent): void {
    this.#control?.notify({ type: "send-key", sessionId, event });
    const session = [...this.#sessionByHandle.values()].find((candidate) => candidate.id === sessionId);
    if (session) this.#worker.postMessage({ type: "cursor-activity", sessionHandle: session.handle });
  }

  sendMouse(sessionId: string, event: TerminalMouseEvent): void {
    this.#control?.notify({ type: "send-mouse", sessionId, event });
  }

  scroll(sessionId: string, rows: number): void {
    if (rows !== 0) this.#control?.notify({ type: "scroll", sessionId, rows });
  }

  isMouseTracking(sessionHandle: string): boolean {
    return this.#mouseTrackingByHandle.get(sessionHandle) ?? false;
  }

  setTheme(sessionHandle: string, theme: TerminalTheme): void {
    this.#worker.postMessage({ type: "theme", sessionHandle, theme });
    const session = this.#sessionByHandle.get(sessionHandle);
    if (!session) return;
    const rgb = (color: TerminalTheme["foreground"]): [number, number, number] => [
      Math.round(color[0] * 255),
      Math.round(color[1] * 255),
      Math.round(color[2] * 255),
    ];
    this.#control?.notify({
      type: "set-colors",
      sessionId: session.id,
      foreground: rgb(theme.foreground),
      background: rgb(theme.background),
      cursor: rgb(theme.cursor),
    });
  }

  setSelection(sessionHandle: string, selection: CellSelection | null): void {
    this.#worker.postMessage({ type: "selection", sessionHandle, selection });
  }

  setFocused(sessionHandle: string, focused: boolean): void {
    if (this.#focusByHandle.get(sessionHandle) === focused) return;
    this.#focusByHandle.set(sessionHandle, focused);
    this.#worker.postMessage({ type: "focus", sessionHandle, focused });
    const session = this.#sessionByHandle.get(sessionHandle);
    if (session) this.#control?.notify({ type: "focus", sessionId: session.id, focused });
  }

  copySelection(sessionHandle: string, selection: CellSelection): Promise<string> {
    const requestId = this.#nextSelectionRequest++;
    return new Promise<string>((resolve) => {
      this.#selectionRequests.set(requestId, resolve);
      this.#worker.postMessage({ type: "selection-text", requestId, sessionHandle, selection });
    }).then((text) => {
      if (text) window.desktop.writeClipboard(text);
      return text;
    });
  }

  interrupt(sessionId: string): void {
    this.#control?.notify({ type: "interrupt", sessionId });
    const session = [...this.#sessionByHandle.values()].find((candidate) => candidate.id === sessionId);
    if (session) this.#worker.postMessage({ type: "cursor-activity", sessionHandle: session.handle });
  }

  terminate(sessionId: string): void {
    this.#control?.notify({ type: "terminate", sessionId });
  }

  resize(sessionId: string, cols: number, rows: number): void {
    this.#control?.notify({ type: "resize", sessionId, cols, rows });
  }
}

export const terminalRuntime = new DesktopTerminalRuntime();
