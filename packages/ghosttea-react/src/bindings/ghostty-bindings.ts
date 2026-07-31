/**
 * Table-driven Ghostty keybind matching.
 *
 * Default macOS bindings come from the pinned ground-truth dump:
 * `fixtures/keybinds-macos-default.json` (extracted from Ghostty).
 *
 * Ghosttea product extensions (⌘⇧O remote sessions) live in
 * `fixtures/extensions.json` and are matched only when extensions are enabled.
 *
 * `flags.performable` mirrors Ghostty Binding.Flags: when true, a bind only
 * exists if the action can be performed. CLI dumps omit flags; the fixture
 * merges them from Config.zig knowledge (see extract script / flagsNote).
 */

import type { GhostteaBindingAction, GhosttyAction } from "./ghostty-actions.js";
import type { WorkspaceConfig } from "@vibecook/ghosttea-protocol";
import { parseGhostteaBindingAction, parseGhosttyAction } from "./ghostty-actions.js";
import {
  formatGhosttyTrigger,
  parseGhosttyTrigger,
  synthesizeKeyEvent,
  triggerMatchesEvent,
  type GhosttyTrigger,
  type KeyEventLike,
} from "./ghostty-triggers.js";
import defaultKeybindsJson from "./fixtures/keybinds-macos-default.json";
import linuxKeybindsJson from "./fixtures/keybinds-linux-default.json";
import extensionsJson from "./fixtures/extensions.json";

export type GhosttyBindingFlags = {
  /**
   * When true, Ghostty treats the bind as absent if the action cannot run
   * (e.g. Escape=end_search only while search is open).
   */
  performable: boolean;
  /** Ghostty's `unconsumed:` prefix: run the action and still forward input. */
  unconsumed?: boolean;
  /** Parsed for compatibility; OS-global registration is host-owned. */
  global?: boolean;
  /** Parsed for compatibility; multi-surface execution is not implemented. */
  all?: boolean;
};

export type GhosttyBindingEntry = {
  trigger: GhosttyTrigger;
  /** Canonical trigger string from Ghostty dump. */
  triggerRaw: string;
  action: GhosttyAction;
  /** Canonical action string from Ghostty dump. */
  actionRaw: string;
  flags: GhosttyBindingFlags;
};

export type GhostteaExtensionEntry = {
  trigger: GhosttyTrigger;
  triggerRaw: string;
  action: GhostteaBindingAction;
  actionRaw: string;
  flags: GhosttyBindingFlags;
  note?: string;
};

/** Match result including flags (needed for consume/performable policy). */
export type GhostteaBindingMatch = {
  action: GhostteaBindingAction;
  flags: GhosttyBindingFlags;
  triggerRaw: string;
  actionRaw: string;
};

type DumpFile = {
  platform?: string;
  bindings: Array<{ trigger: string; action: string; flags?: { performable?: boolean } }>;
};

type ExtensionFile = {
  bindings: Array<{ trigger: string; action: string; note?: string }>;
};

function loadDefaultBindings(source: DumpFile = defaultKeybindsJson as DumpFile): GhosttyBindingEntry[] {
  return source.bindings.map((row) => ({
    triggerRaw: row.trigger,
    actionRaw: row.action,
    trigger: parseGhosttyTrigger(row.trigger),
    action: parseGhosttyAction(row.action),
    flags: { performable: row.flags?.performable === true },
  }));
}

function loadExtensions(source: ExtensionFile = extensionsJson as ExtensionFile): GhostteaExtensionEntry[] {
  return source.bindings.map((row) => {
    const entry: GhostteaExtensionEntry = {
      triggerRaw: row.trigger,
      actionRaw: row.action,
      trigger: parseGhosttyTrigger(row.trigger),
      action: parseGhostteaBindingAction(row.action),
      // Product extensions always apply when matched.
      flags: { performable: false },
    };
    if (row.note !== undefined) entry.note = row.note;
    return entry;
  });
}

/** Parsed default macOS Ghostty keybinds. */
export const GHOSTTY_MACOS_DEFAULT_BINDINGS: readonly GhosttyBindingEntry[] = loadDefaultBindings(
  defaultKeybindsJson as DumpFile,
);

/** Parsed default Linux Ghostty keybinds (derived from Config.zig non-Darwin branch). */
export const GHOSTTY_LINUX_DEFAULT_BINDINGS: readonly GhosttyBindingEntry[] = loadDefaultBindings(
  linuxKeybindsJson as DumpFile,
);

/** Ghosttea-only extensions. ⌘⇧O remote sessions is intentional product UX. */
export const GHOSTTEA_BINDING_EXTENSIONS: readonly GhostteaExtensionEntry[] = loadExtensions();

export type BindingPlatform = "darwin" | "macos" | "linux" | "win32" | string;

/** Resolve which default table to use for a host platform. */
export function defaultBindingsForPlatform(platform: BindingPlatform | undefined): readonly GhosttyBindingEntry[] {
  if (platform === "linux" || platform === "win32") return GHOSTTY_LINUX_DEFAULT_BINDINGS;
  // darwin / macos / undefined → macOS defaults (primary desktop target).
  return GHOSTTY_MACOS_DEFAULT_BINDINGS;
}

const CONFIG_BINDING_PREFIX = /^(all|global|unconsumed|performable):/;

