#!/usr/bin/env node
/**
 * A two-daemon remote-terminal fixture on the real tailnet.
 *
 * `up` starts a host `ghosttead` with a session on it and a viewer `ghosttead`
 * that can see it, both joined to the tailnet through the Truffle sidecar. The
 * outage verbs then reproduce the two failures the reconnect design is built
 * around, which no mock can stage honestly:
 *
 *   freeze/thaw   SIGSTOP/SIGCONT the host process. The tailnet peer stays up
 *                 and the socket stays open, so the viewer sees a host that has
 *                 gone silent rather than one that hung up — the case that
 *                 needs liveness detection instead of a transport error.
 *   restart-host  Replace the host process while keeping its tailnet identity,
 *                 so the device id survives and only `host_instance_id`
 *                 changes. That is the evidence for `ended{host-restarted}`.
 *
 * Both daemons keep durable Truffle profiles under `native/build`, so repeated
 * runs reuse the same two tailnet devices instead of littering the tailnet with
 * one pair per run. `--fresh` discards them and registers new ones.
 *
 * Without TRUFFLE_TEST_AUTHKEY the fixture reports that it is unavailable and
 * every caller skips; the key is read from the environment or `.env` and is
 * only ever handed to a child process, never logged.
 */
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { connect } from "node:net";
import { platform, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { localEndpoints } from "../bench/lib/ipc-endpoints.mjs";

const root = resolve(import.meta.dirname, "..");

/**
 * Which fixture this process is talking about.
 *
 * One machine can host several — two people, or two agents, working the same
 * checkout at once. They must not share anything: not the state file, not the
 * tailnet profiles, and above all not the service name, or one fixture's
 * viewer discovers the other's host and the run quietly measures the wrong
 * pair. Tearing down someone else's fixture is the same mistake with a louder
 * failure, and it looks exactly like a daemon dropping a connection.
 */
const fixtureId = (process.env.GHOSTTEA_FIXTURE_ID ?? "v1").replace(/[^A-Za-z0-9_-]/g, "");
const stateRoot = join(root, `native/build/truffle-fixture${fixtureId === "v1" ? "" : `-${fixtureId}`}`);
const statePath = join(stateRoot, "state.json");
const profileRoot = join(stateRoot, "profiles");
const logRoot = join(stateRoot, "logs");

/** The local control protocol minor that carries the remote lifecycle surface. */
export const REMOTE_LIFECYCLE_PROTOCOL_MINOR = 12;

/**
 * How long each stage may take, from the transport constants rather than from
 * taste: advertisements republish every 5 s and expire after 15 s, and a 1.4
 * pair has no heartbeat, so a silent host is noticed by advertisement expiry
 * plus a probe of the cached connection — or, in the worst case, by quinn's
 * 30 s idle timeout. Every budget below is that worst case with room to spare;
 * they bound a failure, they are not expected waits.
 */
export const BUDGETS = {
  /** Joining a tailnet and resolving fonts on a cold start. */
  daemonReadyMs: 180_000,
  /** Advertisement publish plus store replication to the viewer. */
  discoveryMs: 120_000,
  /** Advertisement expiry (15 s) + probe, or the 30 s idle timeout. */
  outageDetectedMs: 90_000,
  /** Republished advertisement (≤ 5 s) short-circuits backoff, then a dial. */
  resumeMs: 90_000,
  /** A fresh host process, its advertisement, and the identity comparison. */
  restartMs: 120_000,
};

function dotenvValue(name) {
  const path = join(root, ".env");
  if (!existsSync(path)) return undefined;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match || match[1] !== name) continue;
    const value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      return value.slice(1, -1);
    }
    return value;
  }
  return undefined;
}

function configured(name) {
  const value = process.env[name] ?? dotenvValue(name);
  return value && value.trim() ? value : undefined;
}

function sidecarPath() {
  return configured("TRUFFLE_SIDECAR_PATH") ?? resolve(root, "../p008/truffle/packages/sidecar-slim/sidecar-slim");
}

/**
 * Why this machine cannot run the fixture, or nothing.
 *
 * Callers turn a reason into a skip rather than a failure: a checkout with no
 * auth key is the normal case in CI, not a broken one.
 */
