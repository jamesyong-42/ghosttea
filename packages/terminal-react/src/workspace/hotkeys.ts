/**
 * Workspace command DTOs and stable `ghosttea.workspace.*` command IDs.
 *
 * Binding match + route live in `../bindings/`. This module is the workspace
 * facade used by GhostteaWorkspace and the desktop/iOS conformance fixture.
 */

import {
  resolveKeyEvent,
  workspaceEffectFromAction,
  workspaceEffectFromGhosttyAction,
  type WorkspaceEffect,
} from "../bindings/action-route.js";
import type { GhostteaBindingAction, GhosttyAction } from "../bindings/ghostty-actions.js";
import type { KeyEventLike } from "../bindings/ghostty-triggers.js";
import type { SplitAxis } from "./pane-layout.js";

/** @deprecated Prefer WorkspaceEffect; alias kept for public API stability. */
export type GhosttyHotkey = WorkspaceEffect;

export type { WorkspaceEffect };

export type WorkspaceCommandId =
  | "ghosttea.workspace.remote-sessions"
  | "ghosttea.workspace.new-tab"
  | "ghosttea.workspace.select-tab"
  | "ghosttea.workspace.close-tab"
  | "ghosttea.workspace.split"
  | "ghosttea.workspace.focus-relative"
  | "ghosttea.workspace.focus-direction"
  | "ghosttea.workspace.resize"
  | "ghosttea.workspace.equalize"
  | "ghosttea.workspace.toggle-zoom"
  | "ghosttea.workspace.close-pane";

export function workspaceCommandId(command: WorkspaceEffect): WorkspaceCommandId {
  return `ghosttea.workspace.${command.type}`;
}

export function workspaceHotkeyFromAction(action: GhostteaBindingAction): WorkspaceEffect | null {
  return workspaceEffectFromAction(action);
}

export function workspaceHotkeyFromGhosttyAction(action: GhosttyAction): WorkspaceEffect | null {
  return workspaceEffectFromGhosttyAction(action);
}

/**
 * Resolve a keyboard event to a workspace command only.
 * Terminal/platform/unhandled routes return null (see `resolveKeyEvent`).
 */
export function ghosttyHotkey(event: KeyEventLike, platform: string = "darwin"): WorkspaceEffect | null {
  const routed = resolveKeyEvent(event, {
    extensions: true,
    platform,
    scopes: ["workspace"],
  });
  return routed?.kind === "workspace" ? routed.command : null;
}

/** Type-level check that workspace axes stay aligned with pane-layout. */
export type _AssertSplitAxis = Extract<WorkspaceEffect, { type: "split" }>["axis"] extends SplitAxis ? true : never;
