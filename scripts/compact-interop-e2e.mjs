#!/usr/bin/env node
/**
 * The cross-language compact interop run.
 *
 * Builds and starts the Rust loopback compact host, then runs the Swift client's
 * interop tests against it over a real TCP socket. The two implementations meet
 * on the wire rather than each meeting its own idea of the wire, which is the
 * only thing that can catch the class of bug where both sides are internally
 * consistent and disagree with each other.
 *
 * No tailnet, no auth key, no `.env`: the fixture binds 127.0.0.1 on an
 * OS-assigned port. What that costs is stated at `serve_compact_loopback` — the
 * Tailscale WhoIs prologue cannot run here, so identity binding stays proven
 * only by the tailnet e2e, and everything from the client hello onward is the
 * production path.
 *
 * Before handing over to `swift test` this dials the fixture itself and
 * completes a hello and an attach. That check exists so a failure arrives
 * already attributed: if the smoke client cannot attach, the fault is the Rust
 * host or the fixture wiring, and the Swift run that follows would only have
 * reported the same thing less clearly.
 *
 *   node scripts/compact-interop-e2e.mjs           run it
 *   node scripts/compact-interop-e2e.mjs --smoke   fixture + smoke check only
 */
import { spawn, spawnSync } from "node:child_process";
import { connect } from "node:net";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const READY_PREFIX = "GHOSTTEA_COMPACT_INTEROP_READY ";
const smokeOnly = process.argv.includes("--smoke");

const MAGIC = Buffer.from("TSP1");
const PROTOCOL_MAJOR = 1;
const PROTOCOL_MINOR = 6;
const STREAM_KIND_SESSION_CONTROL = 2;
const CHANNEL_CONTROL = 1;
const CHANNEL_STATE = 2;

function fail(message) {
  console.error(`[compact-interop] ${message}`);
  process.exitCode = 1;
}

/** `[u32 len][json]` — the framing every non-channel message uses. */
function encodeMessage(value) {
  const payload = Buffer.from(JSON.stringify(value));
  const header = Buffer.alloc(4);
  header.writeUInt32BE(payload.length);
  return Buffer.concat([header, payload]);
}

/** `[u32 len][channel][json]` — the compact multiplexed framing. */
function encodeCompact(channel, value) {
  const payload = Buffer.from(JSON.stringify(value));
  const header = Buffer.alloc(5);
  header.writeUInt32BE(payload.length + 1);
  header.writeUInt8(channel, 4);
  return Buffer.concat([header, payload]);
}

function encodePreface(preface) {
  const metadata = Buffer.from(JSON.stringify(preface));
  const header = Buffer.alloc(16);
  MAGIC.copy(header, 0);
  header.writeUInt16BE(PROTOCOL_MAJOR, 4);
  header.writeUInt16BE(PROTOCOL_MINOR, 6);
  header.writeUInt8(STREAM_KIND_SESSION_CONTROL, 8);
  header.writeUInt32BE(metadata.length, 12);
  return Buffer.concat([header, metadata]);
}

/**
 * Reads length-prefixed frames off a socket, one awaited frame at a time.
 *
 * A read has to be satisfiable from bytes that arrived before it was issued —
 * the host sends its opening burst without being asked, so by the time anything
 * here awaits a frame, several are usually already buffered.
 */
function framer(socket) {
  let buffered = Buffer.alloc(0);
  let closed = null;
  const waiters = [];

  const takeFrame = () => {
    if (buffered.length < 4) return null;
    const length = buffered.readUInt32BE(0);
    if (buffered.length < 4 + length) return null;
    const frame = Buffer.from(buffered.subarray(4, 4 + length));
    buffered = buffered.subarray(4 + length);
    return frame;
  };
  const drain = () => {
    while (waiters.length > 0) {
      const frame = takeFrame();
      if (!frame) break;
      waiters.shift().settle(frame, null);
    }
    if (closed) waiters.splice(0).forEach((w) => w.settle(null, closed));
  };

  socket.on("data", (chunk) => {
    buffered = Buffer.concat([buffered, chunk]);
    drain();
  });
  socket.on("error", (error) => {
    closed = error;
    drain();
  });
  socket.on("close", () => {
    closed = closed ?? new Error("host closed the connection");
    drain();
  });

  return () =>
    new Promise((ok, no) => {
      const ready = takeFrame();
      if (ready) return ok(ready);
      if (closed) return no(closed);
      const timer = setTimeout(() => {
        const at = waiters.findIndex((w) => w.timer === timer);
        if (at >= 0) waiters.splice(at, 1);
        no(new Error("timed out reading a frame"));
      }, 10_000);
      waiters.push({
        timer,
        settle: (frame, error) => {
          clearTimeout(timer);
          if (error) no(error);
          else ok(frame);
        },
      });
    });
}

/**
 * Hello, attach, and read until the session's own output shows up. Proves the
 * fixture serves the real protocol, not merely that something is listening.
 */
