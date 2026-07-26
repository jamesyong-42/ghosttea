export const FRAME_IN_FLIGHT_HIGH_WATER_BYTES = 32 * 1024 * 1024;
export const FRAME_IN_FLIGHT_LOW_WATER_BYTES = 16 * 1024 * 1024;
export const FRAME_BRIDGE_CAPABILITY_VERSION = 1;

export interface FrameBridgeCapabilities {
  type: "bridge-capabilities";
  requestId: number;
  protocolVersion: typeof FRAME_BRIDGE_CAPABILITY_VERSION;
  frameCredits: true;
}

export function requestedFrameBridgeCapabilities(message: unknown): FrameBridgeCapabilities | undefined {
  if (!message || typeof message !== "object") return undefined;
  const candidate = message as { type?: unknown; requestId?: unknown; bridgeCapabilities?: unknown };
  if (
    candidate.type !== "subscribe" ||
    candidate.bridgeCapabilities !== FRAME_BRIDGE_CAPABILITY_VERSION ||
    !Number.isSafeInteger(candidate.requestId) ||
    Number(candidate.requestId) < 0
  )
    return undefined;
  return {
    type: "bridge-capabilities",
    requestId: Number(candidate.requestId),
    protocolVersion: FRAME_BRIDGE_CAPABILITY_VERSION,
    frameCredits: true,
  };
}

export class FrameFlowControl {
  #inFlightBytes = 0;
  #paused = false;

  get inFlightBytes(): number {
    return this.#inFlightBytes;
  }

  get paused(): boolean {
    return this.#paused;
  }

  accept(bytes: number): "pause" | undefined {
    if (!Number.isSafeInteger(bytes) || bytes < 0)
      throw new RangeError("frame byte count must be a non-negative integer");
    this.#inFlightBytes += bytes;
    if (!this.#paused && this.#inFlightBytes >= FRAME_IN_FLIGHT_HIGH_WATER_BYTES) {
      this.#paused = true;
      return "pause";
    }
    return undefined;
  }

  release(bytes: number): "resume" | undefined {
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw new RangeError("frame credit must be a non-negative integer");
    if (bytes > this.#inFlightBytes) throw new RangeError("frame credit exceeds in-flight bytes");
    this.#inFlightBytes -= bytes;
    if (this.#paused && this.#inFlightBytes <= FRAME_IN_FLIGHT_LOW_WATER_BYTES) {
      this.#paused = false;
      return "resume";
    }
    return undefined;
  }
}
