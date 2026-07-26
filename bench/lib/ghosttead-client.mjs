import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { localEndpoints, openEndpoint } from "./ipc-endpoints.mjs";
import { cleanEnvironment, shellExecutable } from "./shell-fixture.mjs";
import { nowMs } from "./stats.mjs";

const root = resolve(import.meta.dirname, "../..");

export function resolveGhostteadBinary() {
  const configuredBinary = process.env.GHOSTTEAD_BIN ?? process.env.TERMINALD_BIN;
  if (configuredBinary && existsSync(configuredBinary)) {
    return { kind: "bin", path: configuredBinary };
  }
  const executable = process.platform === "win32" ? "ghosttead.exe" : "ghosttead";
  const release = join(root, "target/release", executable);
  if (existsSync(release)) return { kind: "bin", path: release };
  const debug = join(root, "target/debug", executable);
  if (existsSync(debug)) return { kind: "bin", path: debug };
  return {
    kind: "cargo",
    path: "cargo",
    args: ["run", "--quiet", "--release", "--manifest-path", "native/ghosttead/Cargo.toml"],
  };
}

function packet(bytes) {
  const body = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const result = Buffer.allocUnsafe(body.length + 4);
  result.writeUInt32LE(body.length);
  result.set(body, 4);
  return result;
}

/**
 * Length-prefixed packet reader.
 * `next(timeoutMs)` never abandons an in-flight wait (safe to poll with timeouts).
 */
function packets(socket) {
  const queue = [];
  const waiting = [];
  let buffered = Buffer.alloc(0);
  let closed = false;

  const flushWaiters = () => {
    while (waiting.length > 0 && queue.length > 0) {
      const waiter = waiting.shift();
      waiter(queue.shift());
    }
    if (closed) {
      while (waiting.length > 0) waiting.shift()(null);
    }
  };

  socket.on("data", (chunk) => {
    buffered = Buffer.concat([buffered, chunk]);
    while (buffered.length >= 4) {
      const length = buffered.readUInt32LE(0);
      if (buffered.length < length + 4) break;
      const body = buffered.subarray(4, length + 4);
      buffered = buffered.subarray(length + 4);
      queue.push(body);
    }
    flushWaiters();
  });
  socket.on("close", () => {
    closed = true;
    flushWaiters();
  });
  socket.on("error", () => {
    closed = true;
    flushWaiters();
  });

  return async function next(timeoutMs = null) {
    if (queue.length > 0) return queue.shift();
    if (closed) return null;
    return new Promise((resolvePacket) => {
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        const index = waiting.indexOf(wait);
        if (index >= 0) waiting.splice(index, 1);
        resolvePacket(value);
      };
      const wait = (value) => finish(value);
      waiting.push(wait);
      const timer = timeoutMs === null ? undefined : setTimeout(() => finish(null), Math.max(0, timeoutMs));
    });
  };
}

async function openSocket(path, token) {
  const socket = await openEndpoint(path, Date.now() + 10_000);
  const next = packets(socket);
  socket.write(packet(token));
  const response = await next(5_000);
  if (!response || response.toString() !== "ok") throw new Error("ghosttead authentication failed");
  return { socket, next };
}

/**
 * Single-consumer frame demux. Multiple waiters can subscribe without
 * racing on frames.next() (important for multi-session benches).
 */
class FrameDemux {
  #next;
  #running = false;
  #waiters = new Set();
  #recent = [];
  #maxRecent = 64;

  constructor(next) {
    this.#next = next;
  }

  start() {
    if (this.#running) return;
    this.#running = true;
    void this.#loop();
  }

  stop() {
    this.#running = false;
  }

  clearRecent() {
    this.#recent = [];
  }

  #publish(frame) {
    this.#recent.push(frame);
    if (this.#recent.length > this.#maxRecent) this.#recent.shift();
    for (const waiter of [...this.#waiters]) {
      try {
        waiter(frame);
      } catch {
        // ignore subscriber errors
      }
    }
  }

  async #loop() {
    while (this.#running) {
      const frame = await this.#next(100);
      if (frame) this.#publish(frame);
    }
  }

  /**
   * Wait until a frame matches the predicate.
   */
  waitFor(predicate, { timeoutMs = 30_000, includeRecent = true } = {}) {
    const started = nowMs();
    let frames = 0;
    let bytes = 0;
    let lastSequence = 0n;
    let sequenceGaps = 0;

    if (includeRecent) {
      for (const frame of this.#recent) {
        frames += 1;
        bytes += frame.byteLength;
        const result = predicate(frame, { frames, bytes, lastSequence, sequenceGaps, started });
        if (result?.matched) {
          return Promise.resolve(result.stats);
        }
        if (result?.sequence != null) {
          if (lastSequence !== 0n && result.sequence > lastSequence + 1n) sequenceGaps += 1;
          lastSequence = result.sequence;
        }
      }
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#waiters.delete(onFrame);
        reject(new Error("timeout waiting for frame predicate"));
      }, timeoutMs);

      const onFrame = (frame) => {
        frames += 1;
        bytes += frame.byteLength;
        const result = predicate(frame, { frames, bytes, lastSequence, sequenceGaps, started });
        if (result?.sequence != null) {
          if (lastSequence !== 0n && result.sequence > lastSequence + 1n) sequenceGaps += 1;
          lastSequence = result.sequence;
        }
        if (result?.matched) {
          clearTimeout(timer);
          this.#waiters.delete(onFrame);
          resolve(result.stats);
        }
      };
      this.#waiters.add(onFrame);
    });
  }

  async sampleDuring(durationMs, onTick) {
    const started = nowMs();
    let frames = 0;
    let bytes = 0;
    const rtts = [];
    const onFrame = (frame) => {
      frames += 1;
      bytes += frame.byteLength;
    };
    this.#waiters.add(onFrame);
    try {
      while (nowMs() - started < durationMs) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        if (onTick) {
          const probeStart = nowMs();
          await onTick();
          rtts.push(nowMs() - probeStart);
        }
      }
    } finally {
      this.#waiters.delete(onFrame);
    }
    return { ms: nowMs() - started, frames, bytes, rtts };
  }
}

