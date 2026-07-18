import {
  applyWorkspaceAction,
  decodeWorkspaceDocument,
  restoreWorkspaceDocument,
  workspaceSessionIds,
  type WorkspaceDocumentV1,
  type WorkspaceAction,
} from "./workspace-model.js";

export const WORKSPACE_TABS_SCHEMA_VERSION = 1 as const;

export interface WorkspaceTabV1 {
  id: string;
  workspace: WorkspaceDocumentV1;
}

export interface WorkspaceTabsDocumentV1 {
  version: typeof WORKSPACE_TABS_SCHEMA_VERSION;
  selectedTabId: string;
  tabs: WorkspaceTabV1[];
}

export type WorkspaceTabsAction =
  | { type: "create-tab"; tab: WorkspaceTabV1 }
  | { type: "select-tab"; tabId: string }
  | { type: "select-relative"; offset: -1 | 1 }
  | { type: "move-tab"; tabId: string; offset: -1 | 1 }
  | { type: "close-tab"; tabId: string }
  | { type: "apply-to-selected"; action: WorkspaceAction };

export interface WorkspaceTabsTransition {
  document: WorkspaceTabsDocumentV1;
  closedTabId: string | null;
  closedSessionIds: string[];
  shouldCloseWindow: boolean;
}

function unchanged(document: WorkspaceTabsDocumentV1): WorkspaceTabsTransition {
  return { document, closedTabId: null, closedSessionIds: [], shouldCloseWindow: false };
}

function allSessionIds(document: WorkspaceTabsDocumentV1): Set<string> {
  return new Set(document.tabs.flatMap((tab) => workspaceSessionIds(tab.workspace)));
}

export function applyWorkspaceTabsAction(
  document: WorkspaceTabsDocumentV1,
  action: WorkspaceTabsAction,
): WorkspaceTabsTransition {
  if (action.type === "apply-to-selected") {
    const index = document.tabs.findIndex((tab) => tab.id === document.selectedTabId);
    if (index < 0) return unchanged(document);
    const selected = document.tabs[index]!;
    const paneTransition = applyWorkspaceAction(selected.workspace, action.action);
    if (paneTransition.shouldCloseWindow) {
      return applyWorkspaceTabsAction(document, { type: "close-tab", tabId: selected.id });
    }
    const otherSessionIds = new Set(
      document.tabs.filter((tab) => tab.id !== selected.id).flatMap((tab) => workspaceSessionIds(tab.workspace)),
    );
    if (workspaceSessionIds(paneTransition.document).some((id) => otherSessionIds.has(id))) {
      return unchanged(document);
    }
    const tabs = [...document.tabs];
    tabs[index] = { ...selected, workspace: paneTransition.document };
    return {
      document: { ...document, tabs },
      closedTabId: null,
      closedSessionIds: paneTransition.closedSessionId ? [paneTransition.closedSessionId] : [],
      shouldCloseWindow: false,
    };
  }

  if (action.type === "create-tab") {
    const workspace = decodeWorkspaceDocument(action.tab.workspace);
    if (!action.tab.id || !workspace || document.tabs.some((tab) => tab.id === action.tab.id)) {
      return unchanged(document);
    }
    const existingSessionIds = allSessionIds(document);
    if (workspaceSessionIds(workspace).some((sessionId) => existingSessionIds.has(sessionId))) {
      return unchanged(document);
    }
    const tab = { id: action.tab.id, workspace };
    return unchanged({
      ...document,
      tabs: [...document.tabs, tab],
      selectedTabId: tab.id,
    });
  }

  if (action.type === "select-tab") {
    return document.tabs.some((tab) => tab.id === action.tabId)
      ? unchanged({ ...document, selectedTabId: action.tabId })
      : unchanged(document);
  }

  if (action.type === "select-relative") {
    if (document.tabs.length < 2) return unchanged(document);
    const index = document.tabs.findIndex((tab) => tab.id === document.selectedTabId);
    if (index < 0) return unchanged(document);
    const next = (index + action.offset + document.tabs.length) % document.tabs.length;
    return unchanged({ ...document, selectedTabId: document.tabs[next]!.id });
  }

  if (action.type === "move-tab") {
    const index = document.tabs.findIndex((tab) => tab.id === action.tabId);
    if (index < 0) return unchanged(document);
    const destination = Math.max(0, Math.min(document.tabs.length - 1, index + action.offset));
    if (destination === index) return unchanged(document);
    const tabs = [...document.tabs];
    const [tab] = tabs.splice(index, 1);
    tabs.splice(destination, 0, tab!);
    return unchanged({ ...document, tabs });
  }

  const index = document.tabs.findIndex((tab) => tab.id === action.tabId);
  if (index < 0) return unchanged(document);
  if (document.tabs.length === 1) {
    return { ...unchanged(document), shouldCloseWindow: true };
  }
  const closed = document.tabs[index]!;
  const tabs = document.tabs.filter((_, candidate) => candidate !== index);
  const selectedTabId =
    document.selectedTabId === closed.id ? tabs[Math.min(index, tabs.length - 1)]!.id : document.selectedTabId;
  return {
    document: { ...document, tabs, selectedTabId },
    closedTabId: closed.id,
    closedSessionIds: workspaceSessionIds(closed.workspace),
    shouldCloseWindow: false,
  };
}

export function decodeWorkspaceTabsDocument(value: unknown): WorkspaceTabsDocumentV1 | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  if (
    candidate.version !== WORKSPACE_TABS_SCHEMA_VERSION ||
    typeof candidate.selectedTabId !== "string" ||
    !Array.isArray(candidate.tabs) ||
    candidate.tabs.length === 0
  ) {
    return null;
  }
  const tabIds = new Set<string>();
  const sessionIds = new Set<string>();
  const tabs: WorkspaceTabV1[] = [];
  for (const raw of candidate.tabs) {
    if (!raw || typeof raw !== "object") return null;
    const tab = raw as Record<string, unknown>;
    if (typeof tab.id !== "string" || !tab.id || tabIds.has(tab.id)) return null;
    const workspace = decodeWorkspaceDocument(tab.workspace);
    if (!workspace) return null;
    const sessions = workspaceSessionIds(workspace);
    if (sessions.some((sessionId) => sessionIds.has(sessionId))) return null;
    tabIds.add(tab.id);
    sessions.forEach((sessionId) => sessionIds.add(sessionId));
    tabs.push({ id: tab.id, workspace });
  }
  if (!tabIds.has(candidate.selectedTabId)) return null;
  return { version: WORKSPACE_TABS_SCHEMA_VERSION, selectedTabId: candidate.selectedTabId, tabs };
}

export function restoreWorkspaceTabsDocument(
  document: WorkspaceTabsDocumentV1,
  liveSessionIds: ReadonlySet<string>,
): WorkspaceTabsDocumentV1 | null {
  const tabs = document.tabs.flatMap((tab) => {
    const workspace = restoreWorkspaceDocument(tab.workspace, liveSessionIds);
    return workspace ? [{ ...tab, workspace }] : [];
  });
  if (tabs.length === 0) return null;
  const selectedTabId = tabs.some((tab) => tab.id === document.selectedTabId) ? document.selectedTabId : tabs[0]!.id;
  return { ...document, tabs, selectedTabId };
}
