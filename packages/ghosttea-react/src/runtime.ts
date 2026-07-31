import { ControlClient } from "@vibecook/ghosttea";
import {
  PROTOCOL_MAJOR,
  PROTOCOL_MINOR,
  type ConfigSnapshot,
  type CreateSessionOptions,
  type RemoteControllerInfo,
  type RemoteHostSummary,
  type RemoteSessionLifecycle,
  type RemoteViewRecord,
  type SelectionScopeKind,
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
import type { CellSelection, TerminalEffects, TerminalTheme } from "./renderers/types.js";
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
  attachmentEpoch?: number | undefined;
  readWrite?: boolean;
  inputSequence: number;
  resizeSequence: number;
  controlEpoch: number | undefined;
  desiredCols: number | undefined;
  desiredRows: number | undefined;
  pendingInput: Array<(attachmentEpoch: number, inputSequence: number) => void>;
  /** Highest per-view sequence applied, from any of the three update paths. */
  lastViewStateSeq: number | undefined;
  /**
   * Survives the epoch being cleared so a frozen replica stays copyable: the
   * daemon authorizes offline selection from its ownership record, not from a
   * live attachment.
   */
  lastAttachmentEpoch: number | undefined;
  /** Attachment epoch this view has already claimed control for, if any. */
  claimedEpoch: number | undefined;
  /** Control revision that claim was made against, for the cleared-controller retry. */
  claimedRevision: number;
}

/** A session's lifecycle as this client currently believes it. */
export type RemoteSessionRuntimeState = RemoteSessionLifecycle & {
  sessionId: string;
  /** Monotonic clock reading when this state was observed, for honest elapsed timing. */
  observedAt: number;
  /**
   * Live again, but still showing the screen from before the outage. The
   * replica is not trustworthy until a frame from the recovered stream has
   * actually been committed, so the pane stays cooled until then.
   */
  awaitingRecoveryFrame: boolean;
};

/** States that leave a screen on display which the host is no longer updating. */
export function showsStaleScreen(state: RemoteSessionLifecycle["state"]): boolean {
  return state !== "live" && state !== "opening";
}

/** Whether a pane is showing stale content: frozen outright, or live but not yet redrawn. */
export function sessionIsFrozen(state: RemoteSessionRuntimeState): boolean {
  return showsStaleScreen(state.state) || state.awaitingRecoveryFrame;
}

export interface SelectionScope {
  sessionId: string;
  viewId: string;
  scope: SelectionScopeKind;
}

export interface RemoteInputSuppression {
  sessionId: string;
  viewId: string;
  state: RemoteSessionRuntimeState["state"];
}

/** A per-view update from an event, a reconciliation, or an attach response. */
type RemoteViewStateUpdate = Omit<RemoteViewRecord, "viewId" | "viewStateSeq"> & { viewStateSeq?: number };

type FrameChannelMessage =
  | ArrayBuffer
  | { type: "subscription-ack"; requestId: number }
  | { type: "frame-gap"; skipped: number; sessionHandles?: string[]; historyComplete?: boolean }
  | { type: "bridge-capabilities"; requestId: number; protocolVersion: number; frameCredits: boolean };

