import { randomBytes } from "node:crypto";
import { createConnection } from "node:net";
import { join } from "node:path";

/**
 * Local IPC endpoints for one `ghosttead` instance.
 *
 * This mirrors `localEndpoints` in `@vibecook/ghosttea-electron`. The published
 * package cannot be imported from the repository's own harnesses, so the naming
 * rule is stated in both places: a socket file per channel on Unix, and a named
 * pipe per channel on Windows, where names share one machine-wide namespace and
 * therefore need an instance suffix.
 */
export function localEndpoints(runtimeDirectory) {
  if (process.platform === "win32") {
    const instance = `${process.pid}-${randomBytes(8).toString("hex")}`;
    return {
      controlSocket: `\\\\.\\pipe\\ghosttea-${instance}-control`,
      frameSocket: `\\\\.\\pipe\\ghosttea-${instance}-frames`,
    };
  }
  return {
    controlSocket: join(runtimeDirectory, "control.sock"),
    frameSocket: join(runtimeDirectory, "frames.sock"),
  };
}

/** Whether an endpoint outlives the process that bound it. */
export function endpointPersists() {
  return process.platform !== "win32";
}

/**
 * Windows raises `EBUSY` while every pipe instance is taken, which lasts as
 * long as the service takes to serve the clients ahead of this one.
 */
export const BUSY_CODE = "EBUSY";
/**
 * `ENOENT` means the name is unpublished. That is momentary while the service
 * replaces the instance it just handed out, but it is also what a service that
 * is not running looks like, so it only earns a short grace: retrying it for
 * the caller's whole budget would turn "nothing is listening" into a hang that
 * reports the same error much later.
 */
export const MISSING_CODE = "ENOENT";
export const MISSING_GRACE_MS = 250;
const RETRY_INTERVAL_MS = 5;

/**
 * Connect, waiting for a free pipe instance on Windows.
 *
 * This repeats `openEndpoint` from `@vibecook/ghosttea-client`, which the
 * harnesses cannot import because they run without a built SDK. The two are
 * held together by `retries-match-the-published-client` in the tests beside
 * this file.
 */
export function openEndpoint(path, deadline, platform = process.platform) {
  const missingDeadline = Math.min(deadline, Date.now() + MISSING_GRACE_MS);
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const socket = createConnection(path);
      const onConnect = () => {
        socket.off("error", onError);
        resolve(socket);
      };
      const onError = (error) => {
        socket.off("connect", onConnect);
        socket.destroy();
        const until = error.code === BUSY_CODE ? deadline : error.code === MISSING_CODE ? missingDeadline : 0;
        if (platform === "win32" && Date.now() + RETRY_INTERVAL_MS < until) {
          setTimeout(attempt, RETRY_INTERVAL_MS);
          return;
        }
        reject(error);
      };
      socket.once("connect", onConnect);
      socket.once("error", onError);
    };
    attempt();
  });
}
