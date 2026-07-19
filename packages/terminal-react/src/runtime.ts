import { ControlClient } from "@vibecook/ghosttea";
import {
  PROTOCOL_MAJOR,
  PROTOCOL_MINOR,
  type CreateSessionOptions,
  type RemoteHostSummary,
  type ServerEvent,
  type SessionSummary,
  type SharedSessionSummary,
  type TerminalKeyEvent,
  type TerminalMouseEvent,
  type TerminalScrollbarState,
  type TerminationSource,
} from "@vibecook/ghosttea-protocol";
import { FrameFlag } from "@vibecook/ghosttea-frame";
import type { CellSelection, TerminalTheme } from "./renderers/types.js";
import type { TerminalRenderPerformanceSnapshot } from "./performance.js";
import { FrameResyncController } from "./frame-resync.js";
import type { RendererToWorkerMessage, WorkerToRendererMessage } from "./worker-messages.js";

export interface GhostteaRendererPorts {
  control: MessagePort;
  frames: MessagePort;
}

export interface GhostteaRendererPlatform {
  writeClipboard(text: string): void;
  forceCanvasFallback(): boolean;
  setForceCanvasFallback(enabled: boolean): void;
  reload(): void;
}

export interface GhostteaTerminalRuntimeOptions {
  ports: GhostteaRendererPorts | Promise<GhostteaRendererPorts>;
  platform: GhostteaRendererPlatform;
  workerFactory?: () => Worker;
  clientBuild?: string;
  sessionOwnerId?: string;
}

export type TerminalMount = {
  resize: (width: number, height: number, dpr: number) => void;
  dispose: () => void;
};

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
  readWrite?: boolean;
  inputSequence: number;
  resizeSequence: number;
  controlEpoch: number | undefined;
  desiredCols: number | undefined;
  desiredRows: number | undefined;
  pendingInput: Array<(attachmentEpoch: number, inputSequence: number) => void>;
}

export function waitForGhostteaRendererPorts(timeoutMs = 10_000): Promise<GhostteaRendererPorts> {
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      window.removeEventListener("message", listener);
      reject(new Error("Electron did not transfer the terminal control and frame ports"));
    }, timeoutMs);
    const listener = (event: MessageEvent): void => {
      if (event.data?.type !== "ghosttea:ports" || event.ports.length !== 2) return;
      window.clearTimeout(timeout);
      window.removeEventListener("message", listener);
      resolve({ control: event.ports[0]!, frames: event.ports[1]! });
    };
    window.addEventListener("message", listener);
  });
}

export class GhostteaTerminalRuntime extends EventTarget {
  readonly #worker: Worker;
  readonly #ports: Promise<GhostteaRendererPorts>;
  readonly #platform: GhostteaRendererPlatform;
  readonly #clientBuild: string;
  readonly #sessionOwnerId: string | undefined;
  #control: ControlClient | undefined;
  #frames: MessagePort | undefined;
  #ready: Promise<void> | undefined;
  readonly #sessionByHandle = new Map<string, SessionSummary>();
  readonly #handleBySessionId = new Map<string, string>();
  readonly #mountedCanvases = new WeakMap<HTMLCanvasElement, MountedCanvas>();
  readonly #mountedEntries = new Set<MountedCanvas>();
  readonly #mountGenerationByHandle = new Map<string, number>();
  readonly #mouseTrackingByHandle = new Map<string, boolean>();
  readonly #scrollbarByHandle = new Map<string, TerminalScrollbarState>();
  readonly #focusByView = new Map<string, boolean>();
  readonly #views = new Map<string, ViewRuntimeState>();
  #rendererBackend = "starting";
  readonly #metadataTimers = new Map<string, number>();
  readonly #resync: FrameResyncController;
  #performanceRequestId = 1;
  readonly #performanceRequests = new Map<
    number,
    {
      resolve: (value: TerminalRenderPerformanceSnapshot | undefined) => void;
      reject: (error: Error) => void;
      timer: number;
    }
  >();
  #disposed = false;

