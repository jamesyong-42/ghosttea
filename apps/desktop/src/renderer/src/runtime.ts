import { ControlClient } from "@electron-ghostty/terminal-client";
import {
  PROTOCOL_MAJOR,
  PROTOCOL_MINOR,
  type CreateSessionOptions,
  type RemoteHostSummary,
  type SessionSummary,
  type SharedSessionSummary,
  type TerminalKeyEvent,
  type TerminalMouseEvent,
} from "@electron-ghostty/terminal-protocol";
import { FrameFlag } from "@electron-ghostty/terminal-frame";
import type { CellSelection, TerminalTheme } from "./renderers/types";
import { FrameResyncController } from "./frame-resync";
import type { RendererToWorkerMessage, WorkerToRendererMessage } from "../../shared/terminal-ipc";

type Ports = { control: MessagePort; frames: MessagePort };
type TerminalMount = {
  resize: (width: number, height: number, dpr: number) => void;
  dispose: () => void;
};
type SelectionRequest = { resolve: (text: string) => void; timeout: number };

interface MountedCanvas {
  canvas: HTMLCanvasElement;
  sessionHandle: string;
  sessionId: string;
  viewId: string;
  generation: number;
  references: number;
  disposeTimer: number | undefined;
}

interface ViewRuntimeState {
  sessionId: string;
  sessionHandle: string;
  attachmentEpoch?: number;
  inputSequence: number;
  resizeSequence: number;
  controlEpoch: number | undefined;
  pendingInput: Array<(attachmentEpoch: number, inputSequence: number) => void>;
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
  readonly #handleBySessionId = new Map<string, string>();
  readonly #mountedCanvases = new WeakMap<HTMLCanvasElement, MountedCanvas>();
  readonly #mountGenerationByHandle = new Map<string, number>();
  readonly #mouseTrackingByHandle = new Map<string, boolean>();
  readonly #focusByView = new Map<string, boolean>();
  readonly #views = new Map<string, ViewRuntimeState>();
  readonly #selectionRequests = new Map<number, SelectionRequest>();
  #nextSelectionRequest = 1;
  #rendererBackend = "starting";
  readonly #metadataTimers = new Map<string, number>();
  readonly #resync: FrameResyncController;