export function unavailableReason() {
  if (platform() === "win32") return "the outage verbs need POSIX job-control signals";
  if (!configured("TRUFFLE_TEST_AUTHKEY")) return "TRUFFLE_TEST_AUTHKEY is not set";
  if (!existsSync(sidecarPath())) return "the Truffle sidecar is missing (set TRUFFLE_SIDECAR_PATH)";
  return undefined;
}

function ghostteadBinary() {
  return resolve(root, `target/release/${platform() === "win32" ? "ghosttead.exe" : "ghosttead"}`);
}

export function readState() {
  if (!existsSync(statePath)) return undefined;
  try {
    return JSON.parse(readFileSync(statePath, "utf8"));
  } catch {
    // A half-written state file is a crashed run's leftovers, not a running
    // fixture. Reporting it as unreadable would demand a manual `down` for
    // something that is already down.
    return undefined;
  }
}

function writeState(state) {
  mkdirSync(stateRoot, { recursive: true });
  writeFileSync(statePath, `${JSON.stringify(state, undefined, 2)}\n`);
  return state;
}

function requireState() {
  const state = readState();
  if (!state) throw new Error("no fixture is running; run `node scripts/truffle-fixture.mjs up` first");
  return state;
}

/**
 * Whether that pid is still *our* daemon.
 *
 * Signal 0 alone answers "some process holds this number", which after a
 * crashed run is as likely to be an unrelated process that inherited a
 * recycled pid — and believing it is how `up` starts refusing to run over a
 * fixture that is already gone. The command line is what makes it ours.
 */
function alive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  const probe = spawnSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" });
  return (probe.stdout ?? "").includes("ghosttead");
}

/** `T` is a stopped process, which is how freeze proves it did something. */
function processState(pid) {
  const probe = spawnSync("ps", ["-o", "state=", "-p", String(pid)], { encoding: "utf8" });
  return probe.stdout?.trim() ?? "";
}

function sleep(milliseconds) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));
}

