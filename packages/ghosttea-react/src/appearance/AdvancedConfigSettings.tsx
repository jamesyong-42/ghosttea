import { useEffect, useMemo, useRef, useState } from "react";
import type { ConfigDiagnostic, ConfigDocument, ConfigSnapshot } from "@vibecook/ghosttea-protocol";
import {
  appendConfigDocument,
  applyConfigTextareaEdit,
  friendlyConfigMismatches,
  friendlyConfigSections,
  friendlyValuesFromConfig,
  patchFriendlyConfigBlock,
  preferredConfigNewline,
  removeFriendlyConfigBlock,
  type FriendlyConfigSection,
  type FriendlyConfigValues,
} from "./config-draft.js";
import type {
  GhostteaConfigEditorBridge,
  GhostteaConfigEditorImportResult,
  GhostteaConfigEditorValidation,
} from "./types.js";

const VALIDATION_DEBOUNCE_MS = 320;
const MAX_CONFIG_BYTES = 64 * 1024;

type EditorMode = "raw" | "friendly";
type ValidationState = "idle" | "validating" | "valid" | "invalid";
type ColorKey = "foreground" | "background" | "cursor" | "cursorText" | "selectionBackground" | "selectionForeground";

export interface AdvancedConfigSettingsProps {
  config: ConfigSnapshot;
  editor: GhostteaConfigEditorBridge;
  onClose: () => void;
  onDirtyChange: (dirty: boolean) => void;
  onPreview: (config: ConfigSnapshot | undefined) => void;
  onSaved?: (config: ConfigSnapshot) => void;
}

