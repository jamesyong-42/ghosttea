#!/usr/bin/env node
/**
 * End-to-end remote-session resilience, over a real tailnet.
 *
 * A viewer `ghosttead` attaches to a session on a host `ghosttead`, and this
 * drives the viewer's local control protocol while the fixture stages real
 * outages on the host:
 *
 *   attach       the remote view attaches and the response is sequenced
 *   freeze       the host goes silent   -> reconnecting, carrying backoff
 *   thaw         the host answers again -> live
 *   restart-host a new host instance    -> ended{host-restarted}
 *
 * What makes this worth running against the tailnet rather than a mock: the
 * frozen host keeps its connection and its tailnet presence, so nothing but
 * real liveness detection can notice it, and the restarted host is a genuinely
 * different instance behind the same device id.
 *
 * Recovery is asserted as *automatic*: nothing here ever sends
 * `reconnect-remote-session`. Manual retry from Suspended is therefore not
 * covered — a session only rests in Suspended after `suspend_after` (10 min),
 * too long for this test, and shrinking it is not exposed on the daemon's
 * configuration surface. That path stays on the deterministic suite.
 *
 * Skips when the fixture is unavailable, which is the normal case in CI.
 */
import {
  BUDGETS,
  REMOTE_LIFECYCLE_PROTOCOL_MINOR,
  down,
  freeze,
  killSession,
  newSession,
  openControl,
  readState,
  restartHost,
  stopHost,
  thaw,
  unavailableReason,
  up,
} from "../../scripts/truffle-fixture.mjs";

const options = {
  reuse: process.argv.includes("--reuse"),
  keep: process.argv.includes("--keep"),
};

const reason = unavailableReason();
if (reason) {
  console.log(`SKIP truffle reconnect e2e: ${reason}`);
  process.exit(0);
}

const VIEW_ID = "reconnect-e2e-view";
const started = Date.now();

function log(message) {
  const elapsed = ((Date.now() - started) / 1000).toFixed(1).padStart(6);
  console.log(`[${elapsed}s] ${message}`);
}

function fail(message) {
  throw new Error(message);
}

/** Every lifecycle transition the viewer reported, for a failure to explain itself. */
function transcript(control, sessionId) {
  const rows = control.events
    .filter((event) => event.type === "remote-session-state-changed" && event.sessionId === sessionId)
    .map((event) => {
      const at = ((event.receivedAt - started) / 1000).toFixed(1).padStart(6);
      const detail = [
        `seq ${event.lifecycleSeq}`,
        `attempt ${event.attempt}`,
        `nextRetryMs ${event.nextRetryMs}`,
        `lastContactMs ${event.lastContactMs}`,
        event.reason ? `reason ${event.reason}` : undefined,
        event.exit ? `exit ${JSON.stringify(event.exit)}` : undefined,
      ]
        .filter(Boolean)
        .join("  ");
      return `  [${at}s] ${String(event.state).padEnd(14)} ${detail}`;
    });
  return rows.length ? `lifecycle transcript:\n${rows.join("\n")}` : "lifecycle transcript: (no transitions seen)";
}

const isState = (sessionId, state) => (event) =>
  event.type === "remote-session-state-changed" && event.sessionId === sessionId && event.state === state;

/**
 * The behaviours minor 6 adds on the host: a heartbeat that notices an outage
 * in seconds rather than waiting out an advertisement, a goodbye on shutdown,
 * and a tombstone that can still answer for a session that died unobserved.
 *
 * They are written now and run on request. Until the host implements them a
 * viewer cannot produce any of these outcomes, so running them by default would
 * make this suite fail for something nobody has built yet — and a suite that is
 * expected to be red teaches everyone to ignore it. `GHOSTTEA_E2E_PHASE3=1`
 * turns them on; that is the switch integration flips once the host lands.
 */
const PHASE3 = process.env.GHOSTTEA_E2E_PHASE3 === "1";

