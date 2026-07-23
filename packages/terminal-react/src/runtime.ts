import { ControlClient } from "@vibecook/ghosttea";
import {
  PROTOCOL_MAJOR,
  PROTOCOL_MINOR,
  type CreateSessionOptions,
  type RemoteHostSummary,
  type SessionActivity,
  type ServerEvent,
  type SessionSummary,
  type SharedSessionSummary,
  type TerminalKeyEvent,
  type TerminalMouseEvent,
  type TerminalScrollbarState,
  type TerminationSource,
} from "@vibecook/ghosttea-protocol";
import { FRAME_MAGIC, FrameFlag } from "@vibecook/ghosttea-frame";
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
  frameSubscriptionGraceMs?: number;
}

export type TerminalMount = {
  resize: (width: number, height: number, dpr: number) => void;
  dispose: () => void;
};

function sameSessionActivity(left: SessionActivity, right: SessionActivity): boolean {
  return (
    left.kind === right.kind &&
    left.source === right.source &&
    left.confidence === right.confidence &&
    left.rootProcessGroupId === right.rootProcessGroupId &&
    left.foregroundProcessGroupId === right.foregroundProcessGroupId &&
    left.observedAtMs === right.observedAtMs
  );
}

interface MountedCanvas {
  canvas: HTMLCanvasElement;
  sessionHandle: string;
  sessionId: string;
  viewId: string;
  generation: number;
  references: number;
  disposeTimer: number | undefined;
  active: boolean;
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

type FrameChannelMessage =
  | ArrayBuffer
  | { type: "subscription-ack"; requestId: number }
  | { type: "frame-gap"; skipped: number; sessionHandles?: string[]; historyComplete?: boolean }
  | { type: "bridge-capabilities"; requestId: number; protocolVersion: number; frameCredits: boolean };

const FRAME_SUBSCRIPTION_ACK_TIMEOUT_MS = 10_000;
const FRAME_SUBSCRIPTION_ACK_PROTOCOL_MINOR = 7;
const FRAME_BRIDGE_CAPABILITY_VERSION = 1;
const DEFAULT_FRAME_SUBSCRIPTION_GRACE_MS = 1_000;

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
  readonly #frameSubscriptionGraceMs: number;
  #control: ControlClient | undefined;
  #frames: MessagePort | undefined;
  #ready: Promise<void> | undefined;
  readonly #sessionByHandle = new Map<string, SessionSummary>();
  readonly #handleBySessionId = new Map<string, string>();
  readonly #subscribedSessionHandles = new Set<string>();
  readonly #pinnedSessionHandles = new Set<string>();
  readonly #sessionMountReferences = new Map<string, number>();
  readonly #sessionReleaseTimers = new Map<string, number>();
  #frameSubscriptionVersion = 1;
  #frameSubscriptionQueuedVersion = 0;
  #frameSubscriptionRequestId = 1;
  #frameSubscriptionReady = Promise.resolve();
  readonly #frameSubscriptionRequests = new Map<
    number,
    { resolve: () => void; reject: (error: Error) => void; timer: number }
  >();
  #frameBridgeCapabilityProbeRequestId: number | undefined;
  #frameSubscriptionAcksSupported = false;
  #frameFlowControlEnabled = false;
  readonly #mountedCanvases = new WeakMap<HTMLCanvasElement, MountedCanvas>();
  readonly #mountedEntries = new Set<MountedCanvas>();
  readonly #mountGenerationBySurface = new Map<string, number>();
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
    this.#frameSubscriptionGraceMs = Math.max(
      0,
      options.frameSubscriptionGraceMs ?? DEFAULT_FRAME_SUBSCRIPTION_GRACE_MS,
    );
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
      } else if (data.type === "catalog-pressure") {
        console.warn(
          `[terminal-runtime] native text catalog budget exceeded for ${data.sessionHandle}; using bounded fallback text`,
        );
        this.dispatchEvent(new CustomEvent("catalog-pressure", { detail: data }));
      } else if (data.type === "frame-credit" && this.#frameFlowControlEnabled) {
        this.#frames?.postMessage({ type: "frame-credit", bytes: data.bytes });
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
    this.#control.addEventListener("session-activity-changed", (event) => {
      const detail = (event as CustomEvent<Extract<ServerEvent, { type: "session-activity-changed" }>>).detail;
      const handle = this.#handleBySessionId.get(detail.sessionId);
      const session = handle ? this.#sessionByHandle.get(handle) : undefined;
      if (!handle || !session || session.exited) return;
      const updated = { ...session, activity: detail.activity };
      this.#sessionByHandle.set(handle, updated);
      this.dispatchEvent(new CustomEvent("session-activity", { detail }));
      this.dispatchEvent(new CustomEvent("session-metadata", { detail: updated }));
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
    this.#frames.onmessage = ({ data }: MessageEvent<FrameChannelMessage>) => {
      if (!(data instanceof ArrayBuffer)) {
        this.#handleFrameChannelControl(data);
        return;
      }
      if (data.byteLength < 4) return;
      const view = new DataView(data);
      if (view.getUint32(0, true) !== FRAME_MAGIC) {
        try {
          this.#handleFrameChannelControl(JSON.parse(new TextDecoder().decode(data)) as unknown);
        } catch {
          console.warn("[terminal-runtime] frame channel received an invalid control packet");
        }
        return;
      }
      if (data.byteLength < 16) {
        this.#returnFrameCredit(data.byteLength);
        return;
      }
      const sessionHandle = view.getBigUint64(8, true).toString();
      // A frame can already be queued in the bridge when its session is
      // terminated. Do not recreate worker state for a session we deliberately
      // dropped, and do not render sessions owned only by automation clients.
      if (!this.#sessionByHandle.has(sessionHandle) || !this.#subscribedSessionHandles.has(sessionHandle)) {
        this.#returnFrameCredit(data.byteLength);
        return;
      }
      const tracking = (view.getUint16(6, true) & FrameFlag.MouseTracking) !== 0;
      if (this.#mouseTrackingByHandle.get(sessionHandle) !== tracking) {
        this.#mouseTrackingByHandle.set(sessionHandle, tracking);
        this.dispatchEvent(new CustomEvent("terminal-modes", { detail: { sessionHandle, mouseTracking: tracking } }));
      }
      this.#scheduleMetadataRefresh(sessionHandle);
      this.#postWorker({ type: "frame", packet: data }, [data]);
    };
    this.#frames.start();
    const hello = await this.#control.request({
      type: "hello",
      protocolMajor: PROTOCOL_MAJOR,
      protocolMinor: PROTOCOL_MINOR,
      clientBuild: this.#clientBuild,
    });
    if (hello.type !== "hello" || hello.protocolMajor !== PROTOCOL_MAJOR)
      throw new Error("terminald protocol mismatch");
    this.#frameSubscriptionAcksSupported = hello.protocolMinor >= FRAME_SUBSCRIPTION_ACK_PROTOCOL_MINOR;
    await this.#queueFrameSubscriptionSync();
    console.info("[terminal-runtime] authenticated terminald protocol");
  }

  #handleFrameChannelControl(message: unknown): boolean {
    if (!message || typeof message !== "object") return false;
    const data = message as {
      type?: unknown;
      requestId?: unknown;
      protocolVersion?: unknown;
      frameCredits?: unknown;
      sessionHandles?: unknown;
    };
    if (data.type === "subscription-ack" && Number.isSafeInteger(data.requestId) && Number(data.requestId) >= 0) {
      const pending = this.#frameSubscriptionRequests.get(Number(data.requestId));
      if (!pending) return true;
      window.clearTimeout(pending.timer);
      this.#frameSubscriptionRequests.delete(Number(data.requestId));
      pending.resolve();
      return true;
    }
    if (
      data.type === "bridge-capabilities" &&
      data.requestId === this.#frameBridgeCapabilityProbeRequestId &&
      data.protocolVersion === FRAME_BRIDGE_CAPABILITY_VERSION &&
      data.frameCredits === true
    ) {
      this.#frameFlowControlEnabled = true;
      return true;
    }
    if (data.type !== "frame-gap") return false;
    const reportedHandles = Array.isArray(data.sessionHandles)
      ? data.sessionHandles.filter(
          (handle): handle is string =>
            typeof handle === "string" &&
            this.#subscribedSessionHandles.has(handle) &&
            this.#sessionByHandle.has(handle),
        )
      : [...this.#subscribedSessionHandles].filter((handle) => this.#sessionByHandle.has(handle));
    const sessionHandles = [...new Set(reportedHandles)];
    sessionHandles.sort(
      (left, right) =>
        Number((this.#sessionMountReferences.get(right) ?? 0) > 0) -
        Number((this.#sessionMountReferences.get(left) ?? 0) > 0),
    );
    if (sessionHandles.length > 0) this.#postWorker({ type: "frame-gap", sessionHandles });
    return true;
  }

  #returnFrameCredit(bytes: number): void {
    if (this.#frameFlowControlEnabled) this.#frames?.postMessage({ type: "frame-credit", bytes });
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
            previous.exited !== response.session.exited ||
            !sameSessionActivity(previous.activity, response.session.activity)
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
  }

  #queueFrameSubscriptionSync(): Promise<void> {
    const frames = this.#frames;
    if (!frames) return Promise.resolve();
    if (this.#frameSubscriptionQueuedVersion >= this.#frameSubscriptionVersion) {
      return this.#frameSubscriptionReady;
    }
    const queuedVersion = this.#frameSubscriptionVersion;
    this.#frameSubscriptionQueuedVersion = queuedVersion;
    const requestId = this.#frameSubscriptionRequestId++;
    const sessionHandles = [...this.#subscribedSessionHandles];
    const probesBridge = this.#frameBridgeCapabilityProbeRequestId === undefined;
    if (probesBridge) this.#frameBridgeCapabilityProbeRequestId = requestId;
    const subscription = {
      type: "subscribe",
      requestId,
      sessionHandles,
      ...(probesBridge ? { bridgeCapabilities: FRAME_BRIDGE_CAPABILITY_VERSION } : {}),
      ...(this.#frameFlowControlEnabled ? { frameCredits: true } : {}),
    };
    const previous = this.#frameSubscriptionReady;
    const operation = previous
      .catch(() => undefined)
      .then(() => this.#sendFrameSubscription(frames, subscription, probesBridge));
    this.#frameSubscriptionReady = operation;
    void operation.catch(() => {
      if (this.#frameSubscriptionReady === operation) {
        this.#frameSubscriptionQueuedVersion = Math.min(this.#frameSubscriptionQueuedVersion, queuedVersion - 1);
      }
    });
    return operation;
  }

  #sendFrameSubscription(
    frames: MessagePort,
    subscription: {
      type: string;
      requestId: number;
      sessionHandles: string[];
      bridgeCapabilities?: number;
      frameCredits?: boolean;
    },
    probesBridge: boolean,
  ): Promise<void> {
    if (!this.#frameSubscriptionAcksSupported) {
      try {
        frames.postMessage(subscription);
        return Promise.resolve();
      } catch (error) {
        if (probesBridge && !this.#frameFlowControlEnabled) this.#frameBridgeCapabilityProbeRequestId = undefined;
        return Promise.reject(error);
      }
    }
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        if (!this.#frameSubscriptionRequests.delete(subscription.requestId)) return;
        reject(new Error(`Frame subscription ${subscription.requestId} was not acknowledged`));
      }, FRAME_SUBSCRIPTION_ACK_TIMEOUT_MS);
      this.#frameSubscriptionRequests.set(subscription.requestId, { resolve, reject, timer });
      try {
        frames.postMessage(subscription);
      } catch (error) {
        window.clearTimeout(timer);
        this.#frameSubscriptionRequests.delete(subscription.requestId);
        if (probesBridge && !this.#frameFlowControlEnabled) this.#frameBridgeCapabilityProbeRequestId = undefined;
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  #syncFrameSubscriptionsInBackground(): void {
    void this.connect()
      .then(() => this.#queueFrameSubscriptionSync())
      .catch((error) => {
        if (this.#disposed) return;
        console.error("[terminal-runtime] failed to update frame subscriptions", error);
        this.dispatchEvent(new CustomEvent("frame-subscription-error", { detail: { error } }));
      });
  }

  #retainFrameSubscription(sessionHandle: string): { ready: Promise<void>; added: boolean } {
    const releaseTimer = this.#sessionReleaseTimers.get(sessionHandle);
    if (releaseTimer !== undefined) {
      window.clearTimeout(releaseTimer);
      this.#sessionReleaseTimers.delete(sessionHandle);
    }
    this.#sessionMountReferences.set(sessionHandle, (this.#sessionMountReferences.get(sessionHandle) ?? 0) + 1);
    const added = !this.#subscribedSessionHandles.has(sessionHandle);
    if (added) {
      this.#subscribedSessionHandles.add(sessionHandle);
      this.#frameSubscriptionVersion += 1;
    }
    return {
      added,
      ready: this.connect().then(() => this.#queueFrameSubscriptionSync()),
    };
  }

  #expectFullSnapshot(sessionHandle: string): void {
    if (
      this.#disposed ||
      !this.#subscribedSessionHandles.has(sessionHandle) ||
      !this.#sessionByHandle.has(sessionHandle)
    )
      return;
    this.#postWorker({ type: "expect-full", sessionHandle });
    this.#resync.request(sessionHandle);
  }

  #scheduleFrameSubscriptionRelease(sessionHandle: string): void {
    if (
      (this.#sessionMountReferences.get(sessionHandle) ?? 0) > 0 ||
      this.#pinnedSessionHandles.has(sessionHandle) ||
      !this.#subscribedSessionHandles.has(sessionHandle) ||
      this.#sessionReleaseTimers.has(sessionHandle)
    )
      return;
    const timer = window.setTimeout(() => {
      this.#sessionReleaseTimers.delete(sessionHandle);
      if ((this.#sessionMountReferences.get(sessionHandle) ?? 0) > 0 || this.#pinnedSessionHandles.has(sessionHandle))
        return;
      if (this.#subscribedSessionHandles.delete(sessionHandle)) {
        this.#frameSubscriptionVersion += 1;
        this.#syncFrameSubscriptionsInBackground();
      }
      this.#resync.cancel(sessionHandle);
      this.#postWorker({ type: "drop-session", sessionHandle });
    }, this.#frameSubscriptionGraceMs);
    this.#sessionReleaseTimers.set(sessionHandle, timer);
  }

  #releaseFrameSubscription(sessionHandle: string): void {
    const references = Math.max(0, (this.#sessionMountReferences.get(sessionHandle) ?? 0) - 1);
    if (references === 0) this.#sessionMountReferences.delete(sessionHandle);
    else this.#sessionMountReferences.set(sessionHandle, references);
    this.#scheduleFrameSubscriptionRelease(sessionHandle);
  }

  setSessionPinned(sessionHandle: string, pinned: boolean): void {
    if (pinned) {
      if (!this.#sessionByHandle.has(sessionHandle)) {
        throw new Error(`Cannot pin unknown terminal session ${sessionHandle}`);
      }
      if (this.#pinnedSessionHandles.has(sessionHandle)) return;
      this.#pinnedSessionHandles.add(sessionHandle);
      const releaseTimer = this.#sessionReleaseTimers.get(sessionHandle);
      if (releaseTimer !== undefined) {
        window.clearTimeout(releaseTimer);
        this.#sessionReleaseTimers.delete(sessionHandle);
      }
      if (!this.#subscribedSessionHandles.has(sessionHandle)) {
        this.#subscribedSessionHandles.add(sessionHandle);
        this.#frameSubscriptionVersion += 1;
        void this.connect()
          .then(() => this.#queueFrameSubscriptionSync())
          .then(() => this.#expectFullSnapshot(sessionHandle))
          .catch((error) => {
            if (!this.#disposed)
              console.error(`[terminal-runtime] failed to pin frame subscription ${sessionHandle}`, error);
          });
      }
    } else {
      if (!this.#pinnedSessionHandles.delete(sessionHandle)) return;
      this.#scheduleFrameSubscriptionRelease(sessionHandle);
    }
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
      if (!mounted.active) throw new Error("A released terminal canvas cannot be remounted");
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
    const subscription = this.#retainFrameSubscription(sessionHandle);
    const generation = (this.#mountGenerationBySurface.get(viewId) ?? 0) + 1;
    this.#mountGenerationBySurface.set(viewId, generation);
    this.#postWorker({ type: "mount", surfaceId: viewId, sessionHandle, canvas: offscreen }, [offscreen]);
    const entry: MountedCanvas = {
      canvas,
      sessionHandle,
      sessionId,
      viewId,
      generation,
      references: 1,
      disposeTimer: undefined,
      active: true,
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
    void subscription.ready
      .then(() => {
        const current = this.#views.get(viewId);
        if (current !== view || !entry.active) return undefined;
        if (subscription.added) this.#expectFullSnapshot(sessionHandle);
        return this.#control?.request({ type: "attach-session", sessionId, viewId }, 60_000);
      })
      .then((response) => {
        if (!response) return;
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
        this.#postWorker({ type: "resize", surfaceId: mounted.viewId, width, height, dpr }),
      dispose: () => {
        if (disposed) return;
        disposed = true;
        if (!mounted.active) return;
        mounted.references -= 1;
        if (mounted.references !== 0) return;
        mounted.disposeTimer = window.setTimeout(() => {
          mounted.disposeTimer = undefined;
          if (mounted.references !== 0 || !mounted.active) return;
          mounted.active = false;
          const ownsWorkerSurface = this.#mountGenerationBySurface.get(mounted.viewId) === mounted.generation;
          if (ownsWorkerSurface) {
            this.#postWorker({ type: "unmount", surfaceId: mounted.viewId });
            this.#mountGenerationBySurface.delete(mounted.viewId);
            this.#control?.notify({ type: "detach-session", sessionId: mounted.sessionId, viewId: mounted.viewId });
            this.#views.delete(mounted.viewId);
            this.#focusByView.delete(mounted.viewId);
          }
          this.#mountedCanvases.delete(mounted.canvas);
          this.#mountedEntries.delete(mounted);
          this.#releaseFrameSubscription(mounted.sessionHandle);
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

  setTheme(sessionHandle: string, theme: TerminalTheme, surfaceId?: string): void {
    this.#postWorker({ type: "theme", sessionHandle, ...(surfaceId ? { surfaceId } : {}), theme });
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

  setSelection(sessionHandle: string, selection: CellSelection | null, surfaceId?: string): void {
    this.#postWorker({ type: "selection", sessionHandle, ...(surfaceId ? { surfaceId } : {}), selection });
  }

  setVisible(sessionHandle: string, visible: boolean, surfaceId?: string): void {
    this.#postWorker({ type: "visibility", sessionHandle, ...(surfaceId ? { surfaceId } : {}), visible });
  }

  forceFullRedraw(sessionHandle: string): void {
    this.#postWorker({ type: "force-full-redraw", sessionHandle });
  }

  forceRowRedraw(sessionHandle: string, row: number): void {
    this.#postWorker({ type: "force-row-redraw", sessionHandle, row });
  }

  setPartialRenderingEnabled(enabled: boolean): void {
    this.#postWorker({ type: "partial-rendering", enabled });
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
    this.#postWorker({ type: "focus", surfaceId: viewId, sessionHandle, focused });
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

  #removeRegisteredSession(sessionId: string, detachViews: boolean): void {
    const handle = this.#handleBySessionId.get(sessionId);
    if (!handle) return;
    const releaseTimer = this.#sessionReleaseTimers.get(handle);
    if (releaseTimer !== undefined) window.clearTimeout(releaseTimer);
    this.#sessionReleaseTimers.delete(handle);
    this.#pinnedSessionHandles.delete(handle);
    this.#sessionMountReferences.delete(handle);
    const subscriptionChanged = this.#subscribedSessionHandles.delete(handle);
    this.#cancelMetadataRefresh(handle);
    this.#mouseTrackingByHandle.delete(handle);
    this.#scrollbarByHandle.delete(handle);
    for (const mounted of [...this.#mountedEntries]) {
      if (mounted.sessionHandle !== handle) continue;
      mounted.active = false;
      if (mounted.disposeTimer !== undefined) window.clearTimeout(mounted.disposeTimer);
      mounted.disposeTimer = undefined;
      const ownsWorkerSurface = this.#mountGenerationBySurface.get(mounted.viewId) === mounted.generation;
      if (ownsWorkerSurface) {
        this.#postWorker({ type: "unmount", surfaceId: mounted.viewId });
        this.#mountGenerationBySurface.delete(mounted.viewId);
        if (detachViews)
          this.#control?.notify({ type: "detach-session", sessionId: mounted.sessionId, viewId: mounted.viewId });
        this.#views.delete(mounted.viewId);
        this.#focusByView.delete(mounted.viewId);
      }
      this.#mountedCanvases.delete(mounted.canvas);
      this.#mountedEntries.delete(mounted);
    }
    for (const [viewId, view] of this.#views) {
      if (view.sessionId === sessionId) {
        view.pendingInput.length = 0;
        if (detachViews) this.#control?.notify({ type: "detach-session", sessionId, viewId });
        this.#views.delete(viewId);
        this.#focusByView.delete(viewId);
      }
    }
    this.#sessionByHandle.delete(handle);
    this.#handleBySessionId.delete(sessionId);
    if (subscriptionChanged) {
      this.#frameSubscriptionVersion += 1;
      this.#syncFrameSubscriptionsInBackground();
    }
    this.#resync.cancel(handle);
    this.#postWorker({ type: "drop-session", sessionHandle: handle });
  }

  unregisterSession(sessionId: string): void {
    this.#removeRegisteredSession(sessionId, true);
  }

  terminate(sessionId: string, source: TerminationSource = "user"): void {
    this.#control?.notify({ type: "terminate", sessionId, source });
    this.#removeRegisteredSession(sessionId, false);
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
      mounted.active = false;
      this.#mountedCanvases.delete(mounted.canvas);
    }
    this.#mountedEntries.clear();
    for (const timer of this.#sessionReleaseTimers.values()) window.clearTimeout(timer);
    this.#sessionReleaseTimers.clear();
    for (const pending of this.#frameSubscriptionRequests.values()) {
      window.clearTimeout(pending.timer);
      pending.reject(new Error("Terminal runtime was disposed during a frame subscription"));
    }
    this.#frameSubscriptionRequests.clear();
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
    this.#mountGenerationBySurface.clear();
    this.#mouseTrackingByHandle.clear();
    this.#scrollbarByHandle.clear();
    this.#subscribedSessionHandles.clear();
    this.#pinnedSessionHandles.clear();
    this.#sessionMountReferences.clear();
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