function parseConfiguredTrigger(raw: string): {
  raw: string;
  trigger: GhosttyTrigger;
  flags: GhosttyBindingFlags;
} {
  let triggerRaw = raw.trim();
  const flags: GhosttyBindingFlags = { performable: false };
  while (true) {
    const match = triggerRaw.match(CONFIG_BINDING_PREFIX);
    if (!match) break;
    const prefix = match[1]!;
    if (prefix === "all") flags.all = true;
    else if (prefix === "global") flags.global = true;
    else if (prefix === "unconsumed") flags.unconsumed = true;
    else if (prefix === "performable") flags.performable = true;
    triggerRaw = triggerRaw.slice(match[0].length);
  }
  return { raw: triggerRaw, trigger: parseGhosttyTrigger(triggerRaw), flags };
}

/**
 * Apply imported Ghostty `keybind` mutations over the pinned platform
 * defaults. Invalid or not-yet-known actions are ignored here; the config
 * snapshot retains the raw mutation for hosts to inspect.
 */
export function configuredBindingsForPlatform(
  config: WorkspaceConfig | undefined,
  platform: BindingPlatform | undefined,
): readonly GhosttyBindingEntry[] {
  const table = new Map(
    (config?.clearKeybindings ? [] : defaultBindingsForPlatform(platform)).map(
      (entry) => [formatGhosttyTrigger(entry.trigger), entry] as const,
    ),
  );
  for (const mutation of config?.keybindings ?? []) {
    let parsed: ReturnType<typeof parseConfiguredTrigger>;
    try {
      parsed = parseConfiguredTrigger(mutation.trigger);
    } catch {
      continue;
    }
    const canonical = formatGhosttyTrigger(parsed.trigger);
    if (mutation.action === "unbind") {
      table.delete(canonical);
      continue;
    }
    try {
      table.set(canonical, {
        triggerRaw: parsed.raw,
        actionRaw: mutation.action,
        trigger: parsed.trigger,
        action: parseGhosttyAction(mutation.action),
        flags: parsed.flags,
      });
    } catch {
      // The compatibility layer deliberately leaves unsupported action text
      // visible in ConfigSnapshot rather than turning it into a wrong action.
    }
  }
  return [...table.values()];
}

export function isKeyboardBinding(entry: { trigger: GhosttyTrigger }): boolean {
  return entry.trigger.key.kind !== "special";
}

export function keyboardDefaultBindings(
  bindings: readonly GhosttyBindingEntry[] = GHOSTTY_MACOS_DEFAULT_BINDINGS,
): GhosttyBindingEntry[] {
  return bindings.filter(isKeyboardBinding);
}

/**
 * Match a keyboard event against a binding table.
 * Returns the first matching binding, or null.
 *
 * Special menu triggers (`copy`, `paste`) never match keyboard events.
 */
export function matchGhosttyBindingEntry(
  event: KeyEventLike,
  bindings: readonly GhosttyBindingEntry[] = GHOSTTY_MACOS_DEFAULT_BINDINGS,
): GhosttyBindingEntry | null {
  for (const entry of bindings) {
    if (!isKeyboardBinding(entry)) continue;
    if (triggerMatchesEvent(entry.trigger, event)) return entry;
  }
  return null;
}

/** @deprecated Prefer matchGhosttyBindingEntry when flags matter. */
export function matchGhosttyBinding(
  event: KeyEventLike,
  bindings: readonly GhosttyBindingEntry[] = GHOSTTY_MACOS_DEFAULT_BINDINGS,
): GhosttyAction | null {
  return matchGhosttyBindingEntry(event, bindings)?.action ?? null;
}

export type MatchBindingOptions = {
  /** Include Ghosttea product extensions (default true). */
  extensions?: boolean;
  /** Host platform; selects macOS vs Linux default tables when `bindings` omitted. */
  platform?: BindingPlatform;
  bindings?: readonly GhosttyBindingEntry[];
  extensionBindings?: readonly GhostteaExtensionEntry[];
};

/**
 * Match Ghostty defaults, then Ghosttea extensions.
 * Extensions win when they collide (product override).
 */
export function matchGhostteaBindingEntry(
  event: KeyEventLike,
  options: MatchBindingOptions = {},
): GhostteaBindingMatch | null {
  const extensionBindings = options.extensionBindings ?? GHOSTTEA_BINDING_EXTENSIONS;
  if (options.extensions !== false) {
    for (const entry of extensionBindings) {
      if (triggerMatchesEvent(entry.trigger, event)) {
        return {
          action: entry.action,
          flags: entry.flags,
          triggerRaw: entry.triggerRaw,
          actionRaw: entry.actionRaw,
        };
      }
    }
  }
  const table = options.bindings ?? defaultBindingsForPlatform(options.platform);
  const hit = matchGhosttyBindingEntry(event, table);
  if (!hit) return null;
  return {
    action: hit.action,
    flags: hit.flags,
    triggerRaw: hit.triggerRaw,
    actionRaw: hit.actionRaw,
  };
}

/** @deprecated Prefer matchGhostteaBindingEntry when flags matter. */
export function matchGhostteaBinding(
  event: KeyEventLike,
  options: MatchBindingOptions = {},
): GhostteaBindingAction | null {
  return matchGhostteaBindingEntry(event, options)?.action ?? null;
}

/** Round-trip helpers used by the extract / golden suite. */
export function bindingDumpLines(bindings: readonly GhosttyBindingEntry[]): string[] {
  return bindings.map((b) => `keybind = ${b.triggerRaw}=${b.actionRaw}`);
}

export function synthesizeEventForBinding(entry: GhosttyBindingEntry): KeyEventLike | null {
  return synthesizeKeyEvent(entry.trigger);
}

export { formatGhosttyTrigger, parseGhosttyTrigger, synthesizeKeyEvent };
