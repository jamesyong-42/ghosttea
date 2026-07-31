import { isRendererClientCommandAllowed } from "@vibecook/ghosttea-protocol";

export interface RendererCommandRejection {
  requestId: number;
  type: "error";
  message: string;
}

/**
 * Enforce the trust boundary between an untrusted renderer and ghosttead.
 *
 * Shape validation remains ghosttead's responsibility. This allowlist only
 * decides which command families a renderer may attempt to send.
 */
export function rendererCommandRejection(command: unknown): RendererCommandRejection | undefined {
  if (isRendererClientCommandAllowed(command)) return undefined;
  const requestId =
    command !== null &&
    typeof command === "object" &&
    Number.isSafeInteger((command as { requestId?: unknown }).requestId) &&
    Number((command as { requestId: number }).requestId) >= 0
      ? Number((command as { requestId: number }).requestId)
      : 0;
  return {
    requestId,
    type: "error",
    message: "Control command is not available to terminal renderers",
  };
}
