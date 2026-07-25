import { randomBytes } from "node:crypto";
import { createConnection, type Socket } from "node:net";
import { join } from "node:path";

export interface LocalEndpoints {
  controlSocket: string;
  frameSocket: string;
}

/**
 * Local IPC endpoints for one service instance.
 *
 * Unix hosts bind one socket file per channel inside the private runtime
 * directory, so the directory's permissions scope both channels. Windows has no
 * filesystem socket that `node:net` can dial, so each channel is a named pipe.
 * Pipe names share one flat, machine-wide namespace rather than sitting under a
 * private directory, so each name carries its own instance suffix and the
 * service refuses to bind a name that already exists.
 */
export function localEndpoints(runtimeDirectory: string, platform: NodeJS.Platform = process.platform): LocalEndpoints {
  if (platform === "win32") {
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

/**
 * Whether an endpoint persists after the process that bound it exits.
 *
 * A Unix-domain socket outlives its process and has to be unlinked before a
 * rebind. Windows reclaims a pipe name once its last handle closes.
 */
export function endpointPersists(platform: NodeJS.Platform = process.platform): boolean {
  return platform !== "win32";
}

/**
 * Windows raises `EBUSY` while every pipe instance is taken, which lasts as
 * long as the service takes to serve the clients ahead of this one.
 */
const BUSY_CODE = "EBUSY";
/**
 * `ENOENT` means the name is unpublished. That is momentary while the service
 * replaces the instance it just handed out, but it is also what a service that
 * is not running looks like, so it only earns a short grace: retrying it for
 * the caller's whole budget would turn "nothing is listening" into a hang that
 * reports the same error much later.
 */
const MISSING_CODE = "ENOENT";
const MISSING_GRACE_MS = 250;
const RETRY_INTERVAL_MS = 5;

/**
 * Connect to a local endpoint, waiting for a free pipe instance on Windows.
 *
 * A named pipe server can only offer one instance at a time, so simultaneous
 * clients — the control and frame channels opening together, or an application
 * holding several control connections — must expect to wait. Unix sockets
 * queue in the kernel and never take this path.
 */
export function openEndpoint(
  path: string,
  deadline: number,
  platform: NodeJS.Platform = process.platform,
): Promise<Socket> {
  const missingDeadline = Math.min(deadline, Date.now() + MISSING_GRACE_MS);
  return new Promise((resolve, reject) => {
    const attempt = (): void => {
      const socket = createConnection(path);
      const onConnect = (): void => {
        socket.off("error", onError);
        resolve(socket);
      };
      const onError = (error: NodeJS.ErrnoException): void => {
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
