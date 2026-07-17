type KeyLike = Pick<KeyboardEvent, "key" | "code" | "metaKey" | "shiftKey" | "altKey" | "ctrlKey">;

export type GhosttyTerminalBinding = { type: "paste" } | { type: "text"; text: string };

/**
 * Ghostty's default macOS "natural text editing" bindings.
 *
 * These are application bindings, not terminal key encodings. Keeping them
 * here mirrors Ghostty's config layer before input reaches libghostty.
 */
export function ghosttyTerminalBinding(event: KeyLike, platform: string | undefined): GhosttyTerminalBinding | null {
  if (platform !== "darwin" || event.shiftKey || event.ctrlKey) return null;

  if (event.metaKey && !event.altKey) {
    if (event.key.toLowerCase() === "v") return { type: "paste" };
    if (event.code === "ArrowRight") return { type: "text", text: "\u0005" };
    if (event.code === "ArrowLeft") return { type: "text", text: "\u0001" };
    if (event.code === "Backspace") return { type: "text", text: "\u0015" };
  }

  if (event.altKey && !event.metaKey) {
    if (event.code === "ArrowLeft") return { type: "text", text: "\u001bb" };
    if (event.code === "ArrowRight") return { type: "text", text: "\u001bf" };
  }

  return null;
}
