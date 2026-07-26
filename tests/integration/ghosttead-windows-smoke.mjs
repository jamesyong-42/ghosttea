/**
 * Windows session lifecycle over named pipes.
 *
 * `ghosttead-smoke.mjs` remains the deeper fixture, but it drives POSIX shells
 * throughout: it types `printf` commands to emit escape sequences and asserts
 * signal semantics that Windows has no equivalent for, so it is a rewrite
 * rather than a path substitution. This covers the ground that behaves
 * differently on Windows and that has actually broken here — pipe transport,
 * ConPTY exit reporting, and process-tree termination — against a real daemon.
 */
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { GhostteaAutomationClient } from "@vibecook/ghosttea-client";
import { GhostteadHarness } from "../../bench/lib/ghosttead-client.mjs";
import { cleanEnvironment, printAndExitArgs, shellExecutable } from "../../bench/lib/shell-fixture.mjs";

if (process.platform !== "win32") {
  console.log("SKIP ghosttead windows smoke: this fixture is Windows-specific");
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

// Each check shells out to PowerShell, so poll sparingly.
async function until(predicate, what, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/**
 * Wait for a marker, and say what the session was doing if it never arrives.
 *
 * A bare marker timeout cannot distinguish a child that never started, one that
 * exited immediately, and one that ran but printed nothing — and none of those
 * are visible from the machine that wrote the test.
 */
async function expectMarker(harness, session, marker) {
  try {
    await harness.waitForMarker(session.handle, marker);
  } catch (cause) {
    const listed = await harness.request("list-sessions");
    const alive = listed.sessions?.some((entry) => entry.id === session.id);
    throw new Error(
      `never saw ${marker}; the session is ${alive ? "still running" : "gone from the registry, so its child exited"}`,
      { cause },
    );
  }
}

const sessionInRegistry = async (harness, id) => {
  const response = await harness.request("list-sessions");
  if (response.type !== "sessions") throw new Error("unexpected list-sessions response");
  return response.sessions.some((session) => session.id === id);
};

const harness = await GhostteadHarness.start();
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

  // ConPTY resizes a pseudoconsole rather than issuing TIOCSWINSZ, so the child
  // learns its size through a different mechanism than on Unix. Reading it back
  // from the child proves the resize arrived, which asserting on the session's
  // own record would not.
  //
  // The child reports its width on a loop rather than being asked, because
  // input typed before an interactive shell starts reading is lost, and that is
  // a property of the shell rather than of the resize being measured.
  const resized = await harness.createAttachedSession({
    // Named absolutely and given this platform's own search path rather than
    // the one this process inherited: the Windows gate runs its steps under
    // bash, whose PATH a Windows child cannot use.
    executable: join(process.env.SystemRoot ?? "C:\\Windows", "System32/WindowsPowerShell/v1.0/powershell.exe"),
    environment: cleanEnvironment(),
    args: [
      "-NoLogo",
      "-NoProfile",
      "-Command",
      'while ($true) { Write-Output "ghosttea-cols=$($Host.UI.RawUI.WindowSize.Width)"; Start-Sleep -Milliseconds 250 }',
    ],
    cols: 80,
    rows: 24,
    persistence: "keep-until-exit",
  });
  // Starts at 80, so the resized width only appears if the resize propagated.
  await expectMarker(harness, resized, "ghosttea-cols=80");
  // Resizing is refused without control authority, which a real view claims
  // when it takes focus.
  await harness.claimControl(resized.id, 80, 24);
  await harness.resize(resized.id, 132, 40);
  await expectMarker(harness, resized, "ghosttea-cols=132");
  console.log("ok  a resize reached the child through the pseudoconsole");
  await harness.terminate(resized.id);

  // ConPTY buffers on its own terms, so a burst large enough to fill it is a
  // different path from the steady output above. The marker after the burst is
  // the assertion: it only arrives if nothing stalled behind the flood.
  const flooded = await harness.createAttachedSession({
    executable: shellExecutable,
    args: ["/d", "/c", "(for /l %i in (1,1,500) do @echo ghosttea-flood-%i) & echo ghosttea-flood-done"],
    persistence: "keep-until-exit",
  });
  await expectMarker(harness, flooded, "ghosttea-flood-done");
  console.log("ok  a 500-line burst drained without stalling");

  console.log("ghosttead windows smoke passed");
} finally {
  automation.dispose();
  harness.dispose();
}
