export const WORKSPACE_SCHEMA_VERSION = 1 as const;

export type WorkspaceSplitAxis = "horizontal" | "vertical";
export type WorkspaceFocusDirection = "left" | "right" | "up" | "down";

export interface WorkspacePaneNode {
  kind: "pane";
  id: string;
  sessionId: string;
}

export interface WorkspaceSplitNode {
  kind: "split";
  id: string;
  axis: WorkspaceSplitAxis;
  ratio: number;
  first: WorkspaceNode;
  second: WorkspaceNode;
}

export type WorkspaceNode = WorkspacePaneNode | WorkspaceSplitNode;

export interface WorkspaceDocumentV1 {
  version: typeof WORKSPACE_SCHEMA_VERSION;
  root: WorkspaceNode;
  activePaneId: string;
  zoomedPaneId: string | null;
}

export type WorkspaceAction =
  | {
      type: "split";
      axis: WorkspaceSplitAxis;
      paneId: string;
      sessionId: string;
      splitId: string;
    }
  | { type: "activate"; paneId: string }
  | { type: "focus-relative"; offset: -1 | 1 }
  | { type: "focus-direction"; direction: WorkspaceFocusDirection }
  | { type: "resize"; axis: WorkspaceSplitAxis; delta: number }
  | { type: "equalize" }
  | { type: "toggle-zoom" }
  | { type: "close" };

export interface WorkspaceTransition {
  document: WorkspaceDocumentV1;
  closedSessionId: string | null;
  shouldCloseWindow: boolean;
}

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

const clampRatio = (ratio: number): number => Math.max(0.1, Math.min(0.9, ratio));

function workspaceLeaves(node: WorkspaceNode): WorkspacePaneNode[] {
  return node.kind === "pane" ? [node] : [...workspaceLeaves(node.first), ...workspaceLeaves(node.second)];
}

function containsPane(node: WorkspaceNode, paneId: string): boolean {
  return node.kind === "pane"
    ? node.id === paneId
    : containsPane(node.first, paneId) || containsPane(node.second, paneId);
}

function replacePane(node: WorkspaceNode, paneId: string, replacement: WorkspaceNode): WorkspaceNode {
  if (node.kind === "pane") return node.id === paneId ? replacement : node;
  return {
    ...node,
    first: replacePane(node.first, paneId, replacement),
    second: replacePane(node.second, paneId, replacement),
  };
}

function removePane(node: WorkspaceNode, paneId: string): WorkspaceNode | null {
  if (node.kind === "pane") return node.id === paneId ? null : node;
  const first = removePane(node.first, paneId);
  const second = removePane(node.second, paneId);
  if (!first) return second;
  if (!second) return first;
  return { ...node, first, second };
}

function equalize(node: WorkspaceNode): WorkspaceNode {
  if (node.kind === "pane") return node;
  return { ...node, ratio: 0.5, first: equalize(node.first), second: equalize(node.second) };
}

function resizeForPane(
  node: WorkspaceNode,
  paneId: string,
  axis: WorkspaceSplitAxis,
  delta: number,
): [WorkspaceNode, boolean] {
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
    return [{ ...node, ratio: clampRatio(node.ratio + delta) }, true];
  }
  return [node, false];
}

function paneRects(node: WorkspaceNode, rect: Rect, output: Map<string, Rect>): void {
  if (node.kind === "pane") {
    output.set(node.id, rect);
    return;
  }
  if (node.axis === "horizontal") {
    const firstWidth = rect.width * node.ratio;
    paneRects(node.first, { ...rect, width: firstWidth }, output);
    paneRects(
      node.second,
      { x: rect.x + firstWidth, y: rect.y, width: rect.width - firstWidth, height: rect.height },
      output,
    );
    return;
  }
  const firstHeight = rect.height * node.ratio;
  paneRects(node.first, { ...rect, height: firstHeight }, output);
  paneRects(
    node.second,
    { x: rect.x, y: rect.y + firstHeight, width: rect.width, height: rect.height - firstHeight },
    output,
  );
}

function focusedPane(node: WorkspaceNode, paneId: string, direction: WorkspaceFocusDirection): string | null {
  const rects = new Map<string, Rect>();
  paneRects(node, { x: 0, y: 0, width: 1, height: 1 }, rects);
  const source = rects.get(paneId);
  if (!source) return null;
  const sourceX = source.x + source.width / 2;
  const sourceY = source.y + source.height / 2;
  let best: { id: string; score: number } | undefined;
  for (const pane of workspaceLeaves(node)) {
    if (pane.id === paneId) continue;
    const rect = rects.get(pane.id)!;
    const dx = rect.x + rect.width / 2 - sourceX;
    const dy = rect.y + rect.height / 2 - sourceY;
    const forward = direction === "left" ? -dx : direction === "right" ? dx : direction === "up" ? -dy : dy;
    if (forward <= 0) continue;
    const cross = direction === "left" || direction === "right" ? Math.abs(dy) : Math.abs(dx);
    const score = forward + cross * 2;
    if (!best || score < best.score) best = { id: pane.id, score };
  }
  return best?.id ?? null;
}

function unchanged(document: WorkspaceDocumentV1): WorkspaceTransition {
  return { document, closedSessionId: null, shouldCloseWindow: false };
}