export function AdvancedConfigSettings({
  config,
  editor,
  onClose,
  onDirtyChange,
  onPreview,
  onSaved,
}: AdvancedConfigSettingsProps) {
  const [mode, setMode] = useState<EditorMode>("raw");
  const [document, setDocument] = useState<ConfigDocument>();
  const [baseContents, setBaseContents] = useState("");
  const [baseConfig, setBaseConfig] = useState(config);
  const [draft, setDraft] = useState("");
  const [validation, setValidation] = useState<GhostteaConfigEditorValidation>();
  const [validatedDraft, setValidatedDraft] = useState<string>();
  const [validationState, setValidationState] = useState<ValidationState>("idle");
  const [friendly, setFriendly] = useState(() => friendlyValuesFromConfig(config));
  const [friendlySections, setFriendlySections] = useState<Set<FriendlyConfigSection>>(() => new Set());
  const [friendlyDraftContents, setFriendlyDraftContents] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const [message, setMessage] = useState<string>();
  const [conflict, setConflict] = useState<ConfigDocument>();
  const [pendingImport, setPendingImport] =
    useState<Extract<GhostteaConfigEditorImportResult, { status: "selected" }>>();
  const validationSequence = useRef(0);
  const mounted = useRef(true);
  const textAreaRef = useRef<HTMLTextAreaElement>(null);
  const gutterRef = useRef<HTMLPreElement>(null);

  const diagnostics = validation?.config.diagnostics ?? [];
  const errors = diagnostics.filter((diagnostic) => diagnostic.severity === "error");
  const blockingErrors = validation?.blockingErrors ?? errors;
  const errorCount = errors.length;
  const blockingErrorCount = blockingErrors.length;
  const inheritedErrorCount = Math.max(0, errorCount - blockingErrorCount);
  const warningCount = diagnostics.filter((diagnostic) => diagnostic.severity === "warning").length;
  const dirty = document !== undefined && draft !== baseContents;
  const byteCount = useMemo(() => new TextEncoder().encode(draft).byteLength, [draft]);
  const lineNumbers = useMemo(
    () => Array.from({ length: Math.max(1, draft.split(/\r\n|\r|\n/u).length) }, (_, index) => index + 1).join("\n"),
    [draft],
  );
  const previewConfig = validation?.config ?? baseConfig;
  const editorDisabled = loading || saving || !document;
  const friendlyMismatches = useMemo(
    () =>
      friendlyDraftContents === draft && validationState === "valid"
        ? friendlyConfigMismatches(previewConfig, friendly, friendlySections)
        : [],
    [draft, friendly, friendlyDraftContents, friendlySections, previewConfig, validationState],
  );

  useEffect(() => {
    let cancelled = false;
    void editor
      .load()
      .then((state) => {
        if (cancelled) return;
        const contents = state.document.contents;
        setDocument(state.document);
        setBaseContents(contents);
        setBaseConfig(state.config);
        setDraft(contents);
        setValidation({ documentRevision: state.document.revision, config: state.config });
        setFriendly(friendlyValuesFromConfig(state.config));
        setFriendlySections(friendlyConfigSections(contents));
        setValidatedDraft(undefined);
        setValidationState("validating");
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(errorMessage(cause));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [editor]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      onPreview(undefined);
    };
  }, [onPreview]);

  useEffect(() => {
    onDirtyChange(dirty);
  }, [dirty, onDirtyChange]);

  useEffect(
    () => () => {
      onDirtyChange(false);
    },
    [onDirtyChange],
  );

  useEffect(() => {
    if (!document || draft === validatedDraft) return;
    const sequence = ++validationSequence.current;
    let cancelled = false;
    const timeout = window.setTimeout(() => {
      void editor
        .validate(draft)
        .then((result) => {
          if (cancelled || sequence !== validationSequence.current) return;
          const nextErrors =
            result.blockingErrors ?? result.config.diagnostics.filter((diagnostic) => diagnostic.severity === "error");
          setValidation(result);
          setValidatedDraft(draft);
          if (draft === baseContents) setBaseConfig(result.config);
          if (friendlyDraftContents !== draft) {
            setFriendly(friendlyValuesFromConfig(result.config));
            setFriendlySections(friendlyConfigSections(draft));
          }
          setValidationState(nextErrors.length > 0 ? "invalid" : "valid");
          setError(undefined);
          if (nextErrors.length === 0) onPreview(result.config);
        })
        .catch((cause: unknown) => {
          if (cancelled || sequence !== validationSequence.current) return;
          setValidatedDraft(draft);
          setValidationState("invalid");
          setError(errorMessage(cause));
        });
    }, VALIDATION_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
    };
  }, [baseContents, document, draft, editor, friendlyDraftContents, onPreview, validatedDraft]);

  const changeDraft = (contents: string, preserveFriendly = false): void => {
    if (!preserveFriendly) {
      setFriendlyDraftContents(undefined);
      setFriendlySections(friendlyConfigSections(contents));
    }
    setDraft(contents);
    setValidationState("validating");
    setConflict(undefined);
    setError(undefined);
    setMessage(undefined);
  };

  const updateFriendly = (update: Partial<FriendlyConfigValues>, section: FriendlyConfigSection): void => {
    const next = { ...friendly, ...update };
    const nextSections = new Set(friendlySections).add(section);
    try {
      const contents = patchFriendlyConfigBlock(draft, next, nextSections);
      setFriendlyDraftContents(contents);
      setFriendly(next);
      setFriendlySections(nextSections);
      changeDraft(contents, true);
    } catch (cause) {
      setError(errorMessage(cause));
    }
  };

  const updatePadding = (axis: "paddingX" | "paddingY", index: 0 | 1, value: number): void => {
    if (!Number.isFinite(value) || value < 0) return;
    const next: [number, number] = [...friendly[axis]];
    next[index] = value;
    updateFriendly({ [axis]: next }, "padding");
  };

  const resetFriendly = (): void => {
    try {
      changeDraft(removeFriendlyConfigBlock(draft));
    } catch (cause) {
      setError(errorMessage(cause));
    }
  };

  const stageImport = async (operation: () => Promise<GhostteaConfigEditorImportResult>): Promise<void> => {
    setError(undefined);
    setMessage(undefined);
    try {
      const result = await operation();
      if (result.status === "selected") setPendingImport(result);
      else if (result.status === "unavailable") setMessage(result.message);
    } catch (cause) {
      setError(errorMessage(cause));
    }
  };

  const applyImport = (strategy: "replace" | "append"): void => {
    if (!pendingImport) return;
    let contents = pendingImport.contents;
    if (strategy === "append" && draft) {
      contents = appendConfigDocument(draft, pendingImport.contents, preferredConfigNewline(draft));
    }
    if (new TextEncoder().encode(contents).byteLength > MAX_CONFIG_BYTES) {
      setError(`The resulting draft exceeds the ${MAX_CONFIG_BYTES}-byte configuration limit.`);
      return;
    }
    changeDraft(contents);
    setPendingImport(undefined);
  };

  const exportDraft = async (): Promise<void> => {
    setError(undefined);
    try {
      const result = await editor.exportFile(draft);
      if (result.status === "saved") setMessage(`Exported to ${result.path}`);
    } catch (cause) {
      setError(errorMessage(cause));
    }
  };

  const save = async (): Promise<void> => {
    if (!document) return;
    if (validatedDraft !== draft || validationState === "validating") {
      setError("Wait for the current draft to finish validating before saving.");
      return;
    }
    if (validationState !== "valid" || blockingErrorCount > 0) {
      setError("Fix errors introduced by this profile draft before saving.");
      return;
    }
    if (mode === "friendly" && friendlyMismatches.length > 0) {
      setError("An included configuration layer overrides the friendly fields listed above. Resolve it in Raw config.");
      return;
    }
    setSaving(true);
    setError(undefined);
    setMessage(undefined);
    try {
      const latestValidation = await editor.validate(draft);
      if (!mounted.current) return;
      const latestErrors =
        latestValidation.blockingErrors ??
        latestValidation.config.diagnostics.filter((diagnostic) => diagnostic.severity === "error");
      setValidation(latestValidation);
      setValidatedDraft(draft);
      setValidationState(latestErrors.length > 0 ? "invalid" : "valid");
      if (latestErrors.length > 0) {
        setError("The profile draft now introduces configuration errors. Review validation before saving.");
        return;
      }
      const latestMismatches =
        mode === "friendly" ? friendlyConfigMismatches(latestValidation.config, friendly, friendlySections) : [];
      if (latestMismatches.length > 0) {
        setError(
          `An included configuration layer overrides: ${latestMismatches.join(", ")}. Resolve it in Raw config.`,
        );
        return;
      }
      onPreview(latestValidation.config);
      const result = await editor.save(document.revision, draft);
      if (!mounted.current) return;
      if (result.status === "conflict") {
        setConflict(result.document);
        return;
      }
      setDocument(result.document);
      setBaseContents(result.document.contents);
      setBaseConfig(result.config);
      setDraft(result.document.contents);
      setValidation({ documentRevision: result.document.revision, config: result.config, blockingErrors: [] });
      setValidatedDraft(result.document.contents);
      setValidationState("valid");
      setFriendly(friendlyValuesFromConfig(result.config));
      setFriendlySections(friendlyConfigSections(result.document.contents));
      setConflict(undefined);
      setMessage(
        "Saved and loaded. Existing sessions received live settings; startup-only and parsed-only settings remain deferred as indicated.",
      );
      onPreview(result.config);
      onSaved?.(result.config);
    } catch (cause) {
      if (mounted.current) setError(errorMessage(cause));
    } finally {
      if (mounted.current) setSaving(false);
    }
  };

  const adoptConflictDocument = (keepDraft: boolean): void => {
    if (!conflict) return;
    setDocument(conflict);
    setBaseContents(conflict.contents);
    setValidatedDraft(undefined);
    setValidationState("validating");
    if (!keepDraft) {
      setFriendlyDraftContents(undefined);
      setFriendlySections(friendlyConfigSections(conflict.contents));
      setDraft(conflict.contents);
    }
    setConflict(undefined);
    setMessage(
      keepDraft ? "Using the latest disk revision; review before saving your draft over it." : "Reloaded from disk.",
    );
  };

  const revert = (): void => {
    changeDraft(baseContents);
    setFriendly(friendlyValuesFromConfig(baseConfig));
  };

  const jumpToDiagnostic = (diagnostic: ConfigDiagnostic): void => {
    if (!diagnostic.line || (diagnostic.source && diagnostic.source !== document?.path)) return;
    const textarea = textAreaRef.current;
    if (!textarea) return;
    const lines = draft.replaceAll("\r\n", "\n").split(/(?<=\n)/u);
    const start = lines.slice(0, diagnostic.line - 1).join("").length;
    const end = start + (lines[diagnostic.line - 1]?.replace(/[\r\n]+$/u, "").length ?? 0);
    textarea.focus();
    textarea.setSelectionRange(start, end);
  };

  return (
    <div className="advanced-config">
      <div className="advanced-config-toolbar">
        <div className="settings-segmented" role="tablist" aria-label="Advanced editor mode">
          <button type="button" role="tab" aria-selected={mode === "raw"} onClick={() => setMode("raw")}>
            Raw config
          </button>
          <button type="button" role="tab" aria-selected={mode === "friendly"} onClick={() => setMode("friendly")}>
            Friendly editor
          </button>
        </div>
        <span className={`config-validation-status is-${validationState}`}>
          {loading
            ? "Loading…"
            : validationState === "validating"
              ? "Validating…"
              : validationState === "valid"
                ? inheritedErrorCount > 0
                  ? `Valid · ${inheritedErrorCount} inherited errors`
                  : "Valid · visual preview"
                : validationState === "invalid"
                  ? "Needs attention"
                  : "Not validated"}
        </span>
      </div>

      {pendingImport ? (
        <div className="config-import-stage" role="status">
          <div>
            <strong>Import {pendingImport.name}?</strong>
            <p>{pendingImport.notice ?? "The selected text will be staged in the editor."}</p>
          </div>
          <span>
            <button type="button" onClick={() => applyImport("replace")}>
              Replace draft
            </button>
            <button type="button" onClick={() => applyImport("append")}>
              Append
            </button>
            <button type="button" onClick={() => setPendingImport(undefined)}>
              Cancel
            </button>
          </span>
        </div>
      ) : null}

      {conflict ? (
        <div className="config-conflict" role="alert">
          <div>
            <strong>The config changed on disk.</strong>
            <p>Nothing was overwritten. Compare the current disk version before choosing which base to use.</p>
            <details>
              <summary>Show current disk version</summary>
              <pre>{conflict.contents || "(empty file)"}</pre>
            </details>
          </div>
          <span>
            <button type="button" onClick={() => adoptConflictDocument(false)}>
              Use disk version
            </button>
            <button type="button" onClick={() => adoptConflictDocument(true)}>
              Keep draft on latest revision
            </button>
          </span>
        </div>
      ) : null}

      <div className="advanced-config-body">
        {mode === "raw" ? (
          <RawEditor
            draft={draft}
            document={document}
            documentStatus={loading ? "Loading…" : "Unavailable"}
            lineNumbers={lineNumbers}
            textAreaRef={textAreaRef}
            gutterRef={gutterRef}
            onChange={changeDraft}
            onImportGhostty={() => void stageImport(editor.importGhostty)}
            onImportFile={() => void stageImport(editor.importFile)}
            onExport={() => void exportDraft()}
            onOpenExternal={editor.openExternal}
            byteCount={byteCount}
            dirty={dirty}
            disabled={editorDisabled}
            lineEnding={preferredConfigNewline(draft, preferredConfigNewline(baseContents))}
          />
        ) : (
          <FriendlyEditor
            values={friendly}
            hasOverrides={friendlySections.size > 0}
            onChange={updateFriendly}
            onPaddingChange={updatePadding}
            onReset={resetFriendly}
            mismatches={friendlyMismatches}
            disabled={editorDisabled}
          />
        )}

        <aside className="config-inspector" aria-label="Configuration validation">
          <section>
            <h2>Validation</h2>
            <p className="appearance-help">
              {errorCount} errors ({blockingErrorCount} in this draft) · {warningCount} warnings · {diagnostics.length}{" "}
              diagnostics
            </p>
            <div className="config-diagnostics">
              {diagnostics.length === 0 ? (
                <p className="config-empty-state">No diagnostics.</p>
              ) : (
                diagnostics.map((diagnostic, index) => {
                  const local = !diagnostic.source || diagnostic.source === document?.path;
                  return (
                    <button
                      type="button"
                      key={`${diagnostic.code}-${diagnostic.source ?? "global"}-${diagnostic.line ?? index}`}
                      className={`is-${diagnostic.severity}`}
                      disabled={!local || !diagnostic.line}
                      onClick={() => jumpToDiagnostic(diagnostic)}
                    >
                      <strong>{diagnostic.severity}</strong>
                      <span>{diagnostic.message}</span>
                      <small>
                        {sourceName(diagnostic.source)}
                        {diagnostic.line ? `:${diagnostic.line}` : ""}
                      </small>
                    </button>
                  );
                })
              )}
            </div>
          </section>
          <section>
            <h2>Effective settings</h2>
            <dl className="config-effective">
              <div>
                <dt>Font</dt>
                <dd>{previewConfig.renderer.fontSize}px</dd>
              </div>
              <div>
                <dt>Scrollback</dt>
                <dd>{formatBytes(previewConfig.terminal.scrollbackBytes)}</dd>
              </div>
              <div>
                <dt>Sources</dt>
                <dd>{previewConfig.sources.length}</dd>
              </div>
              <div>
                <dt>Supported keys</dt>
                <dd>{previewConfig.configuredKeys.filter((key) => key.support !== "unsupported").length}</dd>
              </div>
            </dl>
            <details className="config-sources">
              <summary>Loaded sources</summary>
              <ul>
                {previewConfig.sources.map((source) => (
                  <li key={`${source.kind}-${source.path}`}>
                    <span>{source.kind}</span>
                    <code title={source.path}>{sourceName(source.path)}</code>
                  </li>
                ))}
              </ul>
            </details>
          </section>
        </aside>
      </div>

      {error ? (
        <p className="appearance-error" role="alert">
          {error}
        </p>
      ) : null}
      {message ? (
        <p className="config-message" role="status">
          {message}
        </p>
      ) : null}
      <footer>
        <span className="config-footer-status">
          {dirty ? "Unsaved draft" : "Saved"} · {byteCount.toLocaleString()} / {MAX_CONFIG_BYTES.toLocaleString()} bytes
        </span>
        <button type="button" disabled={!dirty || saving} onClick={revert}>
          Revert
        </button>
        <button type="button" onClick={onClose}>
          Close
        </button>
        <button
          type="button"
          className="appearance-save"
          disabled={
            !dirty ||
            saving ||
            loading ||
            validationState !== "valid" ||
            validatedDraft !== draft ||
            blockingErrorCount > 0 ||
            Boolean(conflict) ||
            Boolean(pendingImport) ||
            (mode === "friendly" && friendlyMismatches.length > 0)
          }
          onClick={() => void save()}
        >
          {saving ? "Saving…" : "Save & load"}
        </button>
      </footer>
    </div>
  );
}

interface RawEditorProps {
  draft: string;
  document: ConfigDocument | undefined;
  documentStatus: string;
  lineNumbers: string;
  textAreaRef: React.RefObject<HTMLTextAreaElement | null>;
  gutterRef: React.RefObject<HTMLPreElement | null>;
  onChange: (contents: string) => void;
  onImportGhostty: () => void;
  onImportFile: () => void;
  onExport: () => void;
  onOpenExternal: (() => void) | undefined;
  byteCount: number;
  dirty: boolean;
  disabled: boolean;
  lineEnding: "\n" | "\r\n";
}

function RawEditor({
  draft,
  document,
  documentStatus,
  lineNumbers,
  textAreaRef,
  gutterRef,
  onChange,
  onImportGhostty,
  onImportFile,
  onExport,
  onOpenExternal,
  byteCount,
  dirty,
  disabled,
  lineEnding,
}: RawEditorProps) {
  return (
    <section className="raw-config-editor">
      <div className="config-editor-actions">
        <button type="button" disabled={disabled} onClick={onImportGhostty}>
          Import from Ghostty
        </button>
        <button type="button" disabled={disabled} onClick={onImportFile}>
          Import file…
        </button>
        <button type="button" disabled={disabled} onClick={onExport}>
          Export…
        </button>
        {onOpenExternal ? (
          <button type="button" onClick={onOpenExternal}>
            Open externally…
          </button>
        ) : null}
      </div>
      <div className="config-document-meta">
        <strong>Profile override</strong>
        <code title={document?.path}>{document?.path ? sourceName(document.path) : documentStatus}</code>
        <span>{document?.exists ? "On disk" : "New file"}</span>
      </div>
      <div className="config-code-editor">
        <pre ref={gutterRef} aria-hidden="true">
          {lineNumbers}
        </pre>
        <textarea
          ref={textAreaRef}
          value={draft}
          onChange={(event) => onChange(applyConfigTextareaEdit(draft, event.currentTarget.value, lineEnding))}
          onScroll={(event) => {
            if (gutterRef.current) gutterRef.current.scrollTop = event.currentTarget.scrollTop;
          }}
          aria-label="Ghostty profile configuration"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          readOnly={disabled}
        />
      </div>
      <p className="appearance-help config-editor-help">
        Validation runs after each edit. View-owned colors, opacity, and bundled shaders preview immediately; palette,
        model, and startup settings wait for Save &amp; load.{" "}
        {dirty ? "This draft differs from disk." : "This draft matches disk."} ({byteCount.toLocaleString()} bytes)
      </p>
    </section>
  );
}

interface FriendlyEditorProps {
  values: FriendlyConfigValues;
  hasOverrides: boolean;
  onChange: (update: Partial<FriendlyConfigValues>, section: FriendlyConfigSection) => void;
  onPaddingChange: (axis: "paddingX" | "paddingY", index: 0 | 1, value: number) => void;
  onReset: () => void;
  mismatches: readonly string[];
  disabled: boolean;
}

function FriendlyEditor({
  values,
  hasOverrides,
  onChange,
  onPaddingChange,
  onReset,
  mismatches,
  disabled,
}: FriendlyEditorProps) {
  const changeColors = (update: Partial<FriendlyConfigValues>): void => onChange(update, "colors");
  return (
    <section className="friendly-config-editor">
      <div className="friendly-heading">
        <div>
          <h2>Common settings</h2>
          <p className="appearance-help">
            Changes generate a visible managed block in the same raw draft. Reset removes that block and restores
            inherited values.
          </p>
        </div>
        <button type="button" disabled={disabled || !hasOverrides} onClick={onReset}>
          Reset overrides
        </button>
      </div>

      {mismatches.length > 0 ? (
        <div className="friendly-shadow-warning" role="alert">
          An included configuration layer overrides: {mismatches.join(", ")}. Use Raw config to review the include.
        </div>
      ) : null}

      <fieldset disabled={disabled}>
        <legend>
          Colors <span>Live preview</span>
        </legend>
        <div className="friendly-color-grid">
          <ColorField label="Foreground" field="foreground" value={values.foreground} onChange={changeColors} />
          <ColorField label="Background" field="background" value={values.background} onChange={changeColors} />
          <ColorField label="Cursor" field="cursor" value={values.cursor} onChange={changeColors} />
          <ColorField label="Cursor text" field="cursorText" value={values.cursorText} onChange={changeColors} />
          <ColorField
            label="Selection"
            field="selectionBackground"
            value={values.selectionBackground}
            onChange={changeColors}
          />
          <ColorField
            label="Selection text"
            field="selectionForeground"
            value={values.selectionForeground}
            onChange={changeColors}
          />
        </div>
        <label className="appearance-range">
          <span>
            Background opacity <output>{Math.round(values.backgroundOpacity * 100)}%</output>
          </span>
          <input
            type="range"
            min="0"
            max="1"
            step="0.01"
            value={values.backgroundOpacity}
            onChange={(event) => onChange({ backgroundOpacity: event.currentTarget.valueAsNumber }, "opacity")}
          />
        </label>
        <label className="appearance-check">
          <input
            type="checkbox"
            checked={values.backgroundOpacityCells}
            onChange={(event) => onChange({ backgroundOpacityCells: event.currentTarget.checked }, "opacity")}
          />
          <span>Apply opacity to explicit cell backgrounds</span>
        </label>
      </fieldset>

      <fieldset disabled={disabled}>
        <legend>
          Typography &amp; layout <span>Startup / parsed only</span>
        </legend>
        <div className="friendly-field-grid">
          <label>
            <span>Font size</span>
            <input
              type="number"
              min="1"
              step="0.5"
              value={values.fontSize}
              onChange={(event) => {
                const value = event.currentTarget.valueAsNumber;
                if (Number.isFinite(value) && value > 0) onChange({ fontSize: value }, "typography");
              }}
            />
          </label>
          <NumberField
            label="Padding left"
            value={values.paddingX[0]}
            onChange={(value) => onPaddingChange("paddingX", 0, value)}
          />
          <NumberField
            label="Padding right"
            value={values.paddingX[1]}
            onChange={(value) => onPaddingChange("paddingX", 1, value)}
          />
          <NumberField
            label="Padding top"
            value={values.paddingY[0]}
            onChange={(value) => onPaddingChange("paddingY", 0, value)}
          />
          <NumberField
            label="Padding bottom"
            value={values.paddingY[1]}
            onChange={(value) => onPaddingChange("paddingY", 1, value)}
          />
        </div>
        <label className="friendly-textarea-field">
          <span>
            Font families <small>one fallback per line</small>
          </span>
          <textarea
            rows={3}
            value={values.fontFamilies.join("\n")}
            onChange={(event) => onChange({ fontFamilies: event.currentTarget.value.split(/\r?\n/u) }, "typography")}
            spellCheck={false}
          />
        </label>
        <p className="appearance-help">
          Desktop font metrics are selected at startup. Padding is preserved in the effective config but is not applied
          by the current fixed desktop grid.
        </p>
      </fieldset>

      <fieldset disabled={disabled}>
        <legend>Sessions &amp; keyboard</legend>
        <label className="friendly-number-wide">
          <span>
            Scrollback limit <small>bytes · new sessions</small>
          </span>
          <input
            type="number"
            min="0"
            step="100000"
            value={values.scrollbackLimit}
            onChange={(event) => {
              const value = event.currentTarget.valueAsNumber;
              if (Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER) {
                onChange({ scrollbackLimit: value }, "scrollback");
              }
            }}
          />
        </label>
        <label className="appearance-check">
          <input
            type="checkbox"
            checked={values.clearKeybindings}
            onChange={(event) => onChange({ clearKeybindings: event.currentTarget.checked }, "keybindings")}
          />
          <span>Clear Ghostty default keybindings before applying these entries</span>
        </label>
        <label className="friendly-textarea-field">
          <span>
            Keybindings <small>one trigger=action per line · supported entries live</small>
          </span>
          <textarea
            rows={5}
            value={values.keybindings.join("\n")}
            onChange={(event) => onChange({ keybindings: event.currentTarget.value.split(/\r?\n/u) }, "keybindings")}
            spellCheck={false}
          />
        </label>
      </fieldset>
    </section>
  );
}

function ColorField({
  label,
  field,
  value,
  onChange,
}: {
  label: string;
  field: ColorKey;
  value: string;
  onChange: (update: Partial<FriendlyConfigValues>) => void;
}) {
  return (
    <label className="friendly-color">
      <input type="color" value={value} onChange={(event) => onChange({ [field]: event.currentTarget.value })} />
      <span>
        <strong>{label}</strong>
        <code>{value}</code>
      </span>
    </label>
  );
}

function NumberField({ label, value, onChange }: { label: string; value: number; onChange: (value: number) => void }) {
  return (
    <label>
      <span>{label}</span>
      <input
        type="number"
        min="0"
        step="1"
        value={value}
        onChange={(event) => onChange(event.currentTarget.valueAsNumber)}
      />
    </label>
  );
}

function sourceName(path: string | undefined): string {
  if (!path) return "global";
  return path.split(/[\\/]/u).filter(Boolean).at(-1) ?? path;
}

function formatBytes(bytes: number): string {
  if (bytes < 1_000_000) return `${Math.round(bytes / 1_000)} KB`;
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
