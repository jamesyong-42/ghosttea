import type { ConfigDocument, ConfigDocumentValidation, ConfigSnapshot } from "@vibecook/ghosttea-protocol";
import type { GhostteaColorTheme } from "./catalog.js";
import type { TerminalShaderEffect } from "../renderers/types.js";

export interface GhostteaAppearanceUpdate {
  /** Omitted when the user keeps a non-catalog/custom color configuration. */
  theme?: GhostteaColorTheme;
  backgroundOpacity: number;
  backgroundOpacityCells: boolean;
  shaderEffects: TerminalShaderEffect[];
  shaderAnimation: boolean;
}

export interface GhostteaConfigEditorState {
  document: ConfigDocument;
  config: ConfigSnapshot;
}

export type GhostteaConfigEditorSaveResult =
  | {
      status: "saved";
      document: ConfigDocument;
      config: ConfigSnapshot;
    }
  | {
      status: "conflict";
      document: ConfigDocument;
    };

export type GhostteaConfigEditorImportResult =
  | {
      status: "selected";
      name: string;
      contents: string;
      notice?: string;
    }
  | { status: "cancelled" }
  | { status: "unavailable"; message: string };

export type GhostteaConfigEditorExportResult = { status: "saved"; path: string } | { status: "cancelled" };

/** Narrow host capability for editing only Ghosttea's profile-owned overlay. */
export interface GhostteaConfigEditorBridge {
  load: () => Promise<GhostteaConfigEditorState>;
  validate: (contents: string) => Promise<ConfigDocumentValidation>;
  save: (expectedRevision: string, contents: string) => Promise<GhostteaConfigEditorSaveResult>;
  importGhostty: () => Promise<GhostteaConfigEditorImportResult>;
  importFile: () => Promise<GhostteaConfigEditorImportResult>;
  exportFile: (contents: string) => Promise<GhostteaConfigEditorExportResult>;
}
