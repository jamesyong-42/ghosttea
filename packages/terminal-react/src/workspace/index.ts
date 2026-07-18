export {
  GhostteaWorkspace,
  type GhostteaWorkspaceContext,
  type GhostteaWorkspacePlatform,
  type GhostteaWorkspaceProps,
} from "./Workspace.js";
export { ghosttyHotkey, type GhosttyHotkey } from "./hotkeys.js";
export {
  appendPane,
  containsPane,
  equalize,
  layoutId,
  leaves,
  pane,
  persistedWorkspace,
  removePane,
  replacePane,
  resizeForPane,
  restoreNode,
  updateSession,
  updateSplit,
  type PaneLeaf,
  type PaneNode,
  type PaneSplit,
  type SplitAxis,
} from "./pane-layout.js";
export {
  WORKSPACE_SCHEMA_VERSION,
  applyWorkspaceAction,
  decodeWorkspaceDocument,
  type WorkspaceAction,
  type WorkspaceDocumentV1,
  type WorkspaceFocusDirection,
  type WorkspaceNode,
  type WorkspacePaneNode,
  type WorkspaceSplitAxis,
  type WorkspaceSplitNode,
  type WorkspaceTransition,
} from "./workspace-model.js";
export { TERMINAL_THEMES } from "./themes.js";