/** Open a fresh remote session and attach one view to it. */
async function openAndAttach(state, viewer, viewId) {
  const opened = await viewer.request({
    type: "open-remote-session",
    deviceId: state.host.deviceId,
    remoteSessionId: state.host.sessionId,
    cols: 120,
    rows: 40,
  });
  if (opened.type !== "session-created") fail(`open-remote-session answered ${JSON.stringify(opened)}`);
  const sessionId = opened.session.id;
  await viewer.request({ type: "attach-session", sessionId, viewId });
  await viewer.waitForEvent(isState(sessionId, "live"), BUDGETS.resumeMs, `${viewId} reaching live`);
  return sessionId;
}

async function phase3Scenarios(state, viewer) {
  const pending = [
    "heartbeat outage detection (seconds, not an advertisement TTL)",
    "SIGTERM the host -> ended{host-shutdown}",
    "session killed during an outage -> ended{session-exited} from the tombstone",
  ];
  if (!PHASE3) {
    console.log(
      ["", "phase 3 scenarios (set GHOSTTEA_E2E_PHASE3=1 once the minor-6 host behaviours land):"]
        .concat(pending.map((name) => `  PENDING  ${name}`))
        .join("\n"),
    );
    return;
  }

  // The session killed while nobody could see it. The viewer must learn how it
  // ended from what the host recorded, not guess from the silence.
  log("phase 3: a session that dies during an outage");
  await newSession();
  const exitedSessionId = await openAndAttach(state, viewer, "phase3-exit-view");
  const beforeOutage = viewer.events.length;
  freeze();
  await viewer.waitForEvent(
    isState(exitedSessionId, "reconnecting"),
    BUDGETS.outageDetectedMs,
    "reconnecting before the session is killed",
    beforeOutage,
  );
  killSession();
  const beforeThaw = viewer.events.length;
  thaw();
  const exited = await viewer.waitForEvent(
    isState(exitedSessionId, "ended"),
    BUDGETS.resumeMs,
    "the resumed session reporting how it ended",
    beforeThaw,
  );
  if (exited.reason !== "session-exited") {
    fail(
      `the session ended as ${exited.reason}; the host outlived it and recorded the exit, ` +
        "so session-exited is the only reason it has evidence for",
    );
  }
  log(`phase 3: ended as session-exited${exited.exit ? ` with exit ${JSON.stringify(exited.exit)}` : ""}`);

  // A host that gets to say goodbye is distinguishable from one that vanishes;
  // that difference is the whole point of the shutdown frame.
  log("phase 3: a host that shuts down cleanly");
  await newSession();
  const shutdownSessionId = await openAndAttach(state, viewer, "phase3-shutdown-view");
  const beforeShutdown = viewer.events.length;
  const stopped = await stopHost();
  if (!stopped.exitedOnSigterm) {
    fail("the host had to be killed, so it never had the chance to announce a shutdown");
  }
  const goodbye = await viewer.waitForEvent(
    isState(shutdownSessionId, "ended"),
    BUDGETS.outageDetectedMs,
    "the session ending on host shutdown",
    beforeShutdown,
  );
  if (goodbye.reason !== "host-shutdown") {
    fail(`the session ended as ${goodbye.reason}, but the host announced a shutdown before leaving`);
  }
  log("phase 3: ended as host-shutdown");
}