const FRAME_SUBSCRIPTION_ACK_TIMEOUT_MS = 10_000;
const FRAME_SUBSCRIPTION_ACK_PROTOCOL_MINOR = 7;
const FRAME_BRIDGE_CAPABILITY_VERSION = 1;
const CONFIG_PROTOCOL_MINOR = 10;
const REMOTE_LIFECYCLE_PROTOCOL_MINOR = 12;
const DEFAULT_FRAME_SUBSCRIPTION_GRACE_MS = 1_000;
/** A one-shot resume covers a 20 s dial plus the attach handshake. */
const RECONNECT_REQUEST_TIMEOUT_MS = 60_000;

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
  readonly #remoteSessions = new Map<string, RemoteSessionRuntimeState>();
  readonly #controlBySession = new Map<string, { controller: RemoteControllerInfo | null; revision: number }>();
  #remoteLifecycleSupported = false;
  #rendererBackend = "starting";
  #configSnapshot: ConfigSnapshot | undefined;
  #configProtocolSupported = false;
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
      } else if (data.type === "frame-committed") {
        this.#thawRecoveredSession(data.sessionHandle);
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
    this.#control.addEventListener("events-lost", () => {
      // The daemon dropped events faster than this client drained them. Any
      // of them could have been a session-exited, so reconcile against the
      // daemon's authoritative session list.
      void this.#resyncAfterLostEvents();
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
      this.#applyController(
        detail.sessionId,
        { viewId: detail.controllerViewId, controlEpoch: detail.controlEpoch },
        detail.cols,
        detail.rows,
      );
    });
    this.#control.addEventListener("control-state", (event) => {
      const detail = (event as CustomEvent<Extract<ServerEvent, { type: "control-state" }>>).detail;
      this.#applyController(detail.sessionId, detail.controller, detail.cols, detail.rows, detail.controlRevision);
    });
    this.#control.addEventListener("remote-session-state-changed", (event) => {
      const detail = (event as CustomEvent<Extract<ServerEvent, { type: "remote-session-state-changed" }>>).detail;
      this.#applyRemoteSessionState(detail.sessionId, detail, false);
    });
    this.#control.addEventListener("view-state-changed", (event) => {
      const detail = (event as CustomEvent<Extract<ServerEvent, { type: "view-state-changed" }>>).detail;
      this.#applyViewState(detail.viewId, detail);
    });
    this.#control.addEventListener("config-changed", (event) => {
      const detail = (event as CustomEvent<Extract<ServerEvent, { type: "config-changed" }>>).detail;
      this.#installConfig(detail.config);
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
      throw new Error("ghosttead protocol mismatch");
    this.#frameSubscriptionAcksSupported = hello.protocolMinor >= FRAME_SUBSCRIPTION_ACK_PROTOCOL_MINOR;
    this.#configProtocolSupported = hello.protocolMinor >= CONFIG_PROTOCOL_MINOR;
    this.#remoteLifecycleSupported = hello.protocolMinor >= REMOTE_LIFECYCLE_PROTOCOL_MINOR;
    if (this.#configProtocolSupported && hello.configRevision !== undefined) {
      await this.#refreshConfig();
    }
    await this.#queueFrameSubscriptionSync();
    console.info("[terminal-runtime] authenticated ghosttead protocol");
  }

  get configSnapshot(): ConfigSnapshot | undefined {
    return this.#configSnapshot;
  }

  async getConfig(): Promise<ConfigSnapshot | undefined> {
    await this.connect();
    return this.#configSnapshot;
  }

  async reloadConfig(): Promise<ConfigSnapshot> {
    await this.connect();
    const response = await this.#control!.request({ type: "reload-config" });
    if (response.type !== "config") throw new Error("ghosttead returned an unexpected configuration response");
    this.#installConfig(response.config);
    return response.config;
  }

  #installConfig(config: ConfigSnapshot): void {
    if (this.#configSnapshot?.revision === config.revision) return;
    this.#configSnapshot = config;
    this.dispatchEvent(new CustomEvent("config-changed", { detail: config }));
  }

  async #refreshConfig(): Promise<void> {
    if (!this.#configProtocolSupported || !this.#control) return;
    const response = await this.#control.request({ type: "get-config" });
    if (response.type !== "config") throw new Error("ghosttead returned an unexpected configuration response");
    this.#installConfig(response.config);
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
    if (response.type !== "session-created") throw new Error("ghosttead returned an unexpected response");
    this.registerSession(response.session);
    console.info(`[terminal-runtime] created session ${response.session.id}`);
    return response.session;
  }

  async listSessions(): Promise<SessionSummary[]> {
    await this.connect();
    const response = await this.#control!.request({ type: "list-sessions" });
    if (response.type !== "sessions") throw new Error("ghosttead returned an unexpected response");
    for (const session of response.sessions) {
      this.registerSession(session);
    }
    return response.sessions;
  }

  /**
   * Reconcile tracked sessions against the daemon's authoritative list after
   * an events-lost notice. A session still listed but now exited had its exit
   * event lost; a session absent from the list entirely exited and left the
   * registry, so its exit details are gone and are reported as unknown.
   */
  async #resyncAfterLostEvents(): Promise<void> {
    try {
      const before = new Map<string, SessionSummary>();
      for (const session of this.#sessionByHandle.values()) {
        before.set(session.id, session);
      }
      const [sessions] = await Promise.all([
        this.listSessions(),
        this.#refreshConfig(),
        this.#reconcileRemoteSessions(),
      ]);
      const known = new Set<string>();
      for (const session of sessions) {
        known.add(session.id);
        const previous = before.get(session.id);
        if (!previous || previous.exited || !session.exited) continue;
        this.#cancelMetadataRefresh(session.handle);
        this.dispatchEvent(new CustomEvent("session-metadata", { detail: session }));
        this.dispatchEvent(
          new CustomEvent("session-exited", {
            detail: {
              requestId: 0,
              type: "session-exited",
              sessionId: session.id,
              exitCode: session.exitCode,
              exitSignal: session.exitSignal,
              requestedTermination: session.requestedTermination,
              exitOutcome: session.exitOutcome ?? "unknown",
            } satisfies Extract<ServerEvent, { type: "session-exited" }>,
          }),
        );
      }
      for (const [handle, session] of this.#sessionByHandle) {
        if (session.exited || known.has(session.id)) continue;
        const detail = {
          requestId: 0,
          type: "session-exited",
          sessionId: session.id,
          exitCode: null,
          exitSignal: null,
          requestedTermination: null,
          exitOutcome: "unknown",
        } satisfies Extract<ServerEvent, { type: "session-exited" }>;
        this.#cancelMetadataRefresh(handle);
        const exited = {
          ...session,
          exited: true,
          exitCode: null,
          exitSignal: null,
          requestedTermination: null,
          exitOutcome: "unknown" as const,
        };
        this.#sessionByHandle.set(handle, exited);
        this.dispatchEvent(new CustomEvent("session-metadata", { detail: exited }));
        this.dispatchEvent(new CustomEvent("session-exited", { detail }));
      }
    } catch (error) {
      if (!this.#disposed) console.error("[terminal-runtime] failed to resynchronize state after lost events", error);
    }
  }

  async listRemoteHosts(): Promise<RemoteHostSummary[]> {
    await this.connect();
    const response = await this.#control!.request({ type: "list-remote-hosts" });
    if (response.type !== "remote-hosts") throw new Error("ghosttead returned an unexpected response");
    return response.hosts;
  }

  async listRemoteSessions(deviceId: string): Promise<SharedSessionSummary[]> {
    await this.connect();
    const response = await this.#control!.request({ type: "list-remote-sessions", deviceId }, 35_000);
    if (response.type !== "remote-sessions" || response.deviceId !== deviceId)
      throw new Error("ghosttead returned an unexpected response");
    return response.sessions;
  }

  async openRemoteSession(
    deviceId: string,
    remoteSessionId: string,
    cols: number,
    rows: number,
    deviceName = deviceId,
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
    if (response.type !== "session-created") throw new Error("ghosttead could not open the remote session");
    this.registerSession(response.session);
    // The session counts as remote from here, before any daemon event, so its
    // input is never queued. A daemon on this minor reports `opening` until
    // the first snapshot lands, so start there and let its events take over;
    // an older daemon reports nothing at all, and seeding `opening` against it
    // would block input forever. The sequence below is under every real event.
    this.#remoteSessions.set(response.session.id, {
      sessionId: response.session.id,
      state: this.#remoteLifecycleSupported ? "opening" : "live",
      reason: null,
      exit: null,
      lifecycleSeq: -1,
      deviceId,
      deviceName,
      attempt: null,
      nextRetryMs: null,
      lastContactMs: null,
      observedAt: performance.now(),
      awaitingRecoveryFrame: false,
    });
    return response.session;
  }

  async #refreshSession(sessionHandle: string): Promise<void> {
    const session = this.#sessionByHandle.get(sessionHandle);
    if (!session) return;
    if (!this.#control) throw new Error(`Session ${sessionHandle} is not ready for frame resynchronization`);
    const response = await this.#control.request({ type: "refresh-session", sessionId: session.id });
    if (response.type !== "ok") throw new Error("ghosttead rejected frame resynchronization");
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
      lastViewStateSeq: undefined,
      lastAttachmentEpoch: undefined,
      claimedEpoch: undefined,
      claimedRevision: 0,
    };
    this.#views.set(viewId, view);
    const remote = this.#remoteSessions.get(sessionId);
    if (remote && remote.state !== "live") this.#setCursorFrozen(sessionId, true);
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
          throw new Error("ghosttead returned an invalid view attachment");
        }
        const current = this.#views.get(viewId);
        if (current !== view) return;
        const applied = this.#applyViewState(viewId, {
          ...(response.viewStateSeq !== undefined ? { viewStateSeq: response.viewStateSeq } : {}),
          viewState: "attached",
          attachmentEpoch: response.attachmentEpoch,
          readWrite: response.readWrite,
          error: null,
          retryable: null,
        });
        if (!applied) return;
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

  get remoteLifecycleSupported(): boolean {
    return this.#remoteLifecycleSupported;
  }

  /** Last known lifecycle of a remote session; undefined for local sessions. */
  remoteSession(sessionId: string): RemoteSessionRuntimeState | undefined {
    return this.#remoteSessions.get(sessionId);
  }

  #applyController(
    sessionId: string,
    controller: RemoteControllerInfo | null,
    cols: number,
    rows: number,
    revision = 0,
  ): void {
    const previous = this.#controlBySession.get(sessionId);
    this.#controlBySession.set(sessionId, {
      controller,
      // A legacy `control-changed` carries no revision; keep the last one so a
      // downgrade never looks like the controller was cleared at a newer one.
      revision: Math.max(revision, previous?.revision ?? 0),
    });
    for (const [viewId, view] of this.#views) {
      if (view.sessionId !== sessionId) continue;
      if (!controller || controller.viewId !== viewId) {
        view.controlEpoch = undefined;
        continue;
      }
      view.controlEpoch = controller.controlEpoch;
      if (
        view.desiredCols !== undefined &&
        view.desiredRows !== undefined &&
        (view.desiredCols !== cols || view.desiredRows !== rows)
      ) {
        this.#sendResize(viewId, view, view.desiredCols, view.desiredRows);
      }
    }
    // A cleared controller is the one case worth re-evaluating: the pane that
    // still holds focus may now take control back.
    for (const viewId of this.#viewIdsForSession(sessionId)) this.#maybeReclaim(viewId);
  }

  *#viewIdsForSession(sessionId: string): Generator<string> {
    for (const [viewId, view] of this.#views) {
      if (view.sessionId === sessionId) yield viewId;
    }
  }

  /**
   * The single funnel for taking resize control (§4.2.3). Every condition that
   * gates a claim re-enters here when it changes, because no one event is
   * enough: recovery marks a view attached before its session reaches live, and
   * the focus setter suppresses repeat `true` updates, so a claim keyed on
   * either alone would be skipped and never retried.
   *
   * At most one claim per attachment epoch, plus one more each time the
   * controller is cleared at a newer revision.
   */
  #maybeReclaim(viewId: string): void {
    const view = this.#views.get(viewId);
    if (!view || view.readWrite === false) return;
    const attachmentEpoch = view.attachmentEpoch;
    if (attachmentEpoch === undefined) return;
    if (view.desiredCols === undefined || view.desiredRows === undefined) return;
    if (this.#focusByView.get(viewId) !== true) return;
    const remote = this.#remoteSessions.get(view.sessionId);
    if (remote && (remote.state !== "live" || remote.awaitingRecoveryFrame)) return;
    const control = this.#controlBySession.get(view.sessionId);
    const controller = control?.controller ?? null;
    // Never take control from another pane. Our own name on the record is not
    // a reason to stop: after a resume it is the previous incarnation's, and
    // the new attachment epoch below is what decides.
    if (controller && controller.viewId !== viewId) return;
    const revision = control?.revision ?? 0;
    // One claim per attachment epoch. A controller *cleared* at a newer
    // revision earns one more; the seat being confirmed as ours does not.
    if (view.claimedEpoch === attachmentEpoch && (controller !== null || view.claimedRevision >= revision)) return;
    const session = this.#sessionByHandle.get(view.sessionHandle);
    if (!session) return;
    view.claimedEpoch = attachmentEpoch;
    view.claimedRevision = revision;
    this.#control?.notify({
      type: "focus-and-resize",
      sessionId: session.id,
      viewId,
      attachmentEpoch,
      cols: view.desiredCols,
      rows: view.desiredRows,
    });
  }

  /**
   * The only path that mutates per-view attachment state, whether the update
   * arrived as an event, a reconciliation, or an attach response. A sequence
   * at or below the last applied one is a delayed transition from an abandoned
   * attempt and is dropped; an update without a sequence comes from a daemon
   * older than the fence and applies directly.
   */
  #applyViewState(viewId: string, update: RemoteViewStateUpdate): boolean {
    const view = this.#views.get(viewId);
    if (!view) return false;
    if (update.viewStateSeq !== undefined) {
      if (view.lastViewStateSeq !== undefined && update.viewStateSeq <= view.lastViewStateSeq) return false;
      view.lastViewStateSeq = update.viewStateSeq;
    }
    const remote = this.#remoteSessions.has(view.sessionId);
    if (update.viewState === "attached" && update.attachmentEpoch !== null) {
      // Nothing typed against the previous incarnation may ride out on a
      // freshly armed epoch.
      if (remote) view.pendingInput.length = 0;
      view.attachmentEpoch = update.attachmentEpoch;
      view.lastAttachmentEpoch = update.attachmentEpoch;
      if (update.readWrite !== null) view.readWrite = update.readWrite;
      this.#maybeReclaim(viewId);
      return true;
    }
    view.pendingInput.length = 0;
    view.attachmentEpoch = undefined;
    return true;
  }

  #applyRemoteSessionState(sessionId: string, lifecycle: RemoteSessionLifecycle, authoritative: boolean): boolean {
    const previous = this.#remoteSessions.get(sessionId);
    if (previous) {
      // A reconciliation is the source of truth and may restate its sequence;
      // a pushed event at a sequence already seen is stale.
      const stale = authoritative
        ? lifecycle.lifecycleSeq < previous.lifecycleSeq
        : lifecycle.lifecycleSeq <= previous.lifecycleSeq;
      if (stale) return false;
    }
    // Coming back from a frozen state, the screen on display is still the one
    // from before the outage. Keep it marked stale until the recovered stream
    // actually commits a frame; `opening` never had a screen to distrust.
    const awaitingRecoveryFrame =
      lifecycle.state === "live" &&
      previous !== undefined &&
      (previous.awaitingRecoveryFrame || showsStaleScreen(previous.state));
    const state: RemoteSessionRuntimeState = {
      ...lifecycle,
      sessionId,
      observedAt: performance.now(),
      awaitingRecoveryFrame,
    };
    this.#remoteSessions.set(sessionId, state);
    if (state.state !== "live") {
      for (const view of this.#views.values()) {
        if (view.sessionId === sessionId) view.pendingInput.length = 0;
      }
    }
    this.#setCursorFrozen(sessionId, sessionIsFrozen(state));
    this.dispatchEvent(new CustomEvent("remote-session-state", { detail: state }));
    for (const viewId of this.#viewIdsForSession(sessionId)) this.#maybeReclaim(viewId);
    return true;
  }

  /**
   * A frame from the recovered stream has been committed, so what the pane
   * shows is current again. The first commit after the session went live is by
   * construction the recovery snapshot or later, since the daemon reaches live
   * only once that snapshot has been ingested.
   */
  #thawRecoveredSession(sessionHandle: string): void {
    const sessionId = this.#sessionByHandle.get(sessionHandle)?.id;
    const state = sessionId === undefined ? undefined : this.#remoteSessions.get(sessionId);
    if (!state || !state.awaitingRecoveryFrame) return;
    const thawed: RemoteSessionRuntimeState = { ...state, awaitingRecoveryFrame: false };
    this.#remoteSessions.set(thawed.sessionId, thawed);
    this.#setCursorFrozen(thawed.sessionId, sessionIsFrozen(thawed));
    this.dispatchEvent(new CustomEvent("remote-session-state", { detail: thawed }));
    for (const viewId of this.#viewIdsForSession(thawed.sessionId)) this.#maybeReclaim(viewId);
  }

  /** Hold the cursor steady while the replica is frozen, without disturbing focus. */
  #setCursorFrozen(sessionId: string, frozen: boolean): void {
    for (const [viewId, view] of this.#views) {
      if (view.sessionId === sessionId) this.#postWorker({ type: "cursor-frozen", surfaceId: viewId, frozen });
    }
  }

  async #remoteSessionStateRequest(
    command: { type: "get-remote-session-state" | "reconnect-remote-session"; sessionId: string },
    timeoutMs: number,
  ): Promise<RemoteSessionRuntimeState | undefined> {
    await this.connect();
    if (!this.#remoteLifecycleSupported) return undefined;
    const response = await this.#control!.request(command, timeoutMs);
    if (response.type !== "remote-session-state") {
      throw new Error("ghosttead returned an unexpected remote session state");
    }
    this.#applyRemoteSessionState(command.sessionId, response, true);
    this.#applyController(
      command.sessionId,
      response.controller,
      response.cols,
      response.rows,
      response.controlRevision,
    );
    for (const view of response.views) this.#applyViewState(view.viewId, view);
    return this.#remoteSessions.get(command.sessionId);
  }

  /** Rebuild this client's state for one remote session from the daemon. */
  async getRemoteSessionState(sessionId: string): Promise<RemoteSessionRuntimeState | undefined> {
    return this.#remoteSessionStateRequest({ type: "get-remote-session-state", sessionId }, 10_000);
  }

  async reconnectRemoteSession(sessionId: string): Promise<RemoteSessionRuntimeState | undefined> {
    return this.#remoteSessionStateRequest(
      { type: "reconnect-remote-session", sessionId },
      RECONNECT_REQUEST_TIMEOUT_MS,
    );
  }

  async retryRemoteView(sessionId: string, viewId: string): Promise<void> {
    await this.connect();
    if (!this.#remoteLifecycleSupported) return;
    const response = await this.#control!.request({ type: "retry-remote-view", sessionId, viewId });
    if (response.type !== "view-state") throw new Error("ghosttead returned an unexpected view state");
    this.#applyViewState(response.viewId, response);
  }

  #reconcileRemoteSessions(): Promise<unknown> {
    if (!this.#remoteLifecycleSupported) return Promise.resolve();
    return Promise.all(
      [...this.#remoteSessions.keys()].map((sessionId) =>
        this.getRemoteSessionState(sessionId).catch((error: unknown) => {
          if (!this.#disposed) {
            console.warn(`[terminal-runtime] could not reconcile remote session ${sessionId}`, error);
          }
        }),
      ),
    );
  }

  /**
   * `silent` marks operations that drop without the keystroke hint: focus and
   * geometry updates are cosmetic, and pointer gestures are already answered
   * by the pane's frozen treatment.
   */
  #sendViewInput(
    viewId: string,
    operation: (attachmentEpoch: number, inputSequence: number) => void,
    silent = false,
  ): void {
    const view = this.#views.get(viewId);
    if (!view || view.readWrite === false) return;
    const remote = this.#remoteSessions.get(view.sessionId);
    const attachmentEpoch = view.attachmentEpoch;
    // Input for a remote session is dropped with feedback rather than queued:
    // replaying a keystroke across an outage would deliver it to a screen the
    // user has never seen. The queue below survives only for a local session's
    // mount-to-attach gap, which is a local IPC round-trip.
    if (remote && (remote.state !== "live" || attachmentEpoch === undefined)) {
      view.pendingInput.length = 0;
      if (!silent) this.#reportSuppressedInput(view.sessionId, viewId, remote.state);
      return;
    }
    if (attachmentEpoch === undefined) {
      if (view.pendingInput.length < 256) view.pendingInput.push(operation);
      return;
    }
    view.inputSequence += 1;
    operation(attachmentEpoch, view.inputSequence);
  }

  #reportSuppressedInput(sessionId: string, viewId: string, state: RemoteSessionRuntimeState["state"]): void {
    this.dispatchEvent(
      new CustomEvent("input-suppressed", { detail: { sessionId, viewId, state } satisfies RemoteInputSuppression }),
    );
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
    this.#sendViewInput(
      viewId,
      (attachmentEpoch, inputSequence) =>
        this.#control?.notify({ type: "send-mouse", sessionId, viewId, attachmentEpoch, inputSequence, event }),
      true,
    );
  }

  scroll(sessionId: string, viewId: string, rows: number): void {
    if (rows === 0) return;
    // Scrolling is host-side input, so it is simply inert while frozen.
    this.#sendViewInput(
      viewId,
      (attachmentEpoch, inputSequence) =>
        this.#control?.notify({ type: "scroll", sessionId, viewId, attachmentEpoch, inputSequence, rows }),
      true,
    );
  }

  scrollTo(sessionId: string, viewId: string, row: number): void {
    if (!Number.isSafeInteger(row) || row < 0) return;
    this.#sendViewInput(
      viewId,
      (attachmentEpoch, inputSequence) =>
        this.#control?.notify({ type: "scroll-to", sessionId, viewId, attachmentEpoch, inputSequence, row }),
      true,
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

  setEffects(sessionHandle: string, effects: TerminalEffects, surfaceId?: string): void {
    this.#postWorker({ type: "effects", sessionHandle, ...(surfaceId ? { surfaceId } : {}), effects });
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
      // An explicit claim is the funnel's outcome, not a competing path.
      view.claimedEpoch = view.attachmentEpoch;
      view.claimedRevision = this.#controlBySession.get(view.sessionId)?.revision ?? 0;
    }
    const session = this.#sessionByHandle.get(sessionHandle);
    if (!session) return;
    this.#sendViewInput(
      viewId,
      (attachmentEpoch) => {
        this.#control?.notify({
          type: "focus-and-resize",
          sessionId: session.id,
          viewId,
          attachmentEpoch,
          cols,
          rows,
        });
      },
      true,
    );
  }

  setFocused(sessionHandle: string, viewId: string, focused: boolean, cols: number, rows: number): void {
    const view = this.#views.get(viewId);
    if (view) {
      view.desiredCols = cols;
      view.desiredRows = rows;
    }
    if (this.#focusByView.get(viewId) === focused) {
      // Focus has not moved, so the claim below will not run — but an epoch or
      // controller change since the last update may have made one possible,
      // and nothing else would ever retry it after a resume.
      this.#maybeReclaim(viewId);
      return;
    }
    this.#focusByView.set(viewId, focused);
    this.#postWorker({ type: "focus", surfaceId: viewId, sessionHandle, focused });
    const session = this.#sessionByHandle.get(sessionHandle);
    if (!session) return;
    this.#sendViewInput(
      viewId,
      (attachmentEpoch, inputSequence) => {
        this.#control?.notify({
          type: "focus",
          sessionId: session.id,
          viewId,
          attachmentEpoch,
          inputSequence,
          focused,
        });
        if (focused) {
          // Taking focus is a deliberate claim, and counts as this epoch's.
          if (view) {
            view.claimedEpoch = attachmentEpoch;
            view.claimedRevision = this.#controlBySession.get(view.sessionId)?.revision ?? 0;
          }
          this.#control?.notify({
            type: "focus-and-resize",
            sessionId: session.id,
            viewId,
            attachmentEpoch,
            cols,
            rows,
          });
        }
      },
      true,
    );
  }

  async copySelection(sessionId: string, viewId: string, selection: CellSelection, selectAll = false): Promise<string> {
    await this.connect();
    const view = this.#views.get(viewId);
    if (!view || view.sessionId !== sessionId) return "";
    // A frozen replica stays copyable: offline the daemon answers from the
    // retained snapshot and authorizes by ownership, so the last epoch this
    // view held is enough to name the attachment.
    const attachmentEpoch = view.attachmentEpoch ?? view.lastAttachmentEpoch;
    if (attachmentEpoch === undefined) return "";
    const response = await this.#control!.request({
      type: "selection-text",
      sessionId,
      viewId,
      attachmentEpoch,
      startColumn: selection.anchor.column,
      startRow: selection.anchor.row,
      endColumn: selection.focus.column,
      endRow: selection.focus.row,
      selectAll,
    });
    if (response.type !== "selection-text") throw new Error("ghosttead returned an unexpected selection response");
    // Offline the daemon can only reach the retained screen, so say so rather
    // than letting a short copy read as the whole scrollback.
    if (response.scope !== undefined) {
      this.dispatchEvent(
        new CustomEvent("selection-scope", {
          detail: { sessionId, viewId, scope: response.scope } satisfies SelectionScope,
        }),
      );
    }
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
    this.#remoteSessions.delete(sessionId);
    this.#controlBySession.delete(sessionId);
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
    if (view.attachmentEpoch === undefined || view.controlEpoch === undefined) {
      // Dimensions are one of the funnel's conditions: a pane that measured
      // itself while uncontrolled may now be able to take control.
      this.#maybeReclaim(viewId);
      return;
    }
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
    this.#remoteSessions.clear();
    this.#controlBySession.clear();
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