export function applyWorkspaceAction(document: WorkspaceDocumentV1, action: WorkspaceAction): WorkspaceTransition {
  if (action.type === "split") {
    const leaves = workspaceLeaves(document.root);
    const nodeIds = new Set<string>();
    const collectIds = (node: WorkspaceNode): void => {
      nodeIds.add(node.id);
      if (node.kind === "split") {
        collectIds(node.first);
        collectIds(node.second);
      }
    };
    collectIds(document.root);
    if (
      !action.paneId ||
      !action.sessionId ||
      !action.splitId ||
      nodeIds.has(action.paneId) ||
      nodeIds.has(action.splitId) ||
      leaves.some((pane) => pane.sessionId === action.sessionId)
    ) {
      return unchanged(document);
    }
    const active = leaves.find((pane) => pane.id === document.activePaneId) ?? leaves[0]!;
    const next: WorkspacePaneNode = { kind: "pane", id: action.paneId, sessionId: action.sessionId };
    const root = replacePane(document.root, active.id, {
      kind: "split",
      id: action.splitId,
      axis: action.axis,
      ratio: 0.5,
      first: active,
      second: next,
    });
    return {
      document: { ...document, root, activePaneId: next.id, zoomedPaneId: null },
      closedSessionId: null,
      shouldCloseWindow: false,
    };
  }
  if (action.type === "activate") {
    return containsPane(document.root, action.paneId)
      ? unchanged({ ...document, activePaneId: action.paneId })
      : unchanged(document);
  }
  if (action.type === "focus-relative") {
    if (document.zoomedPaneId) return unchanged(document);
    const leaves = workspaceLeaves(document.root);
    const index = leaves.findIndex((pane) => pane.id === document.activePaneId);
    if (leaves.length < 2 || index < 0) return unchanged(document);
    const next = leaves[(index + action.offset + leaves.length) % leaves.length]!;
    return unchanged({ ...document, activePaneId: next.id });
  }
  if (action.type === "focus-direction") {
    if (document.zoomedPaneId) return unchanged(document);
    const paneId = focusedPane(document.root, document.activePaneId, action.direction);
    return paneId ? unchanged({ ...document, activePaneId: paneId }) : unchanged(document);
  }
  if (action.type === "resize") {
    if (!Number.isFinite(action.delta)) return unchanged(document);
    const [root] = resizeForPane(document.root, document.activePaneId, action.axis, action.delta);
    return unchanged({ ...document, root });
  }
  if (action.type === "equalize") {
    return unchanged({ ...document, root: equalize(document.root) });
  }
  if (action.type === "toggle-zoom") {
    return unchanged({
      ...document,
      zoomedPaneId: document.zoomedPaneId ? null : document.activePaneId,
    });
  }

  const leaves = workspaceLeaves(document.root);
  if (leaves.length === 1) {
    return { document, closedSessionId: null, shouldCloseWindow: true };
  }
  const index = leaves.findIndex((pane) => pane.id === document.activePaneId);
  if (index < 0) return unchanged(document);
  const active = leaves[index]!;
  const next = leaves[index === leaves.length - 1 ? index - 1 : index + 1]!;
  const root = removePane(document.root, active.id);
  if (!root) return unchanged(document);
  return {
    document: { ...document, root, activePaneId: next.id, zoomedPaneId: null },
    closedSessionId: active.sessionId,
    shouldCloseWindow: false,
  };
}

export function decodeWorkspaceDocument(value: unknown): WorkspaceDocumentV1 | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  if (candidate.version !== WORKSPACE_SCHEMA_VERSION) return null;
  const nodeIds = new Set<string>();
  const paneIds = new Set<string>();
  const sessionIds = new Set<string>();
  const decodeNode = (raw: unknown): WorkspaceNode | null => {
    if (!raw || typeof raw !== "object") return null;
    const node = raw as Record<string, unknown>;
    if (typeof node.id !== "string" || !node.id || nodeIds.has(node.id)) return null;
    nodeIds.add(node.id);
    if (node.kind === "pane") {
      if (
        typeof node.sessionId !== "string" ||
        !node.sessionId ||
        paneIds.has(node.id) ||
        sessionIds.has(node.sessionId)
      )
        return null;
      paneIds.add(node.id);
      sessionIds.add(node.sessionId);
      return { kind: "pane", id: node.id, sessionId: node.sessionId };
    }
    if (node.kind !== "split" || (node.axis !== "horizontal" && node.axis !== "vertical")) return null;
    const first = decodeNode(node.first);
    const second = decodeNode(node.second);
    if (!first || !second) return null;
    const ratio = typeof node.ratio === "number" && Number.isFinite(node.ratio) ? clampRatio(node.ratio) : 0.5;
    return { kind: "split", id: node.id, axis: node.axis, ratio, first, second };
  };
  const root = decodeNode(candidate.root);
  if (!root || typeof candidate.activePaneId !== "string" || !paneIds.has(candidate.activePaneId)) return null;
  const zoomedPaneId = candidate.zoomedPaneId;
  if (zoomedPaneId !== null && (typeof zoomedPaneId !== "string" || !paneIds.has(zoomedPaneId))) return null;
  return {
    version: WORKSPACE_SCHEMA_VERSION,
    root,
    activePaneId: candidate.activePaneId,
    zoomedPaneId,
  };
}