async function main() {
  const state = options.reuse ? readState() : await up();
  if (!state) fail("no fixture is running; drop --reuse or run `node scripts/truffle-fixture.mjs up`");
  log(`fixture ready: host ${state.host.deviceId} instance ${state.host.hostInstanceId}`);

  const viewer = await openControl(state.viewer.controlSocket, state.viewer.token);
  let sessionId;
  try {
    if (viewer.hello.protocolMinor < REMOTE_LIFECYCLE_PROTOCOL_MINOR) {
      fail(
        `the viewer daemon negotiated minor ${viewer.hello.protocolMinor}; ` +
          `the remote lifecycle surface needs ${REMOTE_LIFECYCLE_PROTOCOL_MINOR}`,
      );
    }

    const hosts = await viewer.request({ type: "list-remote-hosts" });
    const host = hosts.hosts?.find((candidate) => candidate.deviceId === state.host.deviceId);
    if (!host) fail(`the viewer no longer sees host ${state.host.deviceId}: ${JSON.stringify(hosts)}`);

    const remote = await viewer.request({ type: "list-remote-sessions", deviceId: host.deviceId });
    const shared = remote.sessions?.find((candidate) => candidate.sessionId === state.host.sessionId);
    if (!shared) fail(`host session ${state.host.sessionId} is not shared: ${JSON.stringify(remote)}`);
    if (!shared.attachable) fail(`host session ${state.host.sessionId} is not attachable`);

    const opened = await viewer.request({
      type: "open-remote-session",
      deviceId: host.deviceId,
      remoteSessionId: shared.sessionId,
      cols: 120,
      rows: 40,
    });
    if (opened.type !== "session-created") fail(`open-remote-session answered ${JSON.stringify(opened)}`);
    sessionId = opened.session.id;
    log(`opened remote session ${sessionId}`);

    const attached = await viewer.request({ type: "attach-session", sessionId, viewId: VIEW_ID });
    if (attached.type !== "view-attached") fail(`attach-session answered ${JSON.stringify(attached)}`);
    if (!Number.isSafeInteger(attached.attachmentEpoch)) fail(`attach returned no epoch: ${JSON.stringify(attached)}`);
    if (!Number.isSafeInteger(attached.viewStateSeq)) {
      fail(`a remote attach must carry viewStateSeq for the ordering fence: ${JSON.stringify(attached)}`);
    }
    log(`attached view ${VIEW_ID}: epoch ${attached.attachmentEpoch}, viewStateSeq ${attached.viewStateSeq}`);

    // A client that says hello after the session is open must be told the
    // session is remote; nothing else would tell a restored workspace.
    const late = await openControl(state.viewer.controlSocket, state.viewer.token);
    try {
      await late.waitForEvent(
        (event) => event.type === "remote-session-state-changed" && event.sessionId === sessionId,
        15_000,
        "the hello snapshot for an already-open remote session",
      );
      log("hello snapshot announced the open remote session");
    } finally {
      late.close();
    }

    // The same daemon, one minor lower, must hear none of it.
    const legacy = await openControl(state.viewer.controlSocket, state.viewer.token, {
      protocolMinor: REMOTE_LIFECYCLE_PROTOCOL_MINOR - 1,
    });
    try {
      await new Promise((resolveWait) => setTimeout(resolveWait, 2_000));
      const leaked = legacy.events.filter((event) =>
        ["remote-session-state-changed", "view-state-changed", "control-state"].includes(event.type),
      );
      if (leaked.length) fail(`a minor-11 client received gated events: ${JSON.stringify(leaked)}`);
      log(`minor ${REMOTE_LIFECYCLE_PROTOCOL_MINOR - 1} client received no lifecycle events, as gated`);
    } finally {
      legacy.close();
    }

    await viewer.waitForEvent(isState(sessionId, "live"), BUDGETS.resumeMs, "the session reaching live");
    log("session is live");

    // Every assertion below is about a *change*, so each one starts from the
    // transcript position its stimulus was applied at. Without the cursor a
    // stimulus that changed nothing still matches the state that preceded it.
    const beforeFreeze = viewer.events.length;
    log("freezing the host (SIGSTOP): a silent outage with the connection still open");
    const frozenAt = Date.now();
    freeze();
    await viewer.waitForEvent(
      isState(sessionId, "reconnecting"),
      BUDGETS.outageDetectedMs,
      "reconnecting after freeze",
      beforeFreeze,
    );
    const detectionMs = Date.now() - frozenAt;
    log(`viewer noticed the outage after ${(detectionMs / 1000).toFixed(1)}s`);
    if (PHASE3) {
      // Without a heartbeat this costs an advertisement TTL plus a probe —
      // roughly 25s, measured. A heartbeat that pings at 3s idle and gives up
      // at 6s should land far below that. The bound is deliberately loose: the
      // claim worth defending is "seconds, not tens of seconds", and pinning
      // the exact number would make a slow CI machine look like a regression.
      if (detectionMs > 15_000) {
        fail(
          `the outage took ${(detectionMs / 1000).toFixed(1)}s to notice; ` +
            "with a heartbeat this should be seconds, not an advertisement TTL",
        );
      }
    }

    const backoff = await viewer.waitForEvent(
      (event) =>
        isState(sessionId, "reconnecting")(event) && event.attempt >= 1 && typeof event.nextRetryMs === "number",
      BUDGETS.outageDetectedMs,
      "a reconnecting event carrying backoff fields",
      beforeFreeze,
    );
    if (backoff.nextRetryMs < 0 || backoff.nextRetryMs > 10_000) {
      fail(`nextRetryMs ${backoff.nextRetryMs} is outside the documented full-jitter ceiling of 10s`);
    }
    if (typeof backoff.lastContactMs !== "number" || backoff.lastContactMs < 0) {
      fail(`a reconnecting session must report how long since contact, got ${backoff.lastContactMs}`);
    }
    log(
      `backoff reported: attempt ${backoff.attempt}, nextRetryMs ${backoff.nextRetryMs}, ` +
        `lastContactMs ${backoff.lastContactMs}`,
    );

    const beforeThaw = viewer.events.length;
    log("thawing the host (SIGCONT)");
    const thawedAt = Date.now();
    thaw();
    // No manual reconnect-remote-session anywhere in this test: recovering
    // without being asked is the feature, and calling it by hand would hide
    // its absence.
    await viewer.waitForEvent(isState(sessionId, "live"), BUDGETS.resumeMs, "the session resuming to live", beforeThaw);
    const resumedAt = Date.now();
    log(
      "session resumed to live with no manual retry — " +
        `${((resumedAt - thawedAt) / 1000).toFixed(1)}s after thaw, ` +
        `${((resumedAt - frozenAt) / 1000).toFixed(1)}s of outage end to end`,
    );

    const beforeRestart = viewer.events.length;
    log("restarting the host: same device, new instance");
    const restarted = await restartHost();
    log(`host instance ${restarted.previousInstanceId} -> ${restarted.hostInstanceId}`);
    const ended = await viewer.waitForEvent(
      isState(sessionId, "ended"),
      BUDGETS.restartMs,
      "the session ending",
      beforeRestart,
    );
    if (ended.reason !== "host-restarted") {
      fail(`the session ended as ${ended.reason}, but the host restart is evidence for host-restarted`);
    }
    log("session ended as host-restarted");

    console.log(`\n${transcript(viewer, sessionId)}`);
    await phase3Scenarios(state, viewer);
    console.log("\ntruffle reconnect e2e: PASS");
  } catch (error) {
    if (sessionId) console.error(`\n${transcript(viewer, sessionId)}`);
    // A fixture that changed underneath this run explains every symptom a
    // daemon fault would, and looks identical from here: sockets close
    // cleanly, nothing is logged. Say so rather than let the run indict the
    // daemon for someone else's teardown.
    const now = readState();
    if (!now || now.runId !== state.runId) {
      throw new Error(
        `the fixture this run started (${state.runId}) was ${now ? `replaced by ${now.runId}` : "torn down"} ` +
          "while it was running — another process is driving the same fixture. " +
          `Set GHOSTTEA_FIXTURE_ID to work on an isolated one. Original failure: ${error.message}`,
        { cause: error },
      );
    }
    throw error;
  } finally {
    viewer.close();
  }
}

try {
  await main();
} catch (error) {
  console.error(`\ntruffle reconnect e2e: FAIL — ${error.message}`);
  process.exitCode = 1;
} finally {
  if (!options.keep && !options.reuse) {
    down();
    console.log("fixture stopped");
  }
}