  constructor() {
    super();
    this.#resync = new FrameResyncController((sessionHandle) => this.#refreshSession(sessionHandle), {
      onExhausted: (sessionHandle, error) => {
        console.error(`[terminal-runtime] frame resynchronization exhausted for ${sessionHandle}`, error);
        this.dispatchEvent(new CustomEvent("frame-resync-failed", { detail: { sessionHandle, error } }));
      },
    });
    this.#worker.addEventListener("message", ({ data }: MessageEvent<WorkerToRendererMessage>) => {
      if (data.type === "renderer-status") {
        this.#rendererBackend = data.backend;
        console.info(
          `[terminal-runtime] renderer backend: ${data.backend}${data.textEngine ? ` + ${data.textEngine} text` : ""}${data.recovered ? " (recovered)" : ""}`,
        );
        this.dispatchEvent(new CustomEvent("renderer-status", { detail: data }));
      } else if (data.type === "clipboard-write") {
        window.desktop.writeClipboard(data.text);
      } else if (data.type === "selection-text") {
        const request = this.#selectionRequests.get(data.requestId);
        if (!request) return;
        this.#selectionRequests.delete(data.requestId);
        window.clearTimeout(request.timeout);
        request.resolve(data.text);
      } else if (data.type === "frame-resync-needed") {
        this.#resync.request(data.sessionHandle);
      } else if (data.type === "frame-resync-complete") {
        this.#resync.complete(data.sessionHandle);
      } else if (data.type === "renderer-reload-required") {
        console.error(`[terminal-runtime] renderer requested reload: ${String(data.reason ?? "unknown")}`);
        sessionStorage.setItem("electron-ghostty:force-canvas-fallback", "1");
        window.location.reload();
      }
    });
    this.#postWorker({
      type: "renderer-config",
      forceCanvasFallback: sessionStorage.getItem("electron-ghostty:force-canvas-fallback") === "1",
    });
  }

  #postWorker(message: RendererToWorkerMessage, transfer: Transferable[] = []): void {
    this.#worker.postMessage(message, transfer);
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
    this.#control.addEventListener("session-exited", (event) => {
      const detail = (event as CustomEvent<{ sessionId: string; exitCode: number | null }>).detail;
      const handle = this.#handleBySessionId.get(detail.sessionId);
      const session = handle ? this.#sessionByHandle.get(handle) : undefined;
      if (!handle || !session) return;
      const exited = { ...session, exited: true };
      this.#sessionByHandle.set(handle, exited);
      this.dispatchEvent(new CustomEvent("session-metadata", { detail: exited }));
      this.dispatchEvent(new CustomEvent("session-exited", { detail }));
    });
    this.#control.addEventListener("control-changed", (event) => {
      const detail = (
        event as CustomEvent<{
          sessionId: string;
          controllerViewId: string;
          controlEpoch: number;
        }>
      ).detail;
      for (const [viewId, view] of this.#views) {
        if (view.sessionId !== detail.sessionId) continue;
        view.controlEpoch = viewId === detail.controllerViewId ? detail.controlEpoch : undefined;
      }
    });
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
      this.#postWorker({ type: "frame", packet: data }, [data]);
    };
    this.#frames.start();
    const hello = await this.#control.request({
      type: "hello",
      protocolMajor: PROTOCOL_MAJOR,
      protocolMinor: PROTOCOL_MINOR,
      clientBuild: "desktop-dev",
    });
    if (hello.type !== "hello" || hello.protocolMajor !== PROTOCOL_MAJOR)
      throw new Error("terminald protocol mismatch");
    console.info("[terminal-runtime] authenticated terminald protocol");
  }

  #scheduleMetadataRefresh(sessionHandle: string): void {
    if (this.#metadataTimers.has(sessionHandle)) return;
    const timer = window.setTimeout(() => {
      this.#metadataTimers.delete(sessionHandle);
      const session = this.#sessionByHandle.get(sessionHandle);
      if (!session || !this.#control) return;
      void this.#control
        .request({ type: "get-session", sessionId: session.id })
        .then((response) => {
          if (response.type !== "session") return;
          const previous = this.#sessionByHandle.get(sessionHandle);
          this.#sessionByHandle.set(sessionHandle, response.session);
          if (
            !previous ||
            previous.title !== response.session.title ||
            previous.cwd !== response.session.cwd ||
            previous.exited !== response.session.exited
          ) {
            this.dispatchEvent(new CustomEvent("session-metadata", { detail: response.session }));
          }
        })
        .catch((error) => console.warn("[terminal-runtime] session metadata refresh failed", error));
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
    this.#handleBySessionId.set(response.session.id, response.session.handle);
    console.info(`[terminal-runtime] created session ${response.session.id}`);
    return response.session;
  }

  async listSessions(): Promise<SessionSummary[]> {
    await this.connect();
    const response = await this.#control!.request({ type: "list-sessions" });
    if (response.type !== "sessions") throw new Error("terminald returned an unexpected response");
    for (const session of response.sessions) {
      this.#sessionByHandle.set(session.handle, session);
      this.#handleBySessionId.set(session.id, session.handle);
    }
    return response.sessions;
  }

  async listRemoteHosts(): Promise<RemoteHostSummary[]> {
    await this.connect();
    const response = await this.#control!.request({ type: "list-remote-hosts" });
    if (response.type !== "remote-hosts") throw new Error("terminald returned an unexpected response");
    return response.hosts;
  }

  async listRemoteSessions(deviceId: string): Promise<SharedSessionSummary[]> {
    await this.connect();
    const response = await this.#control!.request({ type: "list-remote-sessions", deviceId }, 35_000);
    if (response.type !== "remote-sessions" || response.deviceId !== deviceId)
      throw new Error("terminald returned an unexpected response");
    return response.sessions;
  }

  async openRemoteSession(
    deviceId: string,
    remoteSessionId: string,
    cols: number,
    rows: number,
  ): Promise<SessionSummary> {
    await this.connect();
    const response = await this.#control!.request({
      type: "open-remote-session",
      deviceId,
      remoteSessionId,
      cols,
      rows,
    });
    if (response.type !== "session-created") throw new Error("terminald could not open the remote session");
    this.#sessionByHandle.set(response.session.handle, response.session);
    this.#handleBySessionId.set(response.session.id, response.session.handle);
    return response.session;
  }

  async #refreshSession(sessionHandle: string): Promise<void> {
    const session = this.#sessionByHandle.get(sessionHandle);
    if (!session || !this.#control)
      throw new Error(`Session ${sessionHandle} is not ready for frame resynchronization`);
    const response = await this.#control.request({ type: "refresh-session", sessionId: session.id });
    if (response.type !== "ok") throw new Error("terminald rejected frame resynchronization");
  }

  mount(sessionId: string, sessionHandle: string, viewId: string, canvas: HTMLCanvasElement): TerminalMount {
    const mounted = this.#mountedCanvases.get(canvas);
    if (mounted) {
      if (mounted.sessionHandle !== sessionHandle) {
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
    const generation = (this.#mountGenerationByHandle.get(sessionHandle) ?? 0) + 1;
    this.#mountGenerationByHandle.set(sessionHandle, generation);
    this.#postWorker({ type: "mount", sessionHandle, canvas: offscreen }, [offscreen]);
    const entry: MountedCanvas = {
      canvas,
      sessionHandle,
      sessionId,
      viewId,
      generation,
      references: 1,
      disposeTimer: undefined,
    };
    this.#mountedCanvases.set(canvas, entry);
    const view: ViewRuntimeState = {
      sessionId,
      sessionHandle,
      inputSequence: 0,
      resizeSequence: 0,
      controlEpoch: undefined,
      pendingInput: [],
    };
    this.#views.set(viewId, view);
    void this.#control
      ?.request({ type: "attach-session", sessionId, viewId }, 60_000)
      .then((response) => {
        if (response.type !== "view-attached" || response.viewId !== viewId) {
          throw new Error("terminald returned an invalid view attachment");
        }
        const current = this.#views.get(viewId);
        if (current !== view) return;
        current.attachmentEpoch = response.attachmentEpoch;
        const pending = current.pendingInput.splice(0);
        for (const operation of pending) {
          current.inputSequence += 1;
          operation(response.attachmentEpoch, current.inputSequence);
        }
      })
      .catch((error) => console.error(`[terminal-runtime] failed to attach view ${viewId}`, error));
    return this.#createMountLease(entry);
  }

  #createMountLease(mounted: MountedCanvas): TerminalMount {
    let disposed = false;
    return {
      resize: (width, height, dpr) =>
        this.#postWorker({ type: "resize", sessionHandle: mounted.sessionHandle, width, height, dpr }),
      dispose: () => {
        if (disposed) return;
        disposed = true;
        mounted.references -= 1;
        if (mounted.references !== 0) return;
        mounted.disposeTimer = window.setTimeout(() => {
          mounted.disposeTimer = undefined;
          if (mounted.references !== 0) return;
          if (this.#mountGenerationByHandle.get(mounted.sessionHandle) !== mounted.generation) return;
          this.#postWorker({ type: "unmount", sessionHandle: mounted.sessionHandle });
          this.#control?.notify({ type: "detach-session", sessionId: mounted.sessionId, viewId: mounted.viewId });
          this.#views.delete(mounted.viewId);
          this.#focusByView.delete(mounted.viewId);
          this.#mountGenerationByHandle.delete(mounted.sessionHandle);
          this.#mountedCanvases.delete(mounted.canvas);
        }, 0);
      },
    };
  }

  #sendViewInput(viewId: string, operation: (attachmentEpoch: number, inputSequence: number) => void): void {
    const view = this.#views.get(viewId);
    if (!view) return;
    if (view.attachmentEpoch === undefined) {
      if (view.pendingInput.length < 256) view.pendingInput.push(operation);
      return;
    }
    view.inputSequence += 1;
    operation(view.attachmentEpoch, view.inputSequence);
  }

  sendText(sessionId: string, viewId: string, text: string): void {
    this.#sendViewInput(viewId, (attachmentEpoch, inputSequence) =>
      this.#control?.notify({ type: "send-text", sessionId, viewId, attachmentEpoch, inputSequence, text }),
    );
    const handle = this.#handleBySessionId.get(sessionId);
    if (handle) this.#postWorker({ type: "cursor-activity", sessionHandle: handle });
  }

  paste(sessionId: string, viewId: string, text: string): void {
    this.#sendViewInput(viewId, (attachmentEpoch, inputSequence) =>
      this.#control?.notify({ type: "paste", sessionId, viewId, attachmentEpoch, inputSequence, text }),
    );
    const handle = this.#handleBySessionId.get(sessionId);
    if (handle) this.#postWorker({ type: "cursor-activity", sessionHandle: handle });
  }

  sendKey(sessionId: string, viewId: string, event: TerminalKeyEvent): void {
    this.#sendViewInput(viewId, (attachmentEpoch, inputSequence) =>
      this.#control?.notify({ type: "send-key", sessionId, viewId, attachmentEpoch, inputSequence, event }),
    );
    const handle = this.#handleBySessionId.get(sessionId);
    if (handle) this.#postWorker({ type: "cursor-activity", sessionHandle: handle });
  }

  sendMouse(sessionId: string, viewId: string, event: TerminalMouseEvent): void {
    this.#sendViewInput(viewId, (attachmentEpoch, inputSequence) =>
      this.#control?.notify({ type: "send-mouse", sessionId, viewId, attachmentEpoch, inputSequence, event }),
    );
  }

  scroll(sessionId: string, viewId: string, rows: number): void {
    if (rows === 0) return;
    this.#sendViewInput(viewId, (attachmentEpoch, inputSequence) =>
      this.#control?.notify({ type: "scroll", sessionId, viewId, attachmentEpoch, inputSequence, rows }),
    );
  }

  isMouseTracking(sessionHandle: string): boolean {
    return this.#mouseTrackingByHandle.get(sessionHandle) ?? false;
  }

  setTheme(sessionHandle: string, theme: TerminalTheme): void {
    this.#postWorker({ type: "theme", sessionHandle, theme });
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
    this.#postWorker({ type: "selection", sessionHandle, selection });
  }

  setFocused(sessionHandle: string, viewId: string, focused: boolean, cols: number, rows: number): void {
    if (this.#focusByView.get(viewId) === focused) return;
    this.#focusByView.set(viewId, focused);
    this.#postWorker({ type: "focus", sessionHandle, focused });
    const session = this.#sessionByHandle.get(sessionHandle);
    if (!session) return;
    this.#sendViewInput(viewId, (attachmentEpoch, inputSequence) => {
      this.#control?.notify({
        type: "focus",
        sessionId: session.id,
        viewId,
        attachmentEpoch,
        inputSequence,
        focused,
      });
      if (focused) {
        this.#control?.notify({
          type: "focus-and-resize",
          sessionId: session.id,
          viewId,
          attachmentEpoch,
          cols,
          rows,
        });
      }
    });
  }

  copySelection(sessionHandle: string, selection: CellSelection): Promise<string> {
    const requestId = this.#nextSelectionRequest++;
    return new Promise<string>((resolve) => {
      const timeout = window.setTimeout(() => {
        this.#selectionRequests.delete(requestId);
        resolve("");
      }, 5_000);
      this.#selectionRequests.set(requestId, { resolve, timeout });
      this.#postWorker({ type: "selection-text", requestId, sessionHandle, selection });
    }).then((text) => {
      if (text) window.desktop.writeClipboard(text);
      return text;
    });
  }

  interrupt(sessionId: string, viewId: string): void {
    this.#sendViewInput(viewId, (attachmentEpoch, inputSequence) =>
      this.#control?.notify({ type: "interrupt", sessionId, viewId, attachmentEpoch, inputSequence }),
    );
    const handle = this.#handleBySessionId.get(sessionId);
    if (handle) this.#postWorker({ type: "cursor-activity", sessionHandle: handle });
  }

  terminate(sessionId: string): void {
    this.#control?.notify({ type: "terminate", sessionId });
    const handle = this.#handleBySessionId.get(sessionId);
    if (!handle) return;
    const timer = this.#metadataTimers.get(handle);
    if (timer !== undefined) window.clearTimeout(timer);
    this.#metadataTimers.delete(handle);
    this.#mouseTrackingByHandle.delete(handle);
    for (const [viewId, view] of this.#views) {
      if (view.sessionId === sessionId) {
        this.#views.delete(viewId);
        this.#focusByView.delete(viewId);
      }
    }
    this.#sessionByHandle.delete(handle);
    this.#handleBySessionId.delete(sessionId);
    this.#resync.cancel(handle);
    this.#postWorker({ type: "drop-session", sessionHandle: handle });
  }

  resize(sessionId: string, viewId: string, cols: number, rows: number): void {
    const view = this.#views.get(viewId);
    if (
      !view ||
      view.attachmentEpoch === undefined ||
      view.controlEpoch === undefined ||
      !this.#focusByView.get(viewId)
    )
      return;
    view.resizeSequence += 1;
    this.#control?.notify({
      type: "resize",
      sessionId,
      viewId,
      attachmentEpoch: view.attachmentEpoch,
      controlEpoch: view.controlEpoch,
      resizeSequence: view.resizeSequence,
      cols,
      rows,
    });
  }
}

export const terminalRuntime = new DesktopTerminalRuntime();