async function smokeCheck({ port, sessionId, deviceId }) {
  const socket = connect({ host: "127.0.0.1", port });
  await new Promise((ok, no) => {
    socket.once("connect", ok);
    socket.once("error", no);
  });
  const nextFrame = framer(socket);
  try {
    socket.write(
      encodePreface({ streamKind: "session-control", sessionId, viewId: "pane-1" }),
    );
    socket.write(
      encodeMessage({
        type: "client-hello",
        protocolMajor: PROTOCOL_MAJOR,
        protocolMinor: PROTOCOL_MINOR,
        hostInstanceId: "",
        localDeviceId: deviceId,
        nonce: "smoke-nonce",
        stateCodecs: ["compact-json-v1"],
      }),
    );
    const hello = JSON.parse((await nextFrame()).toString());
    if (hello.type !== "server-hello") throw new Error(`expected a server hello, got ${hello.type}`);
    if (hello.protocolMinor !== PROTOCOL_MINOR) {
      throw new Error(`host negotiated minor ${hello.protocolMinor}, expected ${PROTOCOL_MINOR}`);
    }

    socket.write(
      encodeCompact(CHANNEL_CONTROL, {
        type: "attach-view",
        requestId: "smoke-1",
        sessionId,
        viewId: "r:pane-1",
        accessToken: null,
        cols: 80,
        rows: 24,
        attachGeneration: 1,
        wantsState: true,
      }),
    );

    // The frames the host sends carry their channel in the first byte.
    let attached = null;
    let sawSessionOutput = false;
    for (let i = 0; i < 40 && !(attached && sawSessionOutput); i += 1) {
      const frame = await nextFrame();
      const channel = frame.readUInt8(0);
      const body = JSON.parse(frame.subarray(1).toString());
      if (channel === CHANNEL_CONTROL) {
        if (body.type === "attach-rejected") {
          throw new Error(`host refused the attach: ${body.code}`);
        }
        if (body.type === "view-attached") attached = body;
      } else if (channel === CHANNEL_STATE) {
        if (JSON.stringify(body).includes("interop-line-1")) sawSessionOutput = true;
      }
    }
    if (!attached) throw new Error("host never answered the attach");
    if (!attached.readWrite) throw new Error("the attach came back read-only; control rows would fail");
    if (!sawSessionOutput) throw new Error("attached, but the session's output never arrived");
    return attached;
  } finally {
    socket.destroy();
  }
}

function buildFixture() {
  const built = spawnSync(
    "cargo",
    [
      "build",
      "-p",
      "ghosttea-truffle",
      "--features",
      "interop-fixture",
      "--bin",
      "compact-interop-host",
    ],
    { cwd: resolve(root, "native/ghosttea"), stdio: "inherit" },
  );
  if (built.status !== 0) throw new Error("could not build the compact interop fixture");
}

function startFixture() {
  const fixture = spawn(resolve(root, "target/debug/compact-interop-host"), {
    cwd: root,
    stdio: ["ignore", "pipe", "inherit"],
  });
  return new Promise((ok, no) => {
    let stdout = "";
    const timer = setTimeout(
      () => no(new Error("the fixture never announced itself")),
      30_000,
    );
    fixture.stdout.on("data", (chunk) => {
      stdout += chunk;
      const line = stdout.split("\n").find((l) => l.startsWith(READY_PREFIX));
      if (!line) return;
      clearTimeout(timer);
      ok({ fixture, ...JSON.parse(line.slice(READY_PREFIX.length)) });
    });
    fixture.once("exit", (code) => {
      clearTimeout(timer);
      no(new Error(`the fixture exited before announcing itself (code ${code})`));
    });
  });
}

let started;
try {
  buildFixture();
  started = await startFixture();
  console.log(
    `[compact-interop] fixture up on 127.0.0.1:${started.port}, session ${started.sessionId}`,
  );

  const attached = await smokeCheck(started);
  console.log(
    `[compact-interop] smoke check attached at epoch ${attached.attachmentEpoch} and saw session output`,
  );

  if (smokeOnly) {
    console.log("[compact-interop] --smoke: stopping before the Swift run");
  } else {
    const swift = spawnSync(
      "swift",
      [
        "test",
        "--disable-sandbox",
        "--package-path",
        "apple/GhostteaKit",
        "--filter",
        "GhostteaCompactInteropTests",
      ],
      {
        cwd: root,
        stdio: "inherit",
        env: {
          ...process.env,
          DEVELOPER_DIR: process.env.DEVELOPER_DIR ?? "/Applications/Xcode.app/Contents/Developer",
          GHOSTTEA_COMPACT_INTEROP_PORT: String(started.port),
          GHOSTTEA_COMPACT_INTEROP_SESSION: started.sessionId,
          GHOSTTEA_COMPACT_INTEROP_DEVICE: started.deviceId,
          GHOSTTEA_COMPACT_INTEROP_PID: String(started.pid),
        },
      },
    );
    if (swift.status !== 0) fail("the Swift interop tests failed");
    else console.log("[compact-interop] swift interop tests passed");
  }
} catch (error) {
  fail(error.message);
} finally {
  if (started?.fixture) {
    // SIGTERM rather than SIGKILL: the fixture announces its shutdown on the
    // way out, which is the drain path and the last thing worth exercising.
    started.fixture.kill("SIGTERM");
  }
}