  constructor(options: GhostteaTerminalRuntimeOptions) {
    super();
    this.#worker =
      options.workerFactory?.() ??
      new Worker(new URL("./terminal-render.worker.js", import.meta.url), { type: "module" });
    this.#ports = Promise.resolve(options.ports);
    this.#platform = options.platform;
    this.#clientBuild = options.clientBuild ?? "ghosttea-react";
    this.#sessionOwnerId = options.sessionOwnerId;
    this.#resync = new FrameResyncController((sessionHandle) => this.#refreshSession(sessionHandle), {
      onExhausted: (sessionHandle, error) => {
        console.error(`[terminal-runtime] frame resynchronization exhausted for ${sessionHandle}`, error);
        this.dispatchEvent(new CustomEvent("frame-resync-failed", { detail: { sessionHandle, error } }));
      },
    });
    this.#worker.addEventListener("error", (event) => {
      console.error(`[terminal-runtime] render worker failed to start: ${event.message || "unknown worker error"}`);
      this.dispatchEvent(new CustomEvent("renderer-error", { detail: event }));
    });
    this.#worker.addEventListener("messageerror", (event) => {
      console.error("[terminal-runtime] render worker rejected a message", event);
      this.dispatchEvent(new CustomEvent("renderer-error", { detail: event }));
    });
    this.#worker.addEventListener("message", ({ data }: MessageEvent<WorkerToRendererMessage>) => {
      if (data.type === "renderer-status") {
        this.#rendererBackend = data.backend;
        console.info(
          `[terminal-runtime] renderer backend: ${data.backend}${data.textEngine ? ` + ${data.textEngine} text` : ""}${data.recovered ? " (recovered)" : ""}`,
        );
        this.dispatchEvent(new CustomEvent("renderer-status", { detail: data }));
      } else if (data.type === "clipboard-write") {
        this.#platform.writeClipboard(data.text);
      } else if (data.type === "scrollbar-state") {
        this.#scrollbarByHandle.set(data.sessionHandle, data.scrollbar);
        this.dispatchEvent(
          new CustomEvent("scrollbar-state", {
            detail: { sessionHandle: data.sessionHandle, scrollbar: data.scrollbar },
          }),
        );
      } else if (data.type === "frame-resync-needed") {
        this.#resync.request(data.sessionHandle);
      } else if (data.type === "frame-resync-complete") {
        this.#resync.complete(data.sessionHandle);
      } else if (data.type === "performance-started") {
        this.#resolvePerformanceRequest(data.requestId, undefined);
      } else if (data.type === "performance-result") {
        this.#resolvePerformanceRequest(data.requestId, data.snapshot);
      } else if (data.type === "renderer-reload-required") {
        console.error(`[terminal-runtime] renderer requested reload: ${String(data.reason ?? "unknown")}`);
        this.#platform.setForceCanvasFallback(true);
        this.#platform.reload();
      }
    });
    this.#postWorker({
      type: "renderer-config",
      forceCanvasFallback: this.#platform.forceCanvasFallback(),
    });
  }

  #postWorker(message: RendererToWorkerMessage, transfer: Transferable[] = []): void {
    if (this.#disposed) return;
    this.#worker.postMessage(message, transfer);
  }

  get rendererBackend(): string {
    return this.#rendererBackend;
  }

  #resolvePerformanceRequest(requestId: number, value: TerminalRenderPerformanceSnapshot | undefined): void {
    const pending = this.#performanceRequests.get(requestId);
    if (!pending) return;
    window.clearTimeout(pending.timer);
    this.#performanceRequests.delete(requestId);
    pending.resolve(value);
  }

  #performanceRequest(
    send: (requestId: number) => RendererToWorkerMessage,
    timeoutMs: number,
  ): Promise<TerminalRenderPerformanceSnapshot | undefined> {
    if (this.#disposed) return Promise.reject(new Error("Terminal runtime is disposed"));
    const requestId = this.#performanceRequestId++;
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.#performanceRequests.delete(requestId);
        reject(new Error(`Terminal render performance request ${requestId} timed out`));
      }, timeoutMs);
      this.#performanceRequests.set(requestId, { resolve, reject, timer });
      this.#postWorker(send(requestId));
    });
  }

  async startPerformanceMeasurement(): Promise<void> {
    await this.#performanceRequest((requestId) => ({ type: "performance-start", requestId }), 10_000);
  }

  async finishPerformanceMeasurement(
    options: {
      quietMs?: number;
      timeoutMs?: number;
    } = {},
  ): Promise<TerminalRenderPerformanceSnapshot> {
    const quietMs = Math.max(0, options.quietMs ?? 250);
    const timeoutMs = Math.max(quietMs + 1_000, options.timeoutMs ?? 15_000);
    const result = await this.#performanceRequest(
      (requestId) => ({ type: "performance-finish", requestId, quietMs, timeoutMs }),
      timeoutMs + 5_000,
    );
    if (!result) throw new Error("Terminal render worker returned no performance snapshot");
    return result;
  }

  connect(): Promise<void> {
    if (this.#disposed) return Promise.reject(new Error("Terminal runtime is disposed"));
    this.#ready ??= this.#connect();
    return this.#ready;
  }

  async #connect(): Promise<void> {
    const ports = await this.#ports;
    if (this.#disposed) {
      ports.control.close();
      ports.frames.close();
      throw new Error("Terminal runtime was disposed before its ports arrived");
    }
    console.info("[terminal-runtime] received control and frame ports");
    this.#control = new ControlClient(ports.control);
    this.#control.addEventListener("session-exited", (event) => {
      const detail = (event as CustomEvent<Extract<ServerEvent, { type: "session-exited" }>>).detail;
      const handle = this.#handleBySessionId.get(detail.sessionId);
      const session = handle ? this.#sessionByHandle.get(handle) : undefined;
      if (!handle || !session) return;
      this.#cancelMetadataRefresh(handle);
      const exited = {
        ...session,
        exited: true,
        exitCode: detail.exitCode,
        exitSignal: detail.exitSignal,
        requestedTermination: detail.requestedTermination,
        exitOutcome: detail.exitOutcome,
      };
      this.#sessionByHandle.set(handle, exited);
      this.dispatchEvent(new CustomEvent("session-metadata", { detail: exited }));
      this.dispatchEvent(new CustomEvent("session-exited", { detail }));
    });
    this.#control.addEventListener("control-changed", (event) => {
      const detail = (event as CustomEvent<Extract<ServerEvent, { type: "control-changed" }>>).detail;
      for (const [viewId, view] of this.#views) {
        if (view.sessionId !== detail.sessionId) continue;
        if (viewId !== detail.controllerViewId) {
          view.controlEpoch = undefined;
          continue;
        }
        view.controlEpoch = detail.controlEpoch;
        if (
          view.desiredCols !== undefined &&
          view.desiredRows !== undefined &&
          (view.desiredCols !== detail.cols || view.desiredRows !== detail.rows)
        ) {
          this.#sendResize(viewId, view, view.desiredCols, view.desiredRows);
        }
      }
    });
    this.#frames = ports.frames;
    this.#frames.onmessage = ({ data }: MessageEvent<ArrayBuffer>) => {
      if (data.byteLength < 16) return;
      const view = new DataView(data);
      const sessionHandle = view.getBigUint64(8, true).toString();
      // A frame can already be queued in the bridge when its session is
      // terminated. Do not recreate worker state for a session we deliberately
      // dropped, and do not render sessions owned only by automation clients.
      if (!this.#sessionByHandle.has(sessionHandle)) return;
      const tracking = (view.getUint16(6, true) & FrameFlag.MouseTracking) !== 0;
      if (this.#mouseTrackingByHandle.get(sessionHandle) !== tracking) {
        this.#mouseTrackingByHandle.set(sessionHandle, tracking);
        this.dispatchEvent(new CustomEvent("terminal-modes", { detail: { sessionHandle, mouseTracking: tracking } }));
      }
      this.#scheduleMetadataRefresh(sessionHandle);
      this.#postWorker({ type: "frame", packet: data }, [data]);
    };
    this.#frames.start();
    this.#syncFrameSubscriptions();
    const hello = await this.#control.request({
      type: "hello",
      protocolMajor: PROTOCOL_MAJOR,
      protocolMinor: PROTOCOL_MINOR,
      clientBuild: this.#clientBuild,
    });
    if (hello.type !== "hello" || hello.protocolMajor !== PROTOCOL_MAJOR)
      throw new Error("terminald protocol mismatch");
    console.info("[terminal-runtime] authenticated terminald protocol");
  }

  #scheduleMetadataRefresh(sessionHandle: string): void {
    const scheduledSession = this.#sessionByHandle.get(sessionHandle);
    if (!scheduledSession || scheduledSession.exited) return;
    if (this.#metadataTimers.has(sessionHandle)) return;
    const timer = window.setTimeout(() => {
      this.#metadataTimers.delete(sessionHandle);
      const session = this.#sessionByHandle.get(sessionHandle);
      if (!session || session.exited || !this.#control) return;
      void this.#control
        .request({ type: "get-session", sessionId: session.id })
        .then((response) => {
          if (response.type !== "session") return;
          const previous = this.#sessionByHandle.get(sessionHandle);
          if (!previous || previous.id !== response.session.id || previous.exited) return;
          this.#sessionByHandle.set(sessionHandle, response.session);
          if (
            previous.title !== response.session.title ||
            previous.cwd !== response.session.cwd ||
            previous.exited !== response.session.exited
          ) {
            this.dispatchEvent(new CustomEvent("session-metadata", { detail: response.session }));
          }
        })
        .catch((error) => {
          const current = this.#sessionByHandle.get(sessionHandle);
          if (!current || current.exited || this.#disposed) return;
          console.warn("[terminal-runtime] session metadata refresh failed", error);
        });
    }, 200);
    this.#metadataTimers.set(sessionHandle, timer);
  }

  #cancelMetadataRefresh(sessionHandle: string): void {
    const timer = this.#metadataTimers.get(sessionHandle);
    if (timer !== undefined) window.clearTimeout(timer);
    this.#metadataTimers.delete(sessionHandle);
  }

  sessionMetadata(sessionHandle: string): SessionSummary | undefined {
    return this.#sessionByHandle.get(sessionHandle);
  }

  registerSession(session: SessionSummary): void {
    this.#sessionByHandle.set(session.handle, session);
    this.#handleBySessionId.set(session.id, session.handle);
    this.#syncFrameSubscriptions();
  }

  #syncFrameSubscriptions(): void {
    this.#frames?.postMessage({ type: "subscribe", sessionHandles: [...this.#sessionByHandle.keys()] });
  }

  async createSession(options: CreateSessionOptions): Promise<SessionSummary> {
    await this.connect();
    const response = await this.#control!.request({
      type: "create-session",
      options: { ...options, ...(this.#sessionOwnerId ? { ownerId: this.#sessionOwnerId } : {}) },
    });
    if (response.type !== "session-created") throw new Error("terminald returned an unexpected response");
    this.registerSession(response.session);
    console.info(`[terminal-runtime] created session ${response.session.id}`);
    return response.session;
  }

  async listSessions(): Promise<SessionSummary[]> {
    await this.connect();
    const response = await this.#control!.request({ type: "list-sessions" });
    if (response.type !== "sessions") throw new Error("terminald returned an unexpected response");
    for (const session of response.sessions) {
      this.registerSession(session);
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
      ...(this.#sessionOwnerId ? { ownerId: this.#sessionOwnerId } : {}),
    });
    if (response.type !== "session-created") throw new Error("terminald could not open the remote session");
    this.registerSession(response.session);
    return response.session;
  }

  async #refreshSession(sessionHandle: string): Promise<void> {
    const session = this.#sessionByHandle.get(sessionHandle);
    if (!session) return;
    if (!this.#control) throw new Error(`Session ${sessionHandle} is not ready for frame resynchronization`);
    const response = await this.#control.request({ type: "refresh-session", sessionId: session.id });
    if (response.type !== "ok") throw new Error("terminald rejected frame resynchronization");
  }

  mount(sessionId: string, sessionHandle: string, viewId: string, canvas: HTMLCanvasElement): TerminalMount {
    if (this.#disposed) throw new Error("Cannot mount a disposed terminal runtime");
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
    this.#mountedEntries.add(entry);
    const view: ViewRuntimeState = {
      sessionId,
      sessionHandle,
      inputSequence: 0,
      resizeSequence: 0,
      controlEpoch: undefined,
      desiredCols: undefined,
      desiredRows: undefined,
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
        current.readWrite = response.readWrite;
        this.dispatchEvent(
          new CustomEvent("view-attached", {
            detail: { sessionId, sessionHandle, viewId, readWrite: response.readWrite },
          }),
        );
        const previous = this.#sessionByHandle.get(sessionHandle);
        if (previous && previous.readWrite !== response.readWrite) {
          const updated = { ...previous, readWrite: response.readWrite };
          this.#sessionByHandle.set(sessionHandle, updated);
          this.dispatchEvent(new CustomEvent("session-metadata", { detail: updated }));
        }
        const pending = current.pendingInput.splice(0);
        if (!response.readWrite) return;
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
          const ownsWorkerSurface = this.#mountGenerationByHandle.get(mounted.sessionHandle) === mounted.generation;
          if (ownsWorkerSurface) {
            this.#postWorker({ type: "unmount", sessionHandle: mounted.sessionHandle });
            this.#mountGenerationByHandle.delete(mounted.sessionHandle);
          }
          this.#control?.notify({ type: "detach-session", sessionId: mounted.sessionId, viewId: mounted.viewId });
          this.#views.delete(mounted.viewId);
          this.#focusByView.delete(mounted.viewId);
          this.#mountedCanvases.delete(mounted.canvas);
          this.#mountedEntries.delete(mounted);
        }, 0);
      },
    };
  }

  #sendViewInput(viewId: string, operation: (attachmentEpoch: number, inputSequence: number) => void): void {
    const view = this.#views.get(viewId);
    if (!view || view.readWrite === false) return;
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

  scrollTo(sessionId: string, viewId: string, row: number): void {
    if (!Number.isSafeInteger(row) || row < 0) return;
    this.#sendViewInput(viewId, (attachmentEpoch, inputSequence) =>
      this.#control?.notify({ type: "scroll-to", sessionId, viewId, attachmentEpoch, inputSequence, row }),
    );
  }

  scrollbar(sessionHandle: string): TerminalScrollbarState | undefined {
    return this.#scrollbarByHandle.get(sessionHandle);
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

  setVisible(sessionHandle: string, visible: boolean): void {
    this.#postWorker({ type: "visibility", sessionHandle, visible });
  }

  claimResizeControl(sessionHandle: string, viewId: string, cols: number, rows: number): void {
    const view = this.#views.get(viewId);
    if (view) {
      view.desiredCols = cols;
      view.desiredRows = rows;
    }
    const session = this.#sessionByHandle.get(sessionHandle);
    if (!session) return;
    this.#sendViewInput(viewId, (attachmentEpoch) => {
      this.#control?.notify({
        type: "focus-and-resize",
        sessionId: session.id,
        viewId,
        attachmentEpoch,
        cols,
        rows,
      });
    });
  }

  setFocused(sessionHandle: string, viewId: string, focused: boolean, cols: number, rows: number): void {
    const view = this.#views.get(viewId);
    if (view) {
      view.desiredCols = cols;
      view.desiredRows = rows;
    }
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

  async copySelection(sessionId: string, viewId: string, selection: CellSelection, selectAll = false): Promise<string> {
    await this.connect();
    const view = this.#views.get(viewId);
    if (!view || view.sessionId !== sessionId || view.attachmentEpoch === undefined) return "";
    const response = await this.#control!.request({
      type: "selection-text",
      sessionId,
      viewId,
      attachmentEpoch: view.attachmentEpoch,
      startColumn: selection.anchor.column,
      startRow: selection.anchor.row,
      endColumn: selection.focus.column,
      endRow: selection.focus.row,
      selectAll,
    });
    if (response.type !== "selection-text") throw new Error("terminald returned an unexpected selection response");
    if (response.text) this.#platform.writeClipboard(response.text);
    return response.text;
  }

  interrupt(sessionId: string, viewId: string): void {
    this.#sendViewInput(viewId, (attachmentEpoch, inputSequence) =>
      this.#control?.notify({ type: "interrupt", sessionId, viewId, attachmentEpoch, inputSequence }),
    );
    const handle = this.#handleBySessionId.get(sessionId);
    if (handle) this.#postWorker({ type: "cursor-activity", sessionHandle: handle });
  }

  terminate(sessionId: string, source: TerminationSource = "user"): void {
    this.#control?.notify({ type: "terminate", sessionId, source });
    const handle = this.#handleBySessionId.get(sessionId);
    if (!handle) return;
    this.#cancelMetadataRefresh(handle);
    this.#mouseTrackingByHandle.delete(handle);
    this.#scrollbarByHandle.delete(handle);
    for (const [viewId, view] of this.#views) {
      if (view.sessionId === sessionId) {
        this.#views.delete(viewId);
        this.#focusByView.delete(viewId);
      }
    }
    this.#sessionByHandle.delete(handle);
    this.#handleBySessionId.delete(sessionId);
    this.#syncFrameSubscriptions();
    this.#resync.cancel(handle);
    this.#postWorker({ type: "drop-session", sessionHandle: handle });
  }

  resize(sessionId: string, viewId: string, cols: number, rows: number): void {
    const view = this.#views.get(viewId);
    if (!view || view.sessionId !== sessionId) return;
    view.desiredCols = cols;
    view.desiredRows = rows;
    if (view.attachmentEpoch === undefined || view.controlEpoch === undefined) return;
    this.#sendResize(viewId, view, cols, rows);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const [viewId, view] of this.#views) {
      view.pendingInput.length = 0;
      this.#control?.notify({ type: "detach-session", sessionId: view.sessionId, viewId });
    }
    for (const mounted of this.#mountedEntries) {
      if (mounted.disposeTimer !== undefined) window.clearTimeout(mounted.disposeTimer);
      this.#mountedCanvases.delete(mounted.canvas);
    }
    this.#mountedEntries.clear();
    for (const timer of this.#metadataTimers.values()) window.clearTimeout(timer);
    this.#metadataTimers.clear();
    this.#resync.dispose();
    for (const request of this.#performanceRequests.values()) {
      window.clearTimeout(request.timer);
      request.reject(new Error("Terminal runtime was disposed during a performance request"));
    }
    this.#performanceRequests.clear();
    this.#views.clear();
    this.#focusByView.clear();
    this.#mountGenerationByHandle.clear();
    this.#mouseTrackingByHandle.clear();
    this.#scrollbarByHandle.clear();
    this.#sessionByHandle.clear();
    this.#handleBySessionId.clear();
    if (this.#frames) {
      this.#frames.onmessage = null;
      this.#frames.close();
      this.#frames = undefined;
    }
    this.#control?.dispose();
    this.#control = undefined;
    this.#worker.terminate();
    void this.#ports.then(
      (ports) => {
        ports.control.close();
        ports.frames.close();
      },
      () => undefined,
    );
  }

  #sendResize(viewId: string, view: ViewRuntimeState, cols: number, rows: number): void {
    if (view.attachmentEpoch === undefined || view.controlEpoch === undefined) return;
    view.resizeSequence += 1;
    this.#control?.notify({
      type: "resize",
      sessionId: view.sessionId,
      viewId,
      attachmentEpoch: view.attachmentEpoch,
      controlEpoch: view.controlEpoch,
      resizeSequence: view.resizeSequence,
      cols,
      rows,
    });
  }
}

export function createGhostteaTerminalRuntime(options: GhostteaTerminalRuntimeOptions): GhostteaTerminalRuntime {
  return new GhostteaTerminalRuntime(options);
}
