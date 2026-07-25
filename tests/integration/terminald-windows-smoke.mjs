/**
 * Windows session lifecycle over named pipes.
 *
 * `terminald-smoke.mjs` remains the deeper fixture, but it drives POSIX shells
 * throughout: it types `printf` commands to emit escape sequences and asserts
 * signal semantics that Windows has no equivalent for, so it is a rewrite
 * rather than a path substitution. This covers the ground that behaves
 * differently on Windows and that has actually broken here — pipe transport,
 * ConPTY exit reporting, and process-tree termination — against a real daemon.
 */
import { execFileSync } from "node:child_process";
import { GhostteaAutomationClient } from "@vibecook/ghosttea-client";
import { TerminaldHarness } from "../../bench/lib/terminald-client.mjs";
import { cleanEnvironment, printAndExitArgs, shellExecutable } from "../../bench/lib/shell-fixture.mjs";

if (process.platform !== "win32") {
  console.log("SKIP terminald windows smoke: this fixture is Windows-specific");
  process.exit(0);
}

// Nothing earlier in the gate guarantees a built daemon: `cargo test` compiles
// test binaries rather than installing this one. Without it the harness falls
// back to building a release profile from scratch inside its own startup
// timeout, which passes locally on a warm tree and times out on a cold runner.
execFileSync("cargo", ["build", "--package", "ghosttead", "--locked"], { stdio: "inherit" });

function powershell(script) {
  return execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
  }).trim();
}

const isRunning = (pid) =>
  powershell(`if (Get-Process -Id ${pid} -EA SilentlyContinue) { 'yes' } else { 'no' }`) === "yes";

const childrenOf = (pid) =>
  powershell(`(Get-CimInstance Win32_Process -Filter 'ParentProcessId=${pid}').ProcessId`)
    .split(/\r?\n/)
    .map((line) => Number(line.trim()))
    .filter(Boolean);

async function until(predicate, what, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`timed out waiting for ${what}`);
}

const sessionInRegistry = async (harness, id) => {
  const response = await harness.request("list-sessions");
  if (response.type !== "sessions") throw new Error("unexpected list-sessions response");
  return response.sessions.some((session) => session.id === id);
};

const harness = await TerminaldHarness.start();
// `harness.request` consumes the control stream, so exit events are observed on
// a separate connection.
const automation = new GhostteaAutomationClient(harness.connection);
try {
  if (!harness.pid) throw new Error("this fixture requires a directly spawned ghosttead process");

  // Terminal output reaches a subscribed frame channel over the named pipe.
  const marker = "ghosttea-windows-smoke";
  const printed = await harness.createAttachedSession({
    executable: shellExecutable,
    args: printAndExitArgs(marker),
    persistence: "keep-until-exit",
  });
  await harness.waitForMarker(printed.handle, marker);
  console.log("ok  terminal output reached the frame channel");

  // ConPTY holds its output pipe open after the child exits, so the daemon has
  // to notice the exit itself. Without that the session never leaves the
  // registry and its exit code is never reported.
  await until(async () => !(await sessionInRegistry(harness, printed.id)), "the session to leave the registry");
  console.log("ok  a naturally exited session left the registry");

  // A non-zero status must survive the same path.
  const failing = await harness.createAttachedSession({
    executable: shellExecutable,
    args: ["/d", "/c", "exit 7"],
    persistence: "keep-until-exit",
  });
  const exitEvent = await automation.waitForExit(failing.id, 20_000);
  if (exitEvent.exitCode !== 7) throw new Error(`expected exit code 7, saw ${JSON.stringify(exitEvent)}`);
  // A non-zero status nobody asked for is classified as a crash.
  if (exitEvent.exitOutcome !== "crashed") throw new Error(`unexpected outcome ${exitEvent.exitOutcome}`);
  console.log("ok  a failing session reported its exit code");

  // Terminating must reach what the session started, not just the shell.
  const tree = await harness.createAttachedSession({
    executable: shellExecutable,
    args: ["/d", "/c", "ping", "-n", "60", "127.0.0.1"],
    persistence: "keep-until-exit",
  });
  let grandchild;
  await until(() => {
    grandchild = childrenOf(tree.pid)[0];
    return Boolean(grandchild);
  }, "the session to start a grandchild");
  await harness.terminate(tree.id);
  await until(() => !isRunning(grandchild), "the grandchild to be swept");
  if (isRunning(tree.pid)) throw new Error("the session shell outlived termination");
  console.log("ok  terminating a session swept its whole process tree");

  // Clean mode must not leak the service's own credentials into a child.
  const isolated = await harness.createAttachedSession({
    executable: shellExecutable,
    args: ["/d", "/c", "echo token=[%GHOSTTEA_AUTH_TOKEN%]"],
    environment: cleanEnvironment(),
    persistence: "keep-until-exit",
  });
  // cmd leaves an unset variable as its own literal name.
  await harness.waitForMarker(isolated.handle, "token=[%GHOSTTEA_AUTH_TOKEN%]");
  console.log("ok  a clean session did not inherit the service auth token");

  console.log("terminald windows smoke passed");
} finally {
  automation.dispose();
  harness.dispose();
}
