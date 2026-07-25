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
 * Windows raises these while the service has no idle pipe instance to offer:
 * `EBUSY` when every instance is taken, and `ENOENT` in the moment between one
 * instance being handed to a client and its replacement being created.
 */
const RETRYABLE_WINDOWS_CODES = new Set(["EBUSY", "ENOENT"]);
const RETRY_INTERVAL_MS = 5;

/** Connect, waiting for a free pipe instance on Windows. */
export function openEndpoint(path, deadline) {
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
        const retryable = process.platform === "win32" && RETRYABLE_WINDOWS_CODES.has(error.code ?? "");
        if (retryable && Date.now() + RETRY_INTERVAL_MS < deadline) {
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
