import { useEffect, useMemo, useState } from "react";
import type { ConfigSnapshot } from "@vibecook/ghosttea-protocol";
import { GHOSTTY_COLOR_THEMES, colorThemeFromRenderer, findMatchingColorTheme } from "./catalog.js";
import { GHOSTTEA_SHADER_OPTIONS, UNAVAILABLE_UPSTREAM_SHADERS, isGhostteaShaderEffect } from "./shaders.js";
import type { GhostteaAppearanceUpdate } from "./types.js";
import type { TerminalShaderEffect } from "../renderers/types.js";

export interface AppearanceSettingsProps {
  config: ConfigSnapshot;
  onClose: () => void;
  onSave: (update: GhostteaAppearanceUpdate) => Promise<void>;
}

export function AppearanceSettings({ config, onClose, onSave }: AppearanceSettingsProps) {
  const matchedTheme = findMatchingColorTheme(config.renderer);
  const currentTheme = colorThemeFromRenderer(config.renderer);
  const [themeName, setThemeName] = useState<string | null>(matchedTheme?.name ?? null);
  const [query, setQuery] = useState("");
  const [opacity, setOpacity] = useState(config.renderer.backgroundOpacity ?? 1);
  const [opacityCells, setOpacityCells] = useState(config.renderer.backgroundOpacityCells ?? false);
  const [effects, setEffects] = useState<TerminalShaderEffect[]>(
    config.renderer.shaderEffects?.filter(isGhostteaShaderEffect) ??
      (config.renderer.postProcess === "better-crt" ? ["ghosttea:better-crt"] : []),
  );
  const [animation, setAnimation] = useState(config.renderer.customShaderAnimation ?? false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const selectedTheme = themeName ? GHOSTTY_COLOR_THEMES.find((theme) => theme.name === themeName) : undefined;
  const previewTheme = selectedTheme ?? currentTheme;
  const filteredThemes = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    if (!normalized) return GHOSTTY_COLOR_THEMES.slice(0, 80);
    return GHOSTTY_COLOR_THEMES.filter((theme) => theme.name.toLocaleLowerCase().includes(normalized)).slice(0, 120);
  }, [query]);

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", closeOnEscape, true);
    return () => window.removeEventListener("keydown", closeOnEscape, true);
  }, [onClose]);

  const toggleEffect = (id: TerminalShaderEffect): void => {
    setEffects((current) => (current.includes(id) ? current.filter((effect) => effect !== id) : [...current, id]));
  };
  const moveEffect = (id: TerminalShaderEffect, offset: -1 | 1): void => {
    setEffects((current) => {
      const index = current.indexOf(id);
      const target = index + offset;
      if (index < 0 || target < 0 || target >= current.length) return current;
      const next = [...current];
      [next[index], next[target]] = [next[target]!, next[index]!];
      return next;
    });
  };
  const save = async (): Promise<void> => {
    setSaving(true);
    setError(undefined);
    try {
      await onSave({
        ...(selectedTheme ? { theme: selectedTheme } : {}),
        backgroundOpacity: opacity,
        backgroundOpacityCells: opacityCells,
        shaderEffects: effects,
        shaderAnimation: animation,
      });
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="appearance-settings-backdrop"
      role="presentation"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <section
        className="appearance-settings"
        role="dialog"
        aria-modal="true"
        aria-labelledby="appearance-settings-title"
      >
        <header>
          <div>
            <h1 id="appearance-settings-title">Appearance</h1>
            <p>Color themes and ordered WebGPU effects apply to every terminal in this profile.</p>
          </div>
          <button type="button" className="appearance-close" onClick={onClose} aria-label="Close appearance settings">
            ×
          </button>
        </header>

        <div className="appearance-settings-grid">
          <section className="appearance-panel">
            <h2>
              Color theme <span>{GHOSTTY_COLOR_THEMES.length}</span>
            </h2>
            <input
              className="appearance-search"
              value={query}
              onChange={(event) => setQuery(event.currentTarget.value)}
              placeholder="Search Ghostty themes"
              aria-label="Search Ghostty themes"
              autoFocus
            />
            <div className="appearance-theme-list" role="listbox" aria-label="Color themes">
              {!matchedTheme ? (
                <ThemeChoice theme={currentTheme} selected={themeName === null} onSelect={() => setThemeName(null)} />
              ) : null}
              {selectedTheme && !filteredThemes.some((theme) => theme.name === selectedTheme.name) ? (
                <ThemeChoice theme={selectedTheme} selected onSelect={() => setThemeName(selectedTheme.name)} />
              ) : null}
              {filteredThemes.map((theme) => (
                <ThemeChoice
                  key={theme.name}
                  theme={theme}
                  selected={theme.name === selectedTheme?.name}
                  onSelect={() => setThemeName(theme.name)}
                />
              ))}
            </div>
          </section>

          <section className="appearance-panel appearance-details">
            <h2>Preview</h2>
            <div
              className="appearance-preview"
              style={{ color: previewTheme.foreground, background: previewTheme.background }}
            >
              <div className="appearance-preview-dots">
                {previewTheme.palette.slice(1, 7).map((color, index) => (
                  <i key={`${color}-${index}`} style={{ background: color }} />
                ))}
              </div>
              <code>
                <span style={{ color: previewTheme.palette[2] }}>ghosttea</span>{" "}
                <span style={{ color: previewTheme.palette[4] }}>~/projects</span> $ cargo test
                <br />
                All systems steeping.
              </code>
              <i
                className="appearance-preview-cursor"
                style={{ color: previewTheme.cursorText, background: previewTheme.cursor }}
              >
                _
              </i>
            </div>

            <label className="appearance-range">
              <span>
                Background opacity <output>{Math.round(opacity * 100)}%</output>
              </span>
              <input
                type="range"
                min="0"
                max="1"
                step="0.01"
                value={opacity}
                onChange={(event) => setOpacity(event.currentTarget.valueAsNumber)}
              />
            </label>
            <label className="appearance-check">
              <input
                type="checkbox"
                checked={opacityCells}
                onChange={(event) => setOpacityCells(event.currentTarget.checked)}
              />
              <span>Apply opacity to explicit cell backgrounds</span>
            </label>
            <p className="appearance-help">
              Desktop-through transparency is enabled by the macOS host; framed Windows and Linux hosts preserve alpha
              inside the renderer but remain OS-opaque.
            </p>

            <h2>Shader stack</h2>
            <p className="appearance-help">
              Effects run top-to-bottom. Animated effects repaint while this window is focused.
            </p>
            <div className="appearance-shader-list">
              {[...GHOSTTEA_SHADER_OPTIONS]
                .sort((left, right) => {
                  const leftIndex = effects.indexOf(left.id);
                  const rightIndex = effects.indexOf(right.id);
                  if (leftIndex >= 0 && rightIndex >= 0) return leftIndex - rightIndex;
                  if (leftIndex >= 0) return -1;
                  if (rightIndex >= 0) return 1;
                  return 0;
                })
                .map((shader) => {
                  const stackIndex = effects.indexOf(shader.id);
                  return (
                    <div key={shader.id} className="appearance-shader">
                      <label>
                        <input type="checkbox" checked={stackIndex >= 0} onChange={() => toggleEffect(shader.id)} />
                        <span>
                          <strong>
                            {stackIndex >= 0 ? `${stackIndex + 1}. ` : ""}
                            {shader.name}
                          </strong>
                          <small>{shader.description}</small>
                          <em>{shader.license}</em>
                        </span>
                      </label>
                      {stackIndex >= 0 ? (
                        <span className="appearance-shader-order" aria-label={`Reorder ${shader.name}`}>
                          <button
                            type="button"
                            disabled={stackIndex === 0}
                            onClick={() => moveEffect(shader.id, -1)}
                            aria-label={`Move ${shader.name} up`}
                          >
                            ↑
                          </button>
                          <button
                            type="button"
                            disabled={stackIndex === effects.length - 1}
                            onClick={() => moveEffect(shader.id, 1)}
                            aria-label={`Move ${shader.name} down`}
                          >
                            ↓
                          </button>
                        </span>
                      ) : null}
                    </div>
                  );
                })}
            </div>
            <label className="appearance-check">
              <input
                type="checkbox"
                checked={animation}
                onChange={(event) => setAnimation(event.currentTarget.checked)}
              />
              <span>Animate shader stack</span>
            </label>
            <details className="appearance-unavailable">
              <summary>
                {UNAVAILABLE_UPSTREAM_SHADERS.length} upstream shaders awaiting redistribution clearance
              </summary>
              <p>{UNAVAILABLE_UPSTREAM_SHADERS.join(", ")}</p>
            </details>
          </section>
        </div>
        {error ? (
          <p className="appearance-error" role="alert">
            {error}
          </p>
        ) : null}
        <footer>
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="appearance-save" disabled={saving} onClick={() => void save()}>
            {saving ? "Applying…" : "Apply"}
          </button>
        </footer>
      </section>
    </div>
  );
}

function ThemeChoice({
  theme,
  selected,
  onSelect,
}: {
  theme: (typeof GHOSTTY_COLOR_THEMES)[number];
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      className={selected ? "is-selected" : ""}
      onClick={onSelect}
    >
      <span className="appearance-swatches" style={{ background: theme.background }}>
        {theme.palette.slice(1, 5).map((color, index) => (
          <i key={`${color}-${index}`} style={{ background: color }} />
        ))}
      </span>
      <span>{theme.name}</span>
    </button>
  );
}
