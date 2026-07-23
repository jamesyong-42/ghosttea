import { createConnection, type Socket } from "node:net";

export function packet(bytes: Uint8Array): Buffer {
  const output = Buffer.allocUnsafe(4 + bytes.byteLength);
  output.writeUInt32LE(bytes.byteLength, 0);
  output.set(bytes, 4);
  return output;
}

export function connectSocket(
  path: string,
  token: string,
  limit: number,
  onPacket: (bytes: Buffer) => void,
  onDisconnect: (error: Error) => void,
): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path);
    let buffered = Buffer.alloc(0);
    let authenticated = false;
    let settled = false;
    socket.on("error", (error) => {
      if (!settled) {
        settled = true;
        reject(error);
      } else {
        console.error(`[terminal-bridge] socket error at ${path}: ${error.message}`);
        onDisconnect(error);
      }
    });
    socket.on("close", () => {
      if (!settled) {
        settled = true;
        reject(new Error(`terminald connection closed during authentication at ${path}`));
      } else if (authenticated) {
        onDisconnect(new Error(`terminald connection closed at ${path}`));
      }
    });
    socket.on("connect", () => socket.write(packet(Buffer.from(token))));
    socket.on("data", (chunk) => {
      const incoming = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      buffered = Buffer.concat([buffered, incoming]);
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
            socket.destroy();
            reject(new Error("terminald authentication failed"));
            return;
          }
          authenticated = true;
          settled = true;
          resolve(socket);
        } else {
          onPacket(body);
        }
      }
    });
  });
}