/** `down` is synchronous so the CLI can finish inside one tick of teardown. */
function sleepSync(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

async function until(label, timeoutMs, attempt) {
  const deadline = Date.now() + timeoutMs;
  let last;
  for (;;) {
    try {
      const outcome = await attempt();
      if (outcome !== undefined) return outcome;
    } catch (error) {
      last = error;
    }
    if (Date.now() >= deadline) {
      throw new Error(`${label} did not happen within ${Math.round(timeoutMs / 1000)}s${last ? `: ${last}` : ""}`);
    }
    await sleep(250);
  }
}

// --- local control protocol -------------------------------------------------

function framed(bytes) {
  const body = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const packet = Buffer.allocUnsafe(body.length + 4);
  packet.writeUInt32LE(body.length);
  packet.set(body, 4);
  return packet;
}

/**
 * A control connection that keeps every pushed event it has seen.
 *
 * Retaining them matters more than it looks: a caller awaiting `live` must
 * still be able to prove that `reconnecting` happened, and a transition it was
 * not yet waiting on when it arrived would otherwise be gone. `waitForEvent`
 * therefore searches the transcript before it waits.
 */
export async function openControl(socketPath, token, { protocolMinor = REMOTE_LIFECYCLE_PROTOCOL_MINOR } = {}) {
  const socket = connect(socketPath);
  await new Promise((resolveOpen, reject) => {
    socket.once("connect", resolveOpen);
    socket.once("error", reject);
  });
  socket.setNoDelay(true);

  const events = [];
  const waiters = new Set();
  const pending = new Map();
  let authenticated;
  let buffered = Buffer.alloc(0);
  let failure;
  let frames = 0;
  let deliberate = false;

  // Set GHOSTTEA_FIXTURE_TRACE to a path to record every frame and every
  // socket event verbatim. A connection nobody meant to close can only be
  // explained by the bytes that crossed it, and by then they are gone.
  const tracePath = process.env.GHOSTTEA_FIXTURE_TRACE;
  const trace = (kind, detail) => {
    if (!tracePath) return;
    const line = JSON.stringify({ at: new Date().toISOString(), socket: socketPath, kind, ...detail });
    appendFileSync(tracePath, `${line}\n`);
  };
  trace("open", { protocolMinor });

  const fail = (error) => {
    failure = error;
    for (const waiter of waiters) waiter.reject(error);
    waiters.clear();
    for (const [, waiter] of pending) waiter.reject(error);
    pending.clear();
  };

  socket.on("error", (error) => {
    trace("socket-error", { message: error.message, code: error.code });
    fail(error);
  });
  socket.on("close", (hadError) => {
    // `hadError` separates "the peer hung up" from "this end faulted", which
    // is the first fork in diagnosing a connection nobody meant to close.
    trace("socket-close", { hadError, deliberate, framesSeen: frames });
    if (deliberate) {
      // Our own teardown. Saying "the connection closed" here would accuse the
      // daemon of dropping a socket this side asked to close, and a waiter
      // still pending at teardown would report that as the run's cause of
      // death — which is exactly how this fixture spent a diagnosis.
      fail(new Error("control connection closed by this client"));
      return;
    }
    fail(new Error(`control connection to ${socketPath} closed (hadError=${Boolean(hadError)})`));
  });
  socket.on("data", (chunk) => {
    buffered = Buffer.concat([buffered, chunk]);
    for (;;) {
      if (buffered.length < 4) return;
      const length = buffered.readUInt32LE(0);
      if (buffered.length < length + 4) return;
      const body = buffered.subarray(4, length + 4);
      buffered = buffered.subarray(length + 4);
      frames += 1;
      trace("frame", { bytes: body.length, body: body.toString() });
      if (!authenticated) {
        authenticated = body.toString();
        continue;
      }
      let message;
      try {
        message = JSON.parse(body.toString());
      } catch (error) {
        // The daemon is supposed to speak JSON on every frame. Say which
        // bytes it did not, rather than dying inside an event handler where
        // the payload would be lost.
        trace("frame-not-json", { bytes: body.length, body: body.toString() });
        fail(new Error(`control frame was not JSON (${error.message}): ${body.toString().slice(0, 400)}`));
        socket.destroy();
        return;
      }
      if (message.requestId === 0) {
        events.push({ ...message, receivedAt: Date.now() });
        for (const waiter of [...waiters]) {
          if (!waiter.predicate(message)) continue;
          waiters.delete(waiter);
          waiter.resolve(message);
        }
        continue;
      }
      const waiter = pending.get(message.requestId);
      if (!waiter) continue;
      pending.delete(message.requestId);
      waiter.resolve(message);
    }
  });

  socket.write(framed(token));
  await until("control authentication", 10_000, () => (authenticated ? true : undefined));
  if (authenticated !== "ok") throw new Error(`control authentication rejected by ${socketPath}`);

  let nextRequestId = 1;
  const request = (command, timeoutMs = 30_000) => {
    if (failure) return Promise.reject(failure);
    const requestId = nextRequestId++;
    const answer = new Promise((resolveRequest, reject) => {
      const timer = setTimeout(() => {
        pending.delete(requestId);
        reject(new Error(`${command.type} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      pending.set(requestId, {
        resolve: (message) => {
          clearTimeout(timer);
          resolveRequest(message);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
    });
    socket.write(framed(JSON.stringify({ ...command, requestId })));
    return answer;
  };

  /**
   * `since` is a cursor into the transcript, and callers asserting a *change*
   * must pass one. Searching from the beginning is right for "did this ever
   * happen" and quietly wrong for "did this happen because of what I just
   * did": a stimulus that changed nothing would still match the same state
   * from before it.
   */
  const waitForEvent = (predicate, timeoutMs, label, since = 0) => {
    const seen = events.slice(since).find(predicate);
    if (seen) return Promise.resolve(seen);
    if (failure) return Promise.reject(failure);
    return new Promise((resolveEvent, reject) => {
      const waiter = {
        predicate,
        resolve: (message) => {
          clearTimeout(timer);
          resolveEvent(message);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      };
      const timer = setTimeout(() => {
        waiters.delete(waiter);
        reject(new Error(`${label} did not arrive within ${Math.round(timeoutMs / 1000)}s`));
      }, timeoutMs);
      waiters.add(waiter);
    });
  };

  const hello = await request({
    type: "hello",
    protocolMajor: 1,
    protocolMinor,
    clientBuild: "truffle-fixture",
  });
  if (hello.type !== "hello") throw new Error(`hello failed: ${JSON.stringify(hello)}`);

  return {
    hello,
    events,
    request,
    waitForEvent,
    close: () => {
      deliberate = true;
      socket.destroy();
    },
  };
}

async function expect(control, command, type) {
  const response = await control.request(command);
  if (response.type !== type) throw new Error(`${command.type} answered ${JSON.stringify(response)}`);
  return response;
}

// --- daemons ----------------------------------------------------------------

function daemonEnvironment(role, state) {
  const profile = state[role];
  return {
    ...process.env,
    GHOSTTEA_CONTROL_SOCKET: profile.controlSocket,
    GHOSTTEA_FRAME_SOCKET: profile.frameSocket,
    GHOSTTEA_AUTH_TOKEN: profile.token,
    TRUFFLE_TEST_AUTHKEY: configured("TRUFFLE_TEST_AUTHKEY"),
    TRUFFLE_SIDECAR_PATH: sidecarPath(),
    GHOSTTEA_TRUFFLE_ENABLED: "1",
    GHOSTTEA_TRUFFLE_ALLOW_WRITE: "1",
    // Durable, not ephemeral: `restart-host` is only evidence of a restart if
    // the device id survives it, and an ephemeral node that the control plane
    // reaps mid-restart comes back as a different device entirely.
    GHOSTTEA_TRUFFLE_EPHEMERAL: "0",
    GHOSTTEA_TRUFFLE_APP_ID: state.appId,
    GHOSTTEA_TRUFFLE_SERVICE: state.serviceName,
    GHOSTTEA_TRUFFLE_STATE_DIR: profile.profileDir,
    GHOSTTEA_TRUFFLE_DEVICE_NAME: profile.deviceName,
  };
}

async function startDaemon(role, state) {
  const profile = state[role];
  writeFileSync(profile.logPath, "");
  const log = openSync(profile.logPath, "a");
  // Detached so the fixture outlives the `up` process that started it; every
  // caller after that addresses the daemons by pid through the state file.
  const child = spawn(ghostteadBinary(), [], {
    cwd: root,
    env: daemonEnvironment(role, state),
    detached: true,
    stdio: ["ignore", log, log],
  });
  child.unref();
  profile.pid = child.pid;
  await until(`${role} ghosttead startup`, BUDGETS.daemonReadyMs, () => {
    if (!alive(profile.pid)) throw new Error(`exited early; see ${profile.logPath}`);
    return readFileSync(profile.logPath, "utf8").includes("ghosttead ready") ? true : undefined;
  });
  return profile.pid;
}

function stopDaemon(pid, { grace = 5_000 } = {}) {
  if (!pid || !alive(pid)) return;
  // A stopped process cannot act on SIGTERM, so wake it before asking it to
  // leave — otherwise a frozen fixture would only ever die by SIGKILL.
  try {
    process.kill(pid, "SIGCONT");
  } catch {
    // Already gone between the liveness check and here.
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return;
  }
  const deadline = Date.now() + grace;
  while (alive(pid) && Date.now() < deadline) sleepSync(50);
  if (!alive(pid)) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Raced with its own exit.
  }
}

async function hostsSeenByViewer(state) {
  const control = await openControl(state.viewer.controlSocket, state.viewer.token);
  try {
    const response = await expect(control, { type: "list-remote-hosts" }, "remote-hosts");
    return response.hosts;
  } finally {
    control.close();
  }
}

/** The host device as the viewer currently sees it, or undefined. */
async function advertisedHost(state) {
  const hosts = await hostsSeenByViewer(state);
  return hosts.find((host) => host.deviceName === state.host.deviceName || host.deviceId === state.host.deviceId);
}

// --- verbs ------------------------------------------------------------------

export async function up({ build = true, fresh = false, cols = 120, rows = 40 } = {}) {
  const reason = unavailableReason();
  if (reason) throw new Error(`the Truffle fixture is unavailable: ${reason}`);
  const running = readState();
  if (running) {
    // A state file whose daemons are all gone is a crash's leftovers, not a
    // running fixture; refusing to start over one would need a manual `down`
    // for something that is already down.
    if ([running.host?.pid, running.viewer?.pid].some((pid) => pid && alive(pid))) {
      throw new Error(
        `fixture ${running.runId} is already up (host pid ${running.host?.pid}, viewer pid ${running.viewer?.pid}). ` +
          "Run `down` to stop it, or set GHOSTTEA_FIXTURE_ID to work on an isolated one.",
      );
    }
    down();
  }

  if (build) {
    const built = spawnSync("cargo", ["build", "--release", "--package", "ghosttead"], { cwd: root, stdio: "inherit" });
    if (built.status !== 0) throw new Error("failed to build ghosttead");
  }
  if (!existsSync(ghostteadBinary())) throw new Error(`missing ${ghostteadBinary()}; rerun without --no-build`);
  if (fresh) rmSync(profileRoot, { recursive: true, force: true });

  const runId = randomBytes(4).toString("hex");
  // Sockets live in the system temp directory, not beside the profiles: a Unix
  // socket path is capped at 104 bytes, and this repository's own path already
  // spends most of them.
  const runtimeRoot = mkdtempSync(join(tmpdir(), "ghosttea-tf-"));
  const state = {
    runId,
    startedAt: new Date().toISOString(),
    // Stable across runs so the tailnet keeps seeing one pair of fixture
    // devices; the store slices they exchange expire on their own.
    appId: `ghosttea-fixture-${fixtureId}`,
    serviceName: `terminal.fixture.${fixtureId}`,
    runtimeRoot,
    frozen: false,
  };
  mkdirSync(logRoot, { recursive: true });
  for (const role of ["host", "viewer"]) {
    const runtimeDir = join(runtimeRoot, role === "host" ? "h" : "v");
    mkdirSync(runtimeDir, { recursive: true });
    const profileDir = join(profileRoot, role);
    mkdirSync(profileDir, { recursive: true });
    state[role] = {
      ...localEndpoints(runtimeDir),
      token: randomBytes(16).toString("hex"),
      profileDir,
      deviceName: `ghosttea-fixture-${fixtureId}-${role}`,
      logPath: join(logRoot, `${role}.log`),
      pid: undefined,
    };
  }

  // Recorded before anything is spawned and rewritten as facts arrive, so a
  // failure part-way through still leaves `down` able to find the daemons
  // rather than orphaning them on the tailnet.
  writeState(state);
  try {
    await startDaemon("host", state);
    writeState(state);
    const hostControl = await openControl(state.host.controlSocket, state.host.token);
    try {
      const created = await expect(
        hostControl,
        {
          type: "create-session",
          options: {
            executable: "/bin/sh",
            args: [],
            env: {},
            cols,
            rows,
            persistence: "terminate-with-app",
            programKind: "interactive-shell",
          },
        },
        "session-created",
      );
      state.host.sessionId = created.session.id;
      // The shell's own pid, so a scenario can kill the session out from under
      // a frozen host and watch the tombstone answer for it afterwards.
      state.host.sessionPid = created.session.pid;
    } finally {
      hostControl.close();
    }

    await startDaemon("viewer", state);
    writeState(state);
    const host = await until("the viewer discovering the host", BUDGETS.discoveryMs, async () => {
      const seen = await advertisedHost(state);
      if (!seen?.online) return undefined;
      return seen.sessions.some((session) => session.sessionId === state.host.sessionId) ? seen : undefined;
    });
    state.host.deviceId = host.deviceId;
    state.host.hostInstanceId = host.hostInstanceId;
    return writeState(state);
  } catch (error) {
    down();
    throw error;
  }
}

export function freeze() {
  const state = requireState();
  if (!alive(state.host.pid)) throw new Error("the host daemon is not running");
  process.kill(state.host.pid, "SIGSTOP");
  state.frozen = true;
  writeState(state);
  // The tailnet peer stays online and the socket stays open; only the process
  // behind them stops answering. That is the outage this fixture exists for.
  return { pid: state.host.pid, processState: processState(state.host.pid) };
}

export function thaw() {
  const state = requireState();
  if (!alive(state.host.pid)) throw new Error("the host daemon is not running");
  process.kill(state.host.pid, "SIGCONT");
  state.frozen = false;
  writeState(state);
  return { pid: state.host.pid, processState: processState(state.host.pid) };
}

/**
 * Ask the host daemon to leave, and let it.
 *
 * Deliberately not `down`'s escalation: this scenario is about a host that gets
 * the chance to say goodbye, so the viewer can distinguish "the host shut down"
 * from "the host vanished". If it has to be killed to go, the difference this
 * exists to observe was never available, and that is reported rather than
 * papered over.
 */
export async function stopHost({ graceMs = 15_000 } = {}) {
  const state = requireState();
  const pid = state.host.pid;
  if (!alive(pid)) throw new Error("the host daemon is not running");
  if (state.frozen) {
    // A stopped process cannot act on SIGTERM; waking it first is what makes
    // this a graceful stop rather than a disguised kill.
    process.kill(pid, "SIGCONT");
    state.frozen = false;
  }
  process.kill(pid, "SIGTERM");
  const deadline = Date.now() + graceMs;
  while (alive(pid) && Date.now() < deadline) await sleep(100);
  const exited = !alive(pid);
  if (!exited) {
    process.kill(pid, "SIGKILL");
    while (alive(pid) && Date.now() < deadline + 2_000) await sleep(50);
  }
  state.host.pid = undefined;
  state.host.sessionId = undefined;
  state.host.sessionPid = undefined;
  writeState(state);
  return { pid, exitedOnSigterm: exited };
}

/**
 * Give the host another shell to serve.
 *
 * Each scenario that ends a session needs one of its own: a session can only
 * reach a terminal state once, and reusing one would have the second scenario
 * assert against the first one's corpse.
 */
export async function newSession({ cols = 120, rows = 40 } = {}) {
  const state = requireState();
  if (!alive(state.host.pid)) throw new Error("the host daemon is not running");
  const hostControl = await openControl(state.host.controlSocket, state.host.token);
  try {
    const created = await expect(
      hostControl,
      {
        type: "create-session",
        options: {
          executable: "/bin/sh",
          args: [],
          env: {},
          cols,
          rows,
          persistence: "terminate-with-app",
          programKind: "interactive-shell",
        },
      },
      "session-created",
    );
    state.host.sessionId = created.session.id;
    state.host.sessionPid = created.session.pid;
    writeState(state);
    return { sessionId: created.session.id, pid: created.session.pid };
  } finally {
    hostControl.close();
  }
}

/**
 * Kill the shell the host is serving, not the host.
 *
 * Run while the host is frozen, this stages the case the tombstone store exists
 * for: the session is already gone, but nobody has been able to say so, and the
 * viewer has to learn it from the host's records once contact returns rather
 * than inferring it from silence.
 */
export function killSession() {
  const state = requireState();
  const pid = state.host.sessionPid;
  if (!pid) throw new Error("the fixture recorded no session process to kill");
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    throw new Error(`the session process ${pid} was already gone`);
  }
  return { sessionId: state.host.sessionId, pid };
}

/**
 * Replace the host process, keeping its tailnet identity.
 *
 * The assertion this enables is `ended{host-restarted}`, which a viewer may
 * only claim when the device is the same and its `host_instance_id` is not. If
 * the device came back as a new one — an ephemeral node reaped mid-restart, a
 * discarded profile — that evidence never existed, so this reports the failure
 * instead of letting a test conclude from it.
 */
export async function restartHost() {
  const state = requireState();
  const before = state.host.hostInstanceId ?? (await advertisedHost(state))?.hostInstanceId;
  stopDaemon(state.host.pid);
  state.frozen = false;
  state.host.sessionId = undefined;
  await startDaemon("host", state);
  const host = await until("the restarted host re-advertising", BUDGETS.restartMs, async () => {
    const seen = await advertisedHost(state);
    if (!seen?.online || !seen.hostInstanceId) return undefined;
    return seen.hostInstanceId !== before ? seen : undefined;
  });
  if (state.host.deviceId && host.deviceId !== state.host.deviceId) {
    throw new Error(
      `the host returned as a new device (${state.host.deviceId} -> ${host.deviceId}); ` +
        "its profile did not survive the restart, so this run cannot prove host-restarted",
    );
  }
  state.host.deviceId = host.deviceId;
  state.host.hostInstanceId = host.hostInstanceId;
  writeState(state);
  return { deviceId: host.deviceId, previousInstanceId: before, hostInstanceId: host.hostInstanceId };
}

export function down() {
  const state = readState();
  if (!state) return { stopped: [] };
  const stopped = [];
  for (const role of ["viewer", "host"]) {
    const pid = state[role]?.pid;
    if (!pid) continue;
    stopDaemon(pid);
    stopped.push({ role, pid });
  }
  if (state.runtimeRoot) rmSync(state.runtimeRoot, { recursive: true, force: true });
  rmSync(statePath, { force: true });
  // Profiles survive on purpose: they are the tailnet identities, and keeping
  // them means the next run reuses these two devices instead of registering a
  // new pair. `up --fresh` is the way to let them go.
  return { stopped, profilesKept: profileRoot };
}

export function status() {
  const state = readState();
  if (!state) return { running: false };
  return {
    running: true,
    runId: state.runId,
    frozen: state.frozen,
    host: {
      pid: state.host.pid,
      alive: alive(state.host.pid),
      processState: processState(state.host.pid),
      deviceId: state.host.deviceId,
      hostInstanceId: state.host.hostInstanceId,
      sessionId: state.host.sessionId,
      log: state.host.logPath,
    },
    viewer: {
      pid: state.viewer.pid,
      alive: alive(state.viewer.pid),
      controlSocket: state.viewer.controlSocket,
      log: state.viewer.logPath,
    },
  };
}

// --- command line -----------------------------------------------------------

const USAGE = `Usage: node scripts/truffle-fixture.mjs <command> [options]

  up [--no-build] [--fresh]  Start host + viewer on the tailnet with a session
  freeze                     SIGSTOP the host: a silent, still-connected outage
  thaw                       SIGCONT the host
  restart-host               Replace the host process, keeping its device id
  stop-host                  SIGTERM the host and let it say goodbye
  kill-session               SIGKILL the shell the host is serving
  down                       Stop both daemons (tailnet profiles are kept)
  status                     Report what is running

Requires TRUFFLE_TEST_AUTHKEY and TRUFFLE_SIDECAR_PATH (environment or .env).
Without them every command reports that the fixture is unavailable.
`;

async function main(argv) {
  const command = argv[0] ?? "status";
  if (command === "--help" || command === "-h" || command === "help") {
    process.stdout.write(USAGE);
    return 0;
  }
  if (command !== "status" && command !== "down") {
    const reason = unavailableReason();
    if (reason) {
      console.log(`SKIP truffle fixture: ${reason}`);
      return 0;
    }
  }
  switch (command) {
    case "up": {
      const state = await up({ build: !argv.includes("--no-build"), fresh: argv.includes("--fresh") });
      console.log(
        [
          `truffle fixture up (run ${state.runId})`,
          `  host    pid ${state.host.pid}  device ${state.host.deviceId}  instance ${state.host.hostInstanceId}`,
          `  session ${state.host.sessionId}`,
          `  viewer  pid ${state.viewer.pid}  control ${state.viewer.controlSocket}`,
          `  logs    ${logRoot}`,
        ].join("\n"),
      );
      return 0;
    }
    case "freeze":
      console.log(`host frozen: ${JSON.stringify(freeze())}`);
      return 0;
    case "thaw":
      console.log(`host thawed: ${JSON.stringify(thaw())}`);
      return 0;
    case "restart-host":
      console.log(`host restarted: ${JSON.stringify(await restartHost(), undefined, 2)}`);
      return 0;
    case "stop-host":
      console.log(`host stopped: ${JSON.stringify(await stopHost())}`);
      return 0;
    case "kill-session":
      console.log(`session killed: ${JSON.stringify(killSession())}`);
      return 0;
    case "down":
      console.log(`truffle fixture down: ${JSON.stringify(down())}`);
      return 0;
    case "status":
      console.log(JSON.stringify(status(), undefined, 2));
      return 0;
    default:
      process.stderr.write(`unknown command: ${command}\n\n${USAGE}`);
      return 2;
  }
}

// `process.argv[1]` is absent when this is imported from an eval context, and
// asking for the URL of nothing throws before any caller can use the module.
const entryPoint = process.argv[1] ? pathToFileURL(process.argv[1]).href : undefined;
if (import.meta.url === entryPoint) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    console.error(`truffle fixture failed: ${error.message}`);
    process.exitCode = 1;
  }
}
