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
 * Windows raises these while the service has no idle pipe instance to offer:
 * `EBUSY` when every instance is taken and `ENOENT` in the moment between one
 * instance being handed to a client and its replacement being created.
 */
const RETRYABLE_WINDOWS_CODES = new Set(["EBUSY", "ENOENT"]);
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
        const retryable = platform === "win32" && RETRYABLE_WINDOWS_CODES.has(error.code ?? "");
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
