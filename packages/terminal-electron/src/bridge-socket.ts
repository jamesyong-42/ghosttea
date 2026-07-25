import { type Socket } from "node:net";
import { openEndpoint } from "@vibecook/ghosttea-client";

export function packet(bytes: Uint8Array): Buffer {
  const output = Buffer.allocUnsafe(4 + bytes.byteLength);
  output.writeUInt32LE(bytes.byteLength, 0);
  output.set(bytes, 4);
  return output;
}

export async function connectSocket(
  path: string,
  token: string,
  limit: number,
  onPacket: (bytes: Buffer) => void,
  onDisconnect: (error: Error) => void,
  timeoutMs = 10_000,
): Promise<Socket> {
  // One budget covers waiting for a free endpoint and authenticating on it.
  const deadline = Date.now() + timeoutMs;
  const socket = await openEndpoint(path, deadline);
  return new Promise((resolve, reject) => {
    let buffered = Buffer.alloc(0);
    let draining = false;
    let authenticated = false;
    let settled = false;
    const timeout = setTimeout(
      () => {
        if (settled) return;
        settled = true;
        socket.destroy();
        reject(new Error(`terminald connection timed out during authentication at ${path}`));
      },
      Math.max(0, deadline - Date.now()),
    );
    socket.on("error", (error) => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        reject(error);
      } else {
        console.error(`[terminal-bridge] socket error at ${path}: ${error.message}`);
        onDisconnect(error);
      }
    });
    socket.on("close", () => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        reject(new Error(`terminald connection closed during authentication at ${path}`));
      } else if (authenticated) {
        onDisconnect(new Error(`terminald connection closed at ${path}`));
      }
    });
    // `openEndpoint` resolves only once connected, so authenticate now.
    socket.write(packet(Buffer.from(token)));
    const drainPackets = (): void => {
      if (draining || socket.isPaused()) return;
      draining = true;
      try {
        while (buffered.length >= 4) {
          const length = buffered.readUInt32LE(0);
          if (length > limit) {
            socket.destroy(new Error("terminald packet exceeds bridge quota"));
            return;
          }
          if (buffered.length < 4 + length) return;
          const body = buffered.subarray(4, 4 + length);
          buffered = buffered.subarray(4 + length);
          if (!authenticated) {
            if (body.toString() !== "ok") {
              settled = true;
              clearTimeout(timeout);
              socket.destroy();
              reject(new Error("terminald authentication failed"));
              return;
            }
            authenticated = true;
            settled = true;
            clearTimeout(timeout);
            resolve(socket);
          } else {
            onPacket(body);
          }
          if (socket.isPaused()) return;
        }
      } finally {
        draining = false;
      }
    };
    socket.on("resume", drainPackets);
    socket.on("data", (chunk) => {
      const incoming = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      buffered = Buffer.concat([buffered, incoming]);
      drainPackets();
    });
  });
}
