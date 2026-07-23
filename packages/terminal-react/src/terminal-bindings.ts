import {
  resolveKeyEvent,
  type TerminalEffect,
} from "./bindings/action-route.js";
import type { GhosttyBindingFlags } from "./bindings/ghostty-bindings.js";
import type { KeyEventLike } from "./bindings/ghostty-triggers.js";

/**
 * @deprecated Prefer TerminalEffect from bindings/action-route.
 * Kept for tests and callers that only need terminal-scoped effects.
 */
export type GhosttyTerminalBinding = TerminalEffect;

export type ResolvedTerminalBinding = {
  effect: TerminalEffect;
  flags: GhosttyBindingFlags;
};

/**
 * Resolve terminal-scoped Ghostty application bindings for the active surface.
 * Workspace/platform/unhandled binds are intentionally excluded (other owners).
 *
 * Uses the platform default table (macOS super vs Linux ctrl+shift).
 */
export function resolveTerminalBinding(
  event: KeyEventLike,
  platform: string | undefined,
): ResolvedTerminalBinding | null {
  const routed = resolveKeyEvent(event, {
    extensions: true,
    ...(platform !== undefined ? { platform } : {}),
    scopes: ["terminal"],
  });
  if (routed?.kind !== "terminal") return null;
  return { effect: routed.effect, flags: routed.flags };
}

/** Convenience: effect only (tests). */
export function ghosttyTerminalBinding(
  event: KeyEventLike,
  platform: string | undefined,
): TerminalEffect | null {
  return resolveTerminalBinding(event, platform)?.effect ?? null;
}
