import type { SessionSummary } from "@vibecook/ghosttea-protocol";

export type SplitAxis = "horizontal" | "vertical";

export interface PaneLeaf {
  kind: "pane";
  id: string;
  session: SessionSummary;
}

export interface PaneSplit {
  kind: "split";
  id: string;
  axis: SplitAxis;
  ratio: number;
  first: PaneNode;
  second: PaneNode;
}

export type PaneNode = PaneLeaf | PaneSplit;

export const layoutId = (prefix: string): string => `${prefix}-${crypto.randomUUID()}`;
export const pane = (id: string, session: SessionSummary): PaneLeaf => ({ kind: "pane", id, session });

export function restoreNode(value: unknown, sessions: Map<string, SessionSummary>): PaneNode | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  if (candidate.kind === "pane" && typeof candidate.id === "string") {
    const savedSession = candidate.session as { id?: unknown } | undefined;
    if (typeof savedSession?.id !== "string") return null;
    const session = sessions.get(savedSession.id);
    return session ? pane(candidate.id, session) : null;
  }
  if (
    candidate.kind !== "split" ||
    typeof candidate.id !== "string" ||
    (candidate.axis !== "horizontal" && candidate.axis !== "vertical")
  )
    return null;
  const first = restoreNode(candidate.first, sessions);
  const second = restoreNode(candidate.second, sessions);
  if (!first) return second;
  if (!second) return first;
  const ratio =
    typeof candidate.ratio === "number" && Number.isFinite(candidate.ratio)
      ? Math.max(0.1, Math.min(0.9, candidate.ratio))
      : 0.5;
  return { kind: "split", id: candidate.id, axis: candidate.axis, ratio, first, second };
}

export function appendPane(root: PaneNode, next: PaneLeaf): PaneNode {
  return { kind: "split", id: layoutId("split"), axis: "horizontal", ratio: 0.5, first: root, second: next };
}

export function leaves(node: PaneNode | undefined): PaneLeaf[] {
  if (!node) return [];
  return node.kind === "pane" ? [node] : [...leaves(node.first), ...leaves(node.second)];
}

export function replacePane(node: PaneNode, paneId: string, replacement: PaneNode): PaneNode {
  if (node.kind === "pane") return node.id === paneId ? replacement : node;
  return {
    ...node,
    first: replacePane(node.first, paneId, replacement),
    second: replacePane(node.second, paneId, replacement),
  };
}

export function insertPane(
  root: PaneNode | undefined,
  next: PaneLeaf,
  activePaneId: string | undefined,
  axis: SplitAxis,
  splitId: string,
): PaneNode {
  if (!root) return next;
  if (leaves(root).some((candidate) => candidate.session.id === next.session.id)) return root;
  const active = leaves(root).find((candidate) => candidate.id === activePaneId) ?? leaves(root)[0]!;
  return replacePane(root, active.id, {
    kind: "split",
    id: splitId,
    axis,
    ratio: 0.5,
    first: active,
    second: next,
  });
}

export function updateSession(node: PaneNode, session: SessionSummary): PaneNode {
  if (node.kind === "pane") return node.session.id === session.id ? { ...node, session } : node;
  return { ...node, first: updateSession(node.first, session), second: updateSession(node.second, session) };
}

export function removePane(node: PaneNode, paneId: string): PaneNode | null {
  if (node.kind === "pane") return node.id === paneId ? null : node;
  const first = removePane(node.first, paneId);
  const second = removePane(node.second, paneId);
  if (!first) return second;
  if (!second) return first;
  return { ...node, first, second };
}

export function updateSplit(node: PaneNode, splitId: string, update: (split: PaneSplit) => PaneSplit): PaneNode {
  if (node.kind === "pane") return node;
  if (node.id === splitId) return update(node);
  return {
    ...node,
    first: updateSplit(node.first, splitId, update),
    second: updateSplit(node.second, splitId, update),
  };
}

export function equalize(node: PaneNode): PaneNode {
  if (node.kind === "pane") return node;
  return { ...node, ratio: 0.5, first: equalize(node.first), second: equalize(node.second) };
}

export function containsPane(node: PaneNode, paneId: string): boolean {
  return node.kind === "pane"
    ? node.id === paneId
    : containsPane(node.first, paneId) || containsPane(node.second, paneId);
}

export function resizeForPane(node: PaneNode, paneId: string, axis: SplitAxis, delta: number): [PaneNode, boolean] {
  if (node.kind === "pane") return [node, false];
  const inFirst = containsPane(node.first, paneId);
  const inSecond = containsPane(node.second, paneId);
  if (inFirst) {
    const [first, changed] = resizeForPane(node.first, paneId, axis, delta);
    if (changed) return [{ ...node, first }, true];
  }
  if (inSecond) {
    const [second, changed] = resizeForPane(node.second, paneId, axis, delta);
    if (changed) return [{ ...node, second }, true];
  }
  if (node.axis === axis && (inFirst || inSecond)) {
    return [{ ...node, ratio: Math.max(0.1, Math.min(0.9, node.ratio + delta)) }, true];
  }
  return [node, false];
}