export class GhostteadHarness {
  #child;
  #runtimeDir;
  #token;
  #controlPath;
  #framePath;
  #requestId = 1;
  #demux;
  #views = new Map();
  #sessionHandles = new Set();
  control;
  frames;

  /**
   * Credentials for a second client on the same daemon. `request` consumes the
   * control stream, so a test that needs events subscribes separately.
   */
  get connection() {
    return { controlSocket: this.#controlPath, authToken: this.#token };
  }

  get pid() {
    return this.#child?.pid;
  }

  static async start({ timeoutMs = 120_000 } = {}) {
    const harness = new GhostteadHarness();
    await harness.#boot(timeoutMs);
    return harness;
  }

  async #boot(timeoutMs) {
    this.#runtimeDir = mkdtempSync(join(tmpdir(), "ghosttea-bench-"));
    const endpoints = localEndpoints(this.#runtimeDir);
    this.#controlPath = endpoints.controlSocket;
    this.#framePath = endpoints.frameSocket;
    this.#token = `bench-${process.pid}-${Date.now()}`;

    const binary = resolveGhostteadBinary();
    const env = {
      ...process.env,
      GHOSTTEA_CONTROL_SOCKET: this.#controlPath,
      GHOSTTEA_FRAME_SOCKET: this.#framePath,
      GHOSTTEA_AUTH_TOKEN: this.#token,
      GHOSTTEA_TRUFFLE_ENABLED: "0",
    };

    if (binary.kind === "bin") {
      this.#child = spawn(binary.path, [], { env, stdio: ["ignore", "pipe", "pipe"] });
    } else {
      this.#child = spawn(binary.path, binary.args, { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
    }

    this.#child.stderr?.on("data", (chunk) => {
      const text = String(chunk).trimEnd();
      if (text) process.stderr.write(`[ghosttead] ${text}\n`);
    });

    await new Promise((resolveReady, reject) => {
      let settled = false;
      const fail = (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };
      const timeout = setTimeout(() => fail(new Error("ghosttead startup timed out")), timeoutMs);
      const onData = (chunk) => {
        if (!String(chunk).includes("ghosttead ready") || settled) return;
        settled = true;
        cleanup();
        resolveReady();
      };
      const cleanup = () => {
        clearTimeout(timeout);
        this.#child.stdout?.off("data", onData);
        this.#child.off("error", onError);
        this.#child.off("exit", onExit);
      };
      const onError = (error) => fail(error);
      const onExit = (code) => fail(new Error(`ghosttead exited during startup (${code})`));
      this.#child.stdout?.on("data", onData);
      this.#child.once("error", onError);
      this.#child.once("exit", onExit);
    });

    this.control = await openSocket(this.#controlPath, this.#token);
    this.frames = await openSocket(this.#framePath, this.#token);
    this.#demux = new FrameDemux(this.frames.next);
    this.#demux.start();
  }

  async request(type, body = {}, timeoutMs = 30_000) {
    const requestId = this.#requestId++;
    const envelope = { requestId, type, ...body };
    this.control.socket.write(packet(JSON.stringify(envelope)));
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const remaining = Math.max(1, deadline - Date.now());
      const raw = await this.control.next(remaining);
      if (!raw) throw new Error(`ghosttead request timed out: ${type}`);
      const message = JSON.parse(raw.toString());
      if (message.requestId === requestId) {
        if (message.type === "error") throw new Error(message.message ?? "ghosttead error");
        return message;
      }
    }
  }

  notify(type, body = {}) {
    this.control.socket.write(packet(JSON.stringify({ requestId: 0, type, ...body })));
  }

