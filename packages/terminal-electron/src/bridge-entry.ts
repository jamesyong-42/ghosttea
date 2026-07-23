import type { Socket } from "node:net";
import { connectSocket, packet } from "./bridge-socket.js";
import { isMainToBridgeMessage } from "./types.js";

const parentPort = process.parentPort;

const MAX_CONTROL_BYTES = 1024 * 1024;
const MAX_FRAME_BYTES = 16 * 1024 * 1024;
const MAX_FRAME_SUBSCRIPTION_BYTES = 1024 * 1024;

async function attachRenderer(rawData: unknown, ports: Electron.MessagePortMain[]): Promise<void> {
  const [controlPort, framePort] = ports;
  if (!isMainToBridgeMessage(rawData) || !controlPort || !framePort) throw new Error("invalid bridge bootstrap");
  const data = rawData;

  let controlSocket: Socket | undefined;
  let frameSocket: Socket | undefined;
  let rendererClosed = false;
  let connectionLost = false;
  const reportConnectionLost = (cause: unknown): void => {
    if (rendererClosed || connectionLost) return;
    connectionLost = true;
    const error = cause instanceof Error ? cause : new Error(String(cause));
    controlPort.postMessage({ requestId: 0, type: "bridge-error", message: error.message });
    parentPort.postMessage({ type: "connection-lost", message: error.message });
    controlSocket?.destroy();
    frameSocket?.destroy();
  };
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
      reportConnectionLost,
    );
    frameSocket = await connectSocket(
      data.connection.frameSocket,
      data.connection.authToken,
      MAX_FRAME_BYTES,
      (bytes) => {
        const transferable = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
        framePort.postMessage(transferable);
      },
      reportConnectionLost,
    );
  } catch (error) {
    controlSocket?.destroy();
    frameSocket?.destroy();
    connectionLost = true;
    const message = error instanceof Error ? error.message : String(error);
    parentPort.postMessage({ type: "connection-lost", message });
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
  framePort.on("message", ({ data: subscription }) => {
    try {
      const encoded = Buffer.from(JSON.stringify(subscription));
      if (encoded.byteLength > MAX_FRAME_SUBSCRIPTION_BYTES) throw new Error("frame subscription exceeds quota");
      frameSocket.write(packet(encoded));
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      controlPort.postMessage({ requestId: 0, type: "bridge-error", message: error.message });
    }
  });
  const closeForRenderer = (): void => {
    rendererClosed = true;
    controlSocket.destroy();
    frameSocket.destroy();
  };
  controlPort.once("close", closeForRenderer);
  framePort.once("close", closeForRenderer);
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
