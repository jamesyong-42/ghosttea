import { createConnection, type Socket } from "node:net";
import { isMainToBridgeMessage } from "../shared/terminal-ipc";

const parentPort = process.parentPort;

const MAX_CONTROL_BYTES = 1024 * 1024;
const MAX_FRAME_BYTES = 16 * 1024 * 1024;

function packet(bytes: Uint8Array): Buffer {
  const output = Buffer.allocUnsafe(4 + bytes.byteLength);
  output.writeUInt32LE(bytes.byteLength, 0);
  output.set(bytes, 4);
  return output;
}

function connectSocket(path: string, token: string, limit: number, onPacket: (bytes: Buffer) => void): Promise<Socket> {
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

async function attachRenderer(rawData: unknown, ports: Electron.MessagePortMain[]): Promise<void> {
  const [controlPort, framePort] = ports;
  if (!isMainToBridgeMessage(rawData) || !controlPort || !framePort) throw new Error("invalid bridge bootstrap");
  const data = rawData;

  let controlSocket: Socket | undefined;
  let frameSocket: Socket | undefined;
  try {
    controlSocket = await connectSocket(
      data.connection.controlSocket,
      data.connection.authToken,
      MAX_CONTROL_BYTES,
      (bytes) => {
        try {
          controlPort.postMessage(JSON.parse(bytes.toString("utf8")));
        } catch (cause) {
          const error = cause instanceof Error ? cause : new Error(String(cause));
          controlPort.postMessage({
            requestId: 0,
            type: "bridge-error",
            message: `Invalid terminald response: ${error.message}`,
          });
          controlSocket?.destroy();
        }
      },
    );
    frameSocket = await connectSocket(
      data.connection.frameSocket,
      data.connection.authToken,
      MAX_FRAME_BYTES,
      (bytes) => {
        const transferable = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
        framePort.postMessage(transferable);
      },
    );
  } catch (error) {
    controlSocket?.destroy();
    frameSocket?.destroy();
    throw error;
  }

  controlPort.on("message", ({ data: command }) => {
    try {
      const encoded = Buffer.from(JSON.stringify(command));
      if (encoded.byteLength > MAX_CONTROL_BYTES) throw new Error("control packet exceeds quota");
      controlSocket.write(packet(encoded));
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      controlPort.postMessage({ requestId: 0, type: "bridge-error", message: error.message });
    }
  });
  controlPort.once("close", () => controlSocket.destroy());
  framePort.once("close", () => frameSocket.destroy());
  controlPort.start();
  framePort.start();
}

parentPort.on("message", (event) => {
  void attachRenderer(event.data, event.ports).catch((cause) => {
    const error = cause instanceof Error ? cause : new Error(String(cause));
    console.error(`[terminal-bridge] ${error.stack ?? error.message}`);
    event.ports[0]?.postMessage({ requestId: 0, type: "bridge-error", message: error.message });
  });
});