  async createAttachedSession({
    cols = 120,
    rows = 40,
    executable = shellExecutable,
    args = [],
    persistence = "terminate-with-app",
    // Workloads run real tools, so the host's search path carries over.
    environment = cleanEnvironment(process.env.PATH ? { PATH: process.env.PATH } : {}),
  } = {}) {
    const created = await this.request("create-session", {
      options: {
        executable,
        args,
        environment,
        cols,
        rows,
        persistence,
      },
    });
    if (created.type !== "session-created") throw new Error("unexpected create-session response");
    const viewId = `bench-${created.session.id}`;
    const attached = await this.request("attach-session", { sessionId: created.session.id, viewId });
    if (attached.type !== "view-attached") throw new Error("unexpected attach-session response");
    this.#views.set(created.session.id, {
      viewId,
      attachmentEpoch: attached.attachmentEpoch,
      inputSequence: 0,
      handle: created.session.handle,
    });
    this.#sessionHandles.add(created.session.handle);
    this.#syncFrameSubscriptions();
    // Drop attach/refresh frames so marker waits only see this session's workload.
    this.#demux.clearRecent();
    return created.session;
  }

  async sendText(sessionId, text) {
    await this.request("send-text", { sessionId, ...this.#nextInput(sessionId), text });
  }

  async interrupt(sessionId) {
    await this.request("interrupt", { sessionId, ...this.#nextInput(sessionId) });
  }

  /**
   * Take resize authority for a view. Resizing is refused without it, so a
   * caller that wants to drive the size claims control first.
   */
  async claimControl(sessionId, cols, rows) {
    const view = this.#views.get(sessionId);
    if (!view) throw new Error(`session ${sessionId} is not attached`);
    const claimed = await this.request("focus-and-resize", {
      sessionId,
      viewId: view.viewId,
      attachmentEpoch: view.attachmentEpoch,
      cols,
      rows,
    });
    if (claimed.type !== "control-claimed") throw new Error(`control claim failed: ${claimed.type}`);
    view.controlEpoch = claimed.controlEpoch;
    return claimed;
  }

  async resize(sessionId, cols, rows) {
    const view = this.#views.get(sessionId);
    if (!view) throw new Error(`session ${sessionId} is not attached`);
    view.resizeSequence = (view.resizeSequence ?? 0) + 1;
    return this.request("resize", {
      sessionId,
      viewId: view.viewId,
      attachmentEpoch: view.attachmentEpoch,
      controlEpoch: view.controlEpoch ?? 0,
      resizeSequence: view.resizeSequence,
      cols,
      rows,
    });
  }

  #nextInput(sessionId) {
    const view = this.#views.get(sessionId);
    if (!view) throw new Error(`session ${sessionId} is not attached`);
    view.inputSequence += 1;
    return {
      viewId: view.viewId,
      attachmentEpoch: view.attachmentEpoch,
      inputSequence: view.inputSequence,
    };
  }

  async terminate(sessionId) {
    await this.request("terminate", { sessionId });
    const view = this.#views.get(sessionId);
    if (view) this.#sessionHandles.delete(view.handle);
    this.#views.delete(sessionId);
    this.#syncFrameSubscriptions();
  }

  #syncFrameSubscriptions() {
    this.frames.socket.write(packet(JSON.stringify({ sessionHandles: [...this.#sessionHandles] })));
  }

  setFrameSubscriptions(sessionHandles) {
    this.#sessionHandles = new Set(sessionHandles);
    this.#syncFrameSubscriptions();
  }

  /**
   * Wait until a frame for sessionHandle contains the ASCII marker.
   * Returns timing and frame stats for the wait window.
   */
  async waitForMarker(sessionHandle, marker, { timeoutMs = 30_000 } = {}) {
    const needle = Buffer.from(marker);
    const handle = BigInt(sessionHandle);
    try {
      return await this.#demux.waitFor(
        (frame, state) => {
          if (frame.byteLength < 56) return { matched: false };
          const session = frame.readBigUInt64LE(8);
          if (session !== handle) return { matched: false };
          const sequence = frame.readBigUInt64LE(40);
          const matched = frame.includes(needle);
          if (!matched) return { matched: false, sequence };
          return {
            matched: true,
            sequence,
            stats: {
              ms: nowMs() - state.started,
              frames: state.frames,
              bytes: state.bytes,
              sequenceGaps: state.sequenceGaps,
              lastSequence: Number(sequence),
            },
          };
        },
        { timeoutMs },
      );
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("timeout")) {
        throw new Error(`timeout waiting for ${marker}`, { cause: error });
      }
      throw error;
    }
  }

  sampleDuring(durationMs, onTick) {
    return this.#demux.sampleDuring(durationMs, onTick);
  }

  dispose() {
    this.#demux?.stop();
    try {
      this.control?.socket.destroy();
      this.frames?.socket.destroy();
    } catch {
      // ignore
    }
    this.#child?.kill("SIGTERM");
    if (this.#runtimeDir) rmSync(this.#runtimeDir, { recursive: true, force: true });
  }
}
