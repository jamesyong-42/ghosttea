//! Ghostty-compatible configuration loading with explicit compatibility
//! reporting.
//!
//! Ghosttea accepts Ghostty's `key = value` syntax and source layering, then
//! projects the values it can currently honor into platform-neutral terminal,
//! renderer, and workspace settings. Recognized-but-unimplemented keys are
//! retained as capabilities and reported as diagnostics instead of being
//! silently accepted.

use std::{
    collections::{BTreeMap, BTreeSet, HashSet, VecDeque},
    env, fs,
    path::{Path, PathBuf},
    sync::{Arc, RwLock},
};

use serde::{Deserialize, Serialize};

pub const CONFIG_SCHEMA_VERSION: u32 = 1;
pub const GHOSTTY_CONFIG_COMPAT_VERSION: &str = "1.3.1";
pub const GHOSTTY_CONFIG_COMPAT_COMMIT: &str = "332b2aefc6e72d363aa93ab6ecfc86eeeeb5ed28";
// Retain the original public names as source-compatible aliases. These refer
// to the independently pinned config release, not the Ghostty VT build.
pub const GHOSTTY_COMPAT_VERSION: &str = GHOSTTY_CONFIG_COMPAT_VERSION;
pub const GHOSTTY_COMPAT_COMMIT: &str = GHOSTTY_CONFIG_COMPAT_COMMIT;
pub const DEFAULT_SCROLLBACK_BYTES: u64 = 10_000_000;
pub const GHOSTTEA_BETTER_CRT_SHADER: &str = "ghosttea:better-crt";

const DEFAULT_BACKGROUND: [u8; 3] = [0x28, 0x2c, 0x34];
const DEFAULT_FOREGROUND: [u8; 3] = [0xff, 0xff, 0xff];
const DEFAULT_FONT_SIZE_MACOS: f32 = 13.0;
const DEFAULT_FONT_SIZE_OTHER: f32 = 12.0;
const MAX_JSON_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const KNOWN_KEYS_TEXT: &str = include_str!("known-keys.txt");
const X11_COLORS_TEXT: &str = include_str!("x11-rgb.txt");

#[derive(Clone, Debug)]
pub struct ConfigLoadOptions {
    /// Load Ghostty's standard XDG and macOS files before the overlay.
    pub load_default_files: bool,
    /// A Ghosttea-owned final overlay. This is also the file opened by the UI.
    pub explicit_path: Option<PathBuf>,
    /// Test/embedding override. `None` resolves from `HOME` when loading.
    pub home_dir: Option<PathBuf>,
    /// Test/embedding override. `None` resolves from `XDG_CONFIG_HOME`.
    pub xdg_config_home: Option<PathBuf>,
    /// Test/embedding override for Ghostty's Windows `LOCALAPPDATA` fallback.
    pub local_app_data: Option<PathBuf>,
    /// Treat the host as macOS when adding Application Support paths.
    pub macos: bool,
    /// Treat the host as Windows when resolving XDG and home fallbacks.
    pub windows: bool,
}

impl Default for ConfigLoadOptions {
    fn default() -> Self {
        Self {
            load_default_files: true,
            explicit_path: None,
            home_dir: None,
            xdg_config_home: None,
            local_app_data: None,
            macos: cfg!(target_os = "macos"),
            windows: cfg!(target_os = "windows"),
        }
    }
}

impl ConfigLoadOptions {
    pub fn explicit(path: impl Into<PathBuf>) -> Self {
        Self {
            load_default_files: false,
            explicit_path: Some(path.into()),
            ..Self::default()
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ConfigSnapshot {
    pub schema_version: u32,
    pub revision: String,
    pub compatibility: ConfigCompatibility,
    pub sources: Vec<ConfigSource>,
    pub diagnostics: Vec<ConfigDiagnostic>,
    pub configured_keys: Vec<ConfiguredKey>,
    pub terminal: TerminalConfig,
    pub renderer: RendererConfig,
    pub workspace: WorkspaceConfig,
}

impl ConfigSnapshot {
    pub fn has_errors(&self) -> bool {
        self.diagnostics
            .iter()
            .any(|diagnostic| diagnostic.severity == DiagnosticSeverity::Error)
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConfigCompatibility {
    pub ghostty_version: String,
    pub ghostty_commit: String,
    pub known_key_count: usize,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConfigSource {
    pub path: String,
    pub kind: ConfigSourceKind,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum ConfigSourceKind {
    GhosttyDefault,
    Included,
    GhostteaOverlay,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConfigDiagnostic {
    pub severity: DiagnosticSeverity,
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub line: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub key: Option<String>,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum DiagnosticSeverity {
    Info,
    Warning,
    Error,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConfiguredKey {
    pub key: String,
    pub support: ConfigSupport,
    pub occurrences: usize,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum ConfigSupport {
    Applied,
    Parsed,
    Unsupported,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TerminalConfig {
    pub scrollback_bytes: u64,
    pub foreground: [u8; 3],
    pub background: [u8; 3],
    pub cursor: [u8; 3],
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RendererConfig {
    pub foreground: [u8; 3],
    pub background: [u8; 3],
    pub cursor: [u8; 3],
    pub selection_background: [u8; 3],
    pub selection_foreground: [u8; 3],
    pub font_size: f32,
    pub font_families: Vec<String>,
    pub padding_x: [f32; 2],
    pub padding_y: [f32; 2],
    pub post_process: RendererPostProcess,
    pub custom_shader_paths: Vec<String>,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum RendererPostProcess {
    #[default]
    None,
    BetterCrt,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceConfig {
    /// Ordered Ghostty keybind mutations.
    pub keybindings: Vec<KeybindingConfig>,
    /// True when `keybind = clear` removed the default binding set before
    /// later mutations. A subsequent blank `keybind =` restores defaults.
    pub clear_keybindings: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct KeybindingConfig {
    pub trigger: String,
    pub action: String,
}

impl Default for ConfigSnapshot {
    fn default() -> Self {
        let renderer = RendererConfig {
            foreground: DEFAULT_FOREGROUND,
            background: DEFAULT_BACKGROUND,
            cursor: DEFAULT_FOREGROUND,
            selection_background: DEFAULT_FOREGROUND,
            selection_foreground: DEFAULT_BACKGROUND,
            font_size: platform_default_font_size(),
            font_families: Vec::new(),
            padding_x: [2.0, 2.0],
            padding_y: [2.0, 2.0],
            post_process: RendererPostProcess::None,
            custom_shader_paths: Vec::new(),
        };
        Self {
            schema_version: CONFIG_SCHEMA_VERSION,
            revision: String::new(),
            compatibility: ConfigCompatibility {
                ghostty_version: GHOSTTY_COMPAT_VERSION.to_owned(),
                ghostty_commit: GHOSTTY_COMPAT_COMMIT.to_owned(),
                known_key_count: known_keys().len(),
            },
            sources: Vec::new(),
            diagnostics: Vec::new(),
            configured_keys: Vec::new(),
            terminal: TerminalConfig {
                scrollback_bytes: DEFAULT_SCROLLBACK_BYTES,
                foreground: renderer.foreground,
                background: renderer.background,
                cursor: renderer.cursor,
            },
            renderer,
            workspace: WorkspaceConfig::default(),
        }
    }
}

/// A reloadable snapshot holder shared by the daemon's client connections.
#[derive(Clone)]
pub struct ConfigManager {
    options: ConfigLoadOptions,
    snapshot: Arc<RwLock<Arc<ConfigSnapshot>>>,
}

impl ConfigManager {
    pub fn load(options: ConfigLoadOptions) -> Self {
        let snapshot = Arc::new(load_config(&options));
        Self {
            options,
            snapshot: Arc::new(RwLock::new(snapshot)),
        }
    }

    pub fn snapshot(&self) -> Arc<ConfigSnapshot> {
        Arc::clone(&self.snapshot.read().unwrap())
    }

    /// Reload all sources. Returns the new snapshot and whether its effective
    /// content or diagnostics changed.
    pub fn reload(&self) -> (Arc<ConfigSnapshot>, bool) {
        let next = Arc::new(load_config(&self.options));
        let mut current = self.snapshot.write().unwrap();
        let changed = current.revision != next.revision;
        *current = Arc::clone(&next);
        (next, changed)
    }
}

#[derive(Clone, Debug)]
struct Setting {
    key: String,
    value: String,
    source: String,
    line: usize,
    bare: bool,
}

#[derive(Default)]
struct LoadState {
    settings: Vec<Setting>,
    sources: Vec<ConfigSource>,
    diagnostics: Vec<ConfigDiagnostic>,
    configured: BTreeMap<String, usize>,
    loaded_includes: HashSet<PathBuf>,
    home_dir: Option<PathBuf>,
    default_font_size: f32,
}

pub fn load_config(options: &ConfigLoadOptions) -> ConfigSnapshot {
    let mut state = LoadState {
        home_dir: resolved_home(options),
        default_font_size: if options.macos {
            DEFAULT_FONT_SIZE_MACOS
        } else {
            DEFAULT_FONT_SIZE_OTHER
        },
        ..LoadState::default()
    };
    let mut includes = VecDeque::new();
    for (path, kind, optional) in root_sources(options) {
        // Resolve every include discovered in Ghostty's own files before the
        // app-owned overlay, keeping the overlay a true final layer.
        if kind == ConfigSourceKind::GhostteaOverlay {
            drain_includes(&mut includes, &mut state);
        }
        load_file(&path, kind, optional, &mut includes, &mut state);
    }
    drain_includes(&mut includes, &mut state);
    project(state)
}

pub fn standard_config_paths(options: &ConfigLoadOptions) -> Vec<PathBuf> {
    if !options.load_default_files {
        return Vec::new();
    }
    let home = resolved_home(options);
    let xdg = options
        .xdg_config_home
        .clone()
        .or_else(|| {
            env::var_os("XDG_CONFIG_HOME")
                .filter(|value| !value.is_empty())
                .map(PathBuf::from)
        })
        .or_else(|| {
            if options.windows {
                options.local_app_data.clone().or_else(|| {
                    env::var_os("LOCALAPPDATA")
                        .filter(|value| !value.is_empty())
                        .map(PathBuf::from)
                })
            } else {
                None
            }
        })
        .or_else(|| home.as_ref().map(|path| path.join(".config")));
    let mut paths = Vec::new();
    if let Some(xdg) = xdg {
        // Ghostty 1.3.1 loads the legacy name first so `config.ghostty`
        // wins when both files exist.
        paths.push(xdg.join("ghostty/config"));
        paths.push(xdg.join("ghostty/config.ghostty"));
    }
    if options.macos
        && let Some(home) = home
    {
        let directory = home.join("Library/Application Support/com.mitchellh.ghostty");
        paths.push(directory.join("config"));
        paths.push(directory.join("config.ghostty"));
    }
    paths
}

fn resolved_home(options: &ConfigLoadOptions) -> Option<PathBuf> {
    options.home_dir.clone().or_else(|| {
        if options.windows {
            env_path("USERPROFILE")
                .or_else(windows_home_from_drive_and_path)
                .or_else(|| env_path("HOME"))
        } else {
            env_path("HOME")
        }
    })
}

fn env_path(name: &str) -> Option<PathBuf> {
    env::var_os(name)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
}

fn windows_home_from_drive_and_path() -> Option<PathBuf> {
    let drive = env::var_os("HOMEDRIVE").filter(|value| !value.is_empty())?;
    let path = env::var_os("HOMEPATH").filter(|value| !value.is_empty())?;
    let mut joined = drive;
    joined.push(path);
    Some(PathBuf::from(joined))
}

fn root_sources(options: &ConfigLoadOptions) -> Vec<(PathBuf, ConfigSourceKind, bool)> {
    let mut sources = standard_config_paths(options)
        .into_iter()
        .map(|path| (path, ConfigSourceKind::GhosttyDefault, true))
        .collect::<Vec<_>>();
    if let Some(path) = options.explicit_path.as_ref()
        && !sources.iter().any(|(candidate, _, _)| candidate == path)
    {
        sources.push((
            path.clone(),
            ConfigSourceKind::GhostteaOverlay,
            // A not-yet-created application overlay is a valid empty config.
            true,
        ));
    }
    sources
}

fn drain_includes(includes: &mut VecDeque<(PathBuf, bool)>, state: &mut LoadState) {
    while let Some((path, optional)) = includes.pop_front() {
        load_file(&path, ConfigSourceKind::Included, optional, includes, state);
    }
}

fn load_file(
    path: &Path,
    kind: ConfigSourceKind,
    optional: bool,
    includes: &mut VecDeque<(PathBuf, bool)>,
    state: &mut LoadState,
) {
    let identity = normalize_identity(path);
    if kind == ConfigSourceKind::Included {
        // Ghostty de-duplicates entries in its recursive include queue. Root
        // files are not pre-seeded, so a root referenced by config-file is
        // loaded once more before a subsequent reference is diagnosed.
        if !state.loaded_includes.insert(identity) {
            state.diagnostics.push(diagnostic(
                DiagnosticSeverity::Warning,
                "include-cycle",
                format!("configuration include cycle ignored at {}", path.display()),
                Some(path),
                None,
                Some("config-file"),
            ));
            return;
        }
    }
    let text = match fs::read_to_string(path) {
        Ok(text) => text,
        Err(error) if optional && error.kind() == std::io::ErrorKind::NotFound => return,
        Err(error) => {
            state.diagnostics.push(diagnostic(
                DiagnosticSeverity::Error,
                "source-read-failed",
                format!("failed to read configuration {}: {error}", path.display()),
                Some(path),
                None,
                None,
            ));
            return;
        }
    };
    let text = text.strip_prefix('\u{feff}').unwrap_or(&text);
    state.sources.push(ConfigSource {
        path: path.to_string_lossy().into_owned(),
        kind,
    });

    for (index, raw) in text.lines().enumerate() {
        let line = index + 1;
        let trimmed = raw.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        let (raw_key, raw_value, bare) = match raw.split_once('=') {
            Some((key, value)) => (key, value, false),
            None => (raw, "", true),
        };
        let key = raw_key.trim();
        if key.is_empty() {
            state.diagnostics.push(diagnostic(
                DiagnosticSeverity::Warning,
                "empty-key",
                "configuration key must not be empty".to_owned(),
                Some(path),
                Some(line),
                None,
            ));
            continue;
        }
        *state.configured.entry(key.to_owned()).or_default() += 1;
        let (value, quoted) = parse_value(raw_value.trim());
        if key == "config-file" {
            if bare {
                state.diagnostics.push(diagnostic(
                    DiagnosticSeverity::Error,
                    "invalid-value",
                    "`config-file` requires a value".to_owned(),
                    Some(path),
                    Some(line),
                    Some(key),
                ));
                continue;
            }
            if value.is_empty() {
                if !quoted {
                    includes.clear();
                }
                continue;
            }
            let (include_value, include_optional) = if quoted {
                (value.as_str(), false)
            } else {
                value
                    .strip_prefix('?')
                    .map_or((value.as_str(), false), |value| {
                        (strip_surrounding_quotes(value), true)
                    })
            };
            if include_value.is_empty() {
                continue;
            }
            let Some(include_path) = resolve_include_path(include_value, path, line, state) else {
                continue;
            };
            includes.push_back((include_path, include_optional));
            continue;
        }
        state.settings.push(Setting {
            key: key.to_owned(),
            value,
            source: path.to_string_lossy().into_owned(),
            line,
            bare,
        });
    }
}

fn parse_value(value: &str) -> (String, bool) {
    if value.len() >= 2 && value.starts_with('"') && value.ends_with('"') {
        (value[1..value.len() - 1].to_owned(), true)
    } else {
        (value.to_owned(), false)
    }
}

fn strip_surrounding_quotes(value: &str) -> &str {
    if value.len() >= 2 && value.starts_with('"') && value.ends_with('"') {
        &value[1..value.len() - 1]
    } else {
        value
    }
}

fn resolve_include_path(
    value: &str,
    source: &Path,
    line: usize,
    state: &mut LoadState,
) -> Option<PathBuf> {
    let path = PathBuf::from(value);
    if path.is_absolute() {
        return Some(path);
    }
    if let Some(relative) = value.strip_prefix("~/") {
        return match state.home_dir.as_ref() {
            Some(home) => Some(home.join(relative)),
            None => {
                state.diagnostics.push(diagnostic(
                    DiagnosticSeverity::Error,
                    "path-expansion-failed",
                    format!("cannot expand config-file `{value}` without a home directory"),
                    Some(source),
                    Some(line),
                    Some("config-file"),
                ));
                None
            }
        };
    }
    Some(source.parent().unwrap_or_else(|| Path::new(".")).join(path))
}

fn normalize_identity(path: &Path) -> PathBuf {
    path.canonicalize().unwrap_or_else(|_| {
        if path.is_absolute() {
            path.to_owned()
        } else {
            env::current_dir()
                .unwrap_or_else(|_| PathBuf::from("."))
                .join(path)
        }
    })
}

fn project(mut state: LoadState) -> ConfigSnapshot {
    let known = known_keys();
    let mut snapshot = ConfigSnapshot {
        sources: state.sources,
        ..ConfigSnapshot::default()
    };
    snapshot.renderer.font_size = state.default_font_size;
    let mut scalars = Vec::<Setting>::new();
    let mut font_families = Vec::<Setting>::new();
    let mut custom_shaders = Vec::<Setting>::new();
    let mut keybindings = Vec::<Setting>::new();
    let mut clear_keybindings = false;

    for setting in state.settings {
        if !known.contains(setting.key.as_str()) {
            state.diagnostics.push(diagnostic_at(
                DiagnosticSeverity::Warning,
                "unknown-key",
                format!("unknown Ghostty configuration key `{}`", setting.key),
                &setting,
            ));
            continue;
        }
        if setting.bare && support_for_key(&setting.key) != ConfigSupport::Unsupported {
            state.diagnostics.push(diagnostic_at(
                DiagnosticSeverity::Error,
                "invalid-value",
                format!("`{}` requires a value", setting.key),
                &setting,
            ));
            continue;
        }
        match setting.key.as_str() {
            "font-family" => {
                if setting.value.is_empty() {
                    font_families.clear();
                } else {
                    font_families.push(setting);
                }
            }
            "custom-shader" => {
                if setting.value.is_empty() {
                    custom_shaders.clear();
                } else {
                    custom_shaders.push(setting);
                }
            }
            "keybind" => {
                if setting.value.is_empty() {
                    keybindings.clear();
                    clear_keybindings = false;
                } else if setting.value == "clear" {
                    keybindings.clear();
                    clear_keybindings = true;
                } else {
                    keybindings.push(setting);
                }
            }
            _ => {
                scalars.push(setting);
            }
        }
    }

    let mut parsed_only_keys = BTreeSet::new();
    apply_color(
        &scalars,
        "background",
        &mut snapshot.renderer.background,
        DEFAULT_BACKGROUND,
        &mut state.diagnostics,
    );
    apply_color(
        &scalars,
        "foreground",
        &mut snapshot.renderer.foreground,
        DEFAULT_FOREGROUND,
        &mut state.diagnostics,
    );
    snapshot.renderer.cursor = snapshot.renderer.foreground;
    if apply_terminal_color(
        &scalars,
        "cursor-color",
        &mut snapshot.renderer.cursor,
        snapshot.renderer.foreground,
        &mut state.diagnostics,
    ) {
        parsed_only_keys.insert("cursor-color");
    }
    snapshot.renderer.selection_background = snapshot.renderer.foreground;
    snapshot.renderer.selection_foreground = snapshot.renderer.background;
    if apply_terminal_color(
        &scalars,
        "selection-background",
        &mut snapshot.renderer.selection_background,
        snapshot.renderer.foreground,
        &mut state.diagnostics,
    ) {
        parsed_only_keys.insert("selection-background");
    }
    if apply_terminal_color(
        &scalars,
        "selection-foreground",
        &mut snapshot.renderer.selection_foreground,
        snapshot.renderer.background,
        &mut state.diagnostics,
    ) {
        parsed_only_keys.insert("selection-foreground");
    }
    for setting in scalars
        .iter()
        .filter(|setting| setting.key == "scrollback-limit")
    {
        if setting.value.is_empty() {
            snapshot.terminal.scrollback_bytes = DEFAULT_SCROLLBACK_BYTES;
            continue;
        }
        match setting.value.parse::<u64>() {
            Ok(value) if value <= MAX_JSON_SAFE_INTEGER => {
                snapshot.terminal.scrollback_bytes = value;
            }
            _ => state.diagnostics.push(diagnostic_at(
                DiagnosticSeverity::Error,
                "invalid-value",
                format!(
                    "`scrollback-limit` must be a non-negative byte count no greater than {MAX_JSON_SAFE_INTEGER}"
                ),
                setting,
            )),
        }
    }
    for setting in scalars.iter().filter(|setting| setting.key == "font-size") {
        if setting.value.is_empty() {
            snapshot.renderer.font_size = state.default_font_size;
            continue;
        }
        match setting.value.parse::<f32>() {
            Ok(value) if value.is_finite() && value > 0.0 => {
                snapshot.renderer.font_size = value;
            }
            _ => state.diagnostics.push(diagnostic_at(
                DiagnosticSeverity::Error,
                "invalid-value",
                "`font-size` must be a positive number".to_owned(),
                setting,
            )),
        }
    }
    apply_padding(
        &scalars,
        "window-padding-x",
        &mut snapshot.renderer.padding_x,
        [2.0, 2.0],
        &mut state.diagnostics,
    );
    apply_padding(
        &scalars,
        "window-padding-y",
        &mut snapshot.renderer.padding_y,
        [2.0, 2.0],
        &mut state.diagnostics,
    );
    snapshot.renderer.font_families = font_families
        .iter()
        .map(|setting| setting.value.clone())
        .collect();

    for setting in custom_shaders {
        if setting.value == GHOSTTEA_BETTER_CRT_SHADER {
            snapshot.renderer.post_process = RendererPostProcess::BetterCrt;
        } else {
            snapshot
                .renderer
                .custom_shader_paths
                .push(setting.value.clone());
            state.diagnostics.push(diagnostic_at(
                DiagnosticSeverity::Warning,
                "unsupported-custom-shader",
                format!(
                    "custom shader `{}` was imported but cannot run in Ghosttea's WGSL renderer",
                    setting.value
                ),
                &setting,
            ));
        }
    }

    snapshot.workspace.clear_keybindings = clear_keybindings;
    for setting in keybindings {
        let Some((trigger, action)) = split_keybinding(&setting.value) else {
            state.diagnostics.push(diagnostic_at(
                DiagnosticSeverity::Error,
                "invalid-keybind",
                "`keybind` must use `trigger=action`".to_owned(),
                &setting,
            ));
            continue;
        };
        if trigger.trim().is_empty() {
            state.diagnostics.push(diagnostic_at(
                DiagnosticSeverity::Error,
                "invalid-keybind",
                "`keybind` trigger must not be empty".to_owned(),
                &setting,
            ));
            continue;
        }
        if action.trim().is_empty() {
            state.diagnostics.push(diagnostic_at(
                DiagnosticSeverity::Error,
                "invalid-keybind",
                "`keybind` action must not be empty".to_owned(),
                &setting,
            ));
            continue;
        }
        snapshot.workspace.keybindings.push(KeybindingConfig {
            trigger: trigger.trim().to_owned(),
            action: action.trim().to_owned(),
        });
    }

    snapshot.terminal.foreground = snapshot.renderer.foreground;
    snapshot.terminal.background = snapshot.renderer.background;
    snapshot.terminal.cursor = snapshot.renderer.cursor;

    let mut unsupported_reported = BTreeSet::new();
    snapshot.configured_keys = state
        .configured
        .into_iter()
        .map(|(key, occurrences)| {
            let support = if parsed_only_keys.contains(key.as_str()) {
                ConfigSupport::Parsed
            } else {
                support_for_key(&key)
            };
            if known.contains(key.as_str())
                && support == ConfigSupport::Unsupported
                && unsupported_reported.insert(key.clone())
            {
                state.diagnostics.push(ConfigDiagnostic {
                    severity: DiagnosticSeverity::Info,
                    code: "recognized-not-applied".to_owned(),
                    message: format!(
                        "Ghostty key `{key}` is recognized by the compatibility schema but is not applied yet"
                    ),
                    source: None,
                    line: None,
                    key: Some(key.clone()),
                });
            }
            ConfiguredKey {
                key,
                support,
                occurrences,
            }
        })
        .collect();
    snapshot.diagnostics = state.diagnostics;
    snapshot.revision = snapshot_revision(&snapshot);
    snapshot
}

fn split_keybinding(value: &str) -> Option<(&str, &str)> {
    for (index, _) in value.match_indices('=') {
        let trigger = &value[..index];
        if valid_keybinding_trigger(trigger) {
            return Some((trigger, &value[index + 1..]));
        }
    }
    None
}

fn valid_keybinding_trigger(value: &str) -> bool {
    let mut value = value.trim();
    for prefix in ["all:", "global:", "unconsumed:", "performable:"] {
        while let Some(rest) = value.strip_prefix(prefix) {
            value = rest;
        }
    }
    loop {
        let previous = value;
        for modifier in [
            "super+", "cmd+", "command+", "ctrl+", "control+", "shift+", "alt+", "opt+", "option+",
        ] {
            if let Some(rest) = value.strip_prefix(modifier) {
                value = rest;
                break;
            }
        }
        if value == previous {
            break;
        }
    }
    !value.is_empty()
}

fn apply_color(
    scalars: &[Setting],
    key: &str,
    output: &mut [u8; 3],
    reset: [u8; 3],
    diagnostics: &mut Vec<ConfigDiagnostic>,
) {
    for setting in scalars.iter().filter(|setting| setting.key == key) {
        if setting.value.is_empty() {
            *output = reset;
            continue;
        }
        match parse_color(&setting.value) {
            Some(value) => *output = value,
            None => diagnostics.push(diagnostic_at(
                DiagnosticSeverity::Error,
                "invalid-color",
                format!("`{key}` must be a valid Ghostty color"),
                setting,
            )),
        }
    }
}

/// Apply a Ghostty `TerminalColor` to the fixed-color runtime projection.
///
/// Cell color references are valid Ghostty syntax, but their value is chosen
/// per rendered cell. Keep the last representable fixed value and report that
/// the dynamic value was parsed rather than pretending it is globally fixed.
/// Returns true when the effective final value is a dynamic reference.
fn apply_terminal_color(
    scalars: &[Setting],
    key: &str,
    output: &mut [u8; 3],
    reset: [u8; 3],
    diagnostics: &mut Vec<ConfigDiagnostic>,
) -> bool {
    let mut dynamic = false;
    for setting in scalars.iter().filter(|setting| setting.key == key) {
        if setting.value.is_empty() {
            *output = reset;
            dynamic = false;
            continue;
        }
        if matches!(
            setting.value.as_str(),
            "cell-foreground" | "cell-background"
        ) {
            dynamic = true;
            diagnostics.push(diagnostic_at(
                DiagnosticSeverity::Warning,
                "dynamic-color-not-applied",
                format!(
                    "`{key} = {}` is valid Ghostty syntax but requires per-cell rendering that Ghosttea does not apply yet",
                    setting.value
                ),
                setting,
            ));
            continue;
        }
        match parse_color(&setting.value) {
            Some(value) => {
                *output = value;
                dynamic = false;
            }
            None => diagnostics.push(diagnostic_at(
                DiagnosticSeverity::Error,
                "invalid-color",
                format!("`{key}` must be a valid Ghostty color or cell color reference"),
                setting,
            )),
        }
    }
    dynamic
}

fn apply_padding(
    scalars: &[Setting],
    key: &str,
    output: &mut [f32; 2],
    reset: [f32; 2],
    diagnostics: &mut Vec<ConfigDiagnostic>,
) {
    for setting in scalars.iter().filter(|setting| setting.key == key) {
        if setting.value.is_empty() {
            *output = reset;
            continue;
        }
        let values = setting
            .value
            .split(',')
            .map(str::trim)
            .map(str::parse::<f32>)
            .collect::<Result<Vec<_>, _>>();
        match values {
            Ok(values)
                if (values.len() == 1 || values.len() == 2)
                    && values
                        .iter()
                        .all(|value| value.is_finite() && *value >= 0.0) =>
            {
                output[0] = values[0];
                output[1] = *values.get(1).unwrap_or(&values[0]);
            }
            _ => diagnostics.push(diagnostic_at(
                DiagnosticSeverity::Error,
                "invalid-padding",
                format!("`{key}` must contain one or two non-negative numbers"),
                setting,
            )),
        }
    }
}

pub fn parse_color(value: &str) -> Option<[u8; 3]> {
    let value = value.trim_matches([' ', '\t']);
    if let Some(hex) = value.strip_prefix('#') {
        return parse_hash_hex_color(hex);
    }
    if let Some(named) = parse_x11_color(value) {
        return Some(named);
    }
    if matches!(value.len(), 3 | 6) {
        return parse_equal_width_hex_color(value);
    }
    if let Some(components) = value.strip_prefix("rgb:") {
        return parse_function_color(components, parse_scaled_hex_component);
    }
    if let Some(components) = value.strip_prefix("rgbi:") {
        return parse_function_color(components, parse_intensity_component);
    }
    None
}

fn parse_hash_hex_color(value: &str) -> Option<[u8; 3]> {
    if !matches!(value.len(), 3 | 6 | 9 | 12) {
        return None;
    }
    parse_equal_width_hex_color(value)
}

fn parse_equal_width_hex_color(value: &str) -> Option<[u8; 3]> {
    let width = value.len().checked_div(3)?;
    if !(1..=4).contains(&width)
        || width * 3 != value.len()
        || !value.bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return None;
    }
    Some([
        parse_scaled_hex_component(&value[0..width])?,
        parse_scaled_hex_component(&value[width..width * 2])?,
        parse_scaled_hex_component(&value[width * 2..])?,
    ])
}

fn parse_function_color(value: &str, parse_component: fn(&str) -> Option<u8>) -> Option<[u8; 3]> {
    let mut components = value.split('/');
    let result = [
        parse_component(components.next()?)?,
        parse_component(components.next()?)?,
        parse_component(components.next()?)?,
    ];
    components.next().is_none().then_some(result)
}

fn parse_scaled_hex_component(value: &str) -> Option<u8> {
    if value.is_empty() || value.len() > 4 || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return None;
    }
    let component = u32::from_str_radix(value, 16).ok()?;
    let divisor = (1_u32 << (value.len() * 4)) - 1;
    Some((component * u32::from(u8::MAX) / divisor) as u8)
}

fn parse_intensity_component(value: &str) -> Option<u8> {
    let component = value.parse::<f64>().ok()?;
    if !component.is_finite() || !(0.0..=1.0).contains(&component) {
        return None;
    }
    Some((component * f64::from(u8::MAX)) as u8)
}

fn parse_x11_color(value: &str) -> Option<[u8; 3]> {
    for line in X11_COLORS_TEXT.lines() {
        let name = line.get(12..)?.trim_matches([' ', '\t']);
        if !name.eq_ignore_ascii_case(value) {
            continue;
        }
        return Some([
            line.get(0..3)?.trim().parse().ok()?,
            line.get(4..7)?.trim().parse().ok()?,
            line.get(8..11)?.trim().parse().ok()?,
        ]);
    }
    None
}

const fn platform_default_font_size() -> f32 {
    if cfg!(target_os = "macos") {
        DEFAULT_FONT_SIZE_MACOS
    } else {
        DEFAULT_FONT_SIZE_OTHER
    }
}

fn known_keys() -> BTreeSet<&'static str> {
    KNOWN_KEYS_TEXT
        .lines()
        .filter(|line| !line.is_empty())
        .collect()
}

fn support_for_key(key: &str) -> ConfigSupport {
    match key {
        "background"
        | "foreground"
        | "cursor-color"
        | "selection-background"
        | "selection-foreground"
        | "scrollback-limit" => ConfigSupport::Applied,
        "config-file" | "custom-shader" | "font-family" | "font-size" | "window-padding-x"
        | "window-padding-y" | "keybind" => ConfigSupport::Parsed,
        _ => ConfigSupport::Unsupported,
    }
}

fn diagnostic_at(
    severity: DiagnosticSeverity,
    code: &str,
    message: String,
    setting: &Setting,
) -> ConfigDiagnostic {
    ConfigDiagnostic {
        severity,
        code: code.to_owned(),
        message,
        source: Some(setting.source.clone()),
        line: Some(setting.line),
        key: Some(setting.key.clone()),
    }
}

fn diagnostic(
    severity: DiagnosticSeverity,
    code: &str,
    message: String,
    source: Option<&Path>,
    line: Option<usize>,
    key: Option<&str>,
) -> ConfigDiagnostic {
    ConfigDiagnostic {
        severity,
        code: code.to_owned(),
        message,
        source: source.map(|path| path.to_string_lossy().into_owned()),
        line,
        key: key.map(str::to_owned),
    }
}

fn snapshot_revision(snapshot: &ConfigSnapshot) -> String {
    // FNV-1a is deliberately simple and stable across Rust releases. Omit the
    // revision field itself while hashing.
    let mut clone = snapshot.clone();
    clone.revision.clear();
    let bytes = serde_json::to_vec(&clone).unwrap_or_default();
    let hash = bytes.iter().fold(0xcbf2_9ce4_8422_2325_u64, |hash, byte| {
        (hash ^ u64::from(*byte)).wrapping_mul(0x0000_0100_0000_01b3)
    });
    format!("{hash:016x}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    fn write(path: &Path, text: &str) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, text).unwrap();
    }

    #[test]
    fn defaults_match_pinned_ghostty_and_disable_crt() {
        let snapshot = load_config(&ConfigLoadOptions {
            load_default_files: false,
            ..ConfigLoadOptions::default()
        });
        assert_eq!(snapshot.terminal.scrollback_bytes, 10_000_000);
        assert_eq!(snapshot.renderer.font_size, platform_default_font_size());
        assert_eq!(snapshot.renderer.padding_x, [2.0, 2.0]);
        assert_eq!(snapshot.renderer.post_process, RendererPostProcess::None);
        assert_eq!(snapshot.compatibility.known_key_count, 202);
        assert!(!snapshot.has_errors());
    }

    #[test]
    fn defaults_follow_the_selected_ghostty_platform() {
        let mut options = ConfigLoadOptions {
            load_default_files: false,
            macos: true,
            windows: false,
            ..ConfigLoadOptions::default()
        };
        assert_eq!(load_config(&options).renderer.font_size, 13.0);

        options.macos = false;
        assert_eq!(load_config(&options).renderer.font_size, 12.0);
    }

    #[test]
    fn parses_ghostty_syntax_and_projects_supported_values() {
        let temporary = TempDir::new().unwrap();
        let config = temporary.path().join("config.ghostty");
        write(
            &config,
            r#"
                # full-line comments only
                background = "102030"
                foreground = #abcdef
                cursor-color = orange
                selection-background = 135
                scrollback-limit = 123456
                font-family = "JetBrains Mono"
                font-family = Symbols Nerd Font
                font-size = 15.5
                window-padding-x = 3, 7
                window-padding-y = 4
                keybind = super+==increase_font_size:1
                keybind = super+shift+e=text:=
                custom-shader = ghosttea:better-crt
            "#,
        );
        let snapshot = load_config(&ConfigLoadOptions::explicit(&config));
        assert_eq!(snapshot.renderer.background, [0x10, 0x20, 0x30]);
        assert_eq!(snapshot.renderer.foreground, [0xab, 0xcd, 0xef]);
        assert_eq!(snapshot.renderer.cursor, [0xff, 0xa5, 0x00]);
        assert_eq!(snapshot.renderer.selection_background, [0x11, 0x33, 0x55]);
        assert_eq!(snapshot.terminal.scrollback_bytes, 123_456);
        assert_eq!(
            snapshot.renderer.font_families,
            ["JetBrains Mono", "Symbols Nerd Font"]
        );
        assert_eq!(snapshot.renderer.font_size, 15.5);
        assert_eq!(snapshot.renderer.padding_x, [3.0, 7.0]);
        assert_eq!(snapshot.renderer.padding_y, [4.0, 4.0]);
        assert_eq!(
            snapshot.renderer.post_process,
            RendererPostProcess::BetterCrt
        );
        assert_eq!(
            snapshot.workspace.keybindings,
            [
                KeybindingConfig {
                    trigger: "super+=".to_owned(),
                    action: "increase_font_size:1".to_owned()
                },
                KeybindingConfig {
                    trigger: "super+shift+e".to_owned(),
                    action: "text:=".to_owned()
                }
            ]
        );
        assert!(!snapshot.workspace.clear_keybindings);
        assert!(!snapshot.has_errors(), "{:?}", snapshot.diagnostics);
    }

    #[test]
    fn keybind_clear_and_blank_follow_ghostty_semantics() {
        let temporary = TempDir::new().unwrap();
        let config = temporary.path().join("config.ghostty");
        write(&config, "keybind = clear\nkeybind = super+t=previous_tab\n");
        let cleared = load_config(&ConfigLoadOptions::explicit(&config));
        assert!(cleared.workspace.clear_keybindings);
        assert_eq!(
            cleared.workspace.keybindings,
            [KeybindingConfig {
                trigger: "super+t".to_owned(),
                action: "previous_tab".to_owned(),
            }]
        );

        write(
            &config,
            "keybind = clear\nkeybind = super+t=previous_tab\nkeybind =\nkeybind = super+w=unbind\n",
        );
        let restored = load_config(&ConfigLoadOptions::explicit(&config));
        assert!(!restored.workspace.clear_keybindings);
        assert_eq!(
            restored.workspace.keybindings,
            [KeybindingConfig {
                trigger: "super+w".to_owned(),
                action: "unbind".to_owned(),
            }]
        );
    }

    #[test]
    fn includes_are_relative_deferred_optional_and_cycle_safe() {
        let temporary = TempDir::new().unwrap();
        let root = temporary.path().join("config.ghostty");
        let included = temporary.path().join("nested/theme");
        write(
            &root,
            "background = 111111\nconfig-file = nested/theme\nbackground = 222222\nconfig-file = ?missing\n",
        );
        write(
            &included,
            "background = 333333\nconfig-file = ../config.ghostty\n",
        );
        let snapshot = load_config(&ConfigLoadOptions::explicit(&root));
        // Ghostty's recursive de-duplication set does not pre-seed root files,
        // so the back-reference replays the root once before it is rejected.
        assert_eq!(snapshot.renderer.background, [0x22, 0x22, 0x22]);
        assert_eq!(snapshot.sources.len(), 3);
        assert_eq!(
            snapshot
                .configured_keys
                .iter()
                .find(|configured| configured.key == "config-file")
                .map(|configured| configured.occurrences),
            Some(5)
        );
        assert!(
            snapshot
                .diagnostics
                .iter()
                .any(|diagnostic| diagnostic.code == "include-cycle")
        );
    }

    #[test]
    fn include_paths_expand_and_blank_values_reset_the_queue() {
        let temporary = TempDir::new().unwrap();
        let root = temporary.path().join("root/config.ghostty");
        let cleared = temporary.path().join("root/cleared");
        let quoted = temporary.path().join("root/optional theme");
        let home = temporary.path().join("home");
        let home_theme = home.join("theme");
        write(&cleared, "background = 111111\n");
        write(&quoted, "background = 333333\n");
        write(&home_theme, "background = 444444\n");
        write(
            &root,
            "config-file = cleared\nconfig-file =\nconfig-file = ?\"optional theme\"\nconfig-file = ?\nconfig-file = ~/theme\n",
        );

        let snapshot = load_config(&ConfigLoadOptions {
            load_default_files: false,
            explicit_path: Some(root),
            home_dir: Some(home),
            xdg_config_home: None,
            local_app_data: None,
            macos: false,
            windows: false,
        });
        assert_eq!(snapshot.renderer.background, [0x44, 0x44, 0x44]);
        assert_eq!(
            snapshot
                .sources
                .iter()
                .map(|source| Path::new(&source.path).file_name().unwrap())
                .collect::<Vec<_>>(),
            ["config.ghostty", "optional theme", "theme"]
        );
    }

    #[test]
    fn includes_follow_ghostty_breadth_first_order() {
        let temporary = TempDir::new().unwrap();
        let root = temporary.path().join("config.ghostty");
        let first = temporary.path().join("first");
        let second = temporary.path().join("second");
        let nested = temporary.path().join("nested");
        write(&root, "config-file = first\nconfig-file = second\n");
        write(&first, "background = 111111\nconfig-file = nested\n");
        write(&second, "background = 222222\n");
        write(&nested, "background = 333333\n");

        let snapshot = load_config(&ConfigLoadOptions::explicit(&root));
        assert_eq!(snapshot.renderer.background, [0x33, 0x33, 0x33]);
        assert_eq!(
            snapshot
                .sources
                .iter()
                .map(|source| Path::new(&source.path).file_name().unwrap())
                .collect::<Vec<_>>(),
            ["config.ghostty", "first", "second", "nested"]
        );
    }

    #[test]
    fn standard_sources_follow_ghostty_precedence_then_overlay() {
        let temporary = TempDir::new().unwrap();
        let xdg = temporary.path().join("xdg");
        let home = temporary.path().join("home");
        let xdg_legacy = xdg.join("ghostty/config");
        let xdg_current = xdg.join("ghostty/config.ghostty");
        let mac_directory = home.join("Library/Application Support/com.mitchellh.ghostty");
        let mac_legacy = mac_directory.join("config");
        let mac_current = mac_directory.join("config.ghostty");
        write(&xdg_legacy, "background = 111111\n");
        write(&xdg_current, "background = 222222\n");
        write(&mac_legacy, "background = 333333\n");
        write(&mac_current, "background = 444444\n");

        let defaults = ConfigLoadOptions {
            load_default_files: true,
            explicit_path: None,
            home_dir: Some(home.clone()),
            xdg_config_home: Some(xdg.clone()),
            local_app_data: None,
            macos: true,
            windows: false,
        };
        let snapshot = load_config(&defaults);
        assert_eq!(snapshot.renderer.background, [0x44, 0x44, 0x44]);
        assert_eq!(
            snapshot
                .sources
                .iter()
                .map(|source| PathBuf::from(&source.path))
                .collect::<Vec<_>>(),
            [xdg_legacy, xdg_current, mac_legacy, mac_current]
        );

        let overlay = temporary.path().join("ghosttea/config.ghostty");
        write(&overlay, "background = 555555\n");
        let snapshot = load_config(&ConfigLoadOptions {
            explicit_path: Some(overlay.clone()),
            ..defaults
        });
        assert_eq!(snapshot.renderer.background, [0x55, 0x55, 0x55]);
        assert_eq!(snapshot.sources.len(), 5);
        assert_eq!(
            snapshot.sources.last(),
            Some(&ConfigSource {
                path: overlay.to_string_lossy().into_owned(),
                kind: ConfigSourceKind::GhostteaOverlay,
            })
        );
    }

    #[test]
    fn overlay_is_applied_after_standard_file_includes() {
        let temporary = TempDir::new().unwrap();
        let xdg = temporary.path().join("xdg");
        let standard = xdg.join("ghostty/config.ghostty");
        let included = xdg.join("ghostty/theme");
        let overlay = temporary.path().join("ghosttea/config.ghostty");
        write(&standard, "background = 111111\nconfig-file = theme\n");
        write(&included, "background = 222222\n");
        write(&overlay, "background = 333333\n");

        let snapshot = load_config(&ConfigLoadOptions {
            load_default_files: true,
            explicit_path: Some(overlay),
            home_dir: None,
            xdg_config_home: Some(xdg),
            local_app_data: None,
            macos: false,
            windows: false,
        });
        assert_eq!(snapshot.renderer.background, [0x33, 0x33, 0x33]);
        assert_eq!(
            snapshot
                .sources
                .iter()
                .map(|source| source.kind)
                .collect::<Vec<_>>(),
            [
                ConfigSourceKind::GhosttyDefault,
                ConfigSourceKind::Included,
                ConfigSourceKind::GhostteaOverlay,
            ]
        );
    }

    #[test]
    fn reset_unknown_unsupported_and_invalid_values_are_explicit() {
        let temporary = TempDir::new().unwrap();
        let config = temporary.path().join("config");
        write(
            &config,
            "background = ff0000\nbackground =\nfont-size = nope\ncustom-shader = ~/crt.glsl\ncustom-shader-animation = always\ntheme = catppuccin\nmade-up = true\n",
        );
        let snapshot = load_config(&ConfigLoadOptions::explicit(&config));
        assert_eq!(snapshot.renderer.background, DEFAULT_BACKGROUND);
        assert_eq!(snapshot.renderer.post_process, RendererPostProcess::None);
        assert_eq!(snapshot.renderer.custom_shader_paths, ["~/crt.glsl"]);
        assert!(snapshot.has_errors());
        for code in [
            "invalid-value",
            "unsupported-custom-shader",
            "recognized-not-applied",
            "unknown-key",
        ] {
            assert!(
                snapshot
                    .diagnostics
                    .iter()
                    .any(|diagnostic| diagnostic.code == code),
                "missing {code}: {:?}",
                snapshot.diagnostics
            );
        }
        assert!(
            snapshot
                .diagnostics
                .iter()
                .filter(|diagnostic| diagnostic.code == "recognized-not-applied")
                .all(|diagnostic| matches!(
                    diagnostic.key.as_deref(),
                    Some("custom-shader-animation" | "theme")
                ))
        );
        assert_eq!(
            snapshot
                .configured_keys
                .iter()
                .find(|configured| configured.key == "custom-shader-animation")
                .map(|configured| configured.support),
            Some(ConfigSupport::Unsupported)
        );
    }

    #[test]
    fn rejects_values_that_cannot_round_trip_through_the_shared_schema() {
        let temporary = TempDir::new().unwrap();
        let config = temporary.path().join("config");
        write(
            &config,
            "scrollback-limit = 9007199254740992\nkeybind = super+t=\n",
        );

        let snapshot = load_config(&ConfigLoadOptions::explicit(&config));
        assert_eq!(snapshot.terminal.scrollback_bytes, DEFAULT_SCROLLBACK_BYTES);
        assert!(snapshot.workspace.keybindings.is_empty());
        assert_eq!(
            snapshot
                .diagnostics
                .iter()
                .filter(|diagnostic| {
                    diagnostic.code == "invalid-value" || diagnostic.code == "invalid-keybind"
                })
                .count(),
            2
        );
    }

    #[test]
    fn invalid_scalar_updates_preserve_the_last_valid_value() {
        let temporary = TempDir::new().unwrap();
        let config = temporary.path().join("config");
        write(
            &config,
            "background = 112233\nbackground = not-a-color\nscrollback-limit = 123456\nscrollback-limit = too-large\nfont-size = 15\nfont-size = nope\nwindow-padding-x = 7\nwindow-padding-x = -1\n",
        );

        let snapshot = load_config(&ConfigLoadOptions::explicit(&config));
        assert_eq!(snapshot.renderer.background, [0x11, 0x22, 0x33]);
        assert_eq!(snapshot.terminal.scrollback_bytes, 123_456);
        assert_eq!(snapshot.renderer.font_size, 15.0);
        assert_eq!(snapshot.renderer.padding_x, [7.0, 7.0]);
        assert_eq!(
            snapshot
                .diagnostics
                .iter()
                .filter(|diagnostic| diagnostic.severity == DiagnosticSeverity::Error)
                .count(),
            4
        );
    }

    #[test]
    fn cursor_and_selection_cell_references_are_reported_as_parsed_only() {
        let temporary = TempDir::new().unwrap();
        let config = temporary.path().join("config");
        write(
            &config,
            "foreground = 112233\nbackground = 445566\ncursor-color = cell-background\nselection-background = cell-foreground\nselection-foreground = cell-background\n",
        );

        let snapshot = load_config(&ConfigLoadOptions::explicit(&config));
        assert_eq!(snapshot.renderer.cursor, [0x11, 0x22, 0x33]);
        assert_eq!(snapshot.renderer.selection_background, [0x11, 0x22, 0x33]);
        assert_eq!(snapshot.renderer.selection_foreground, [0x44, 0x55, 0x66]);
        assert_eq!(
            snapshot
                .diagnostics
                .iter()
                .filter(|diagnostic| diagnostic.code == "dynamic-color-not-applied")
                .count(),
            3
        );
        for key in [
            "cursor-color",
            "selection-background",
            "selection-foreground",
        ] {
            assert_eq!(
                snapshot
                    .configured_keys
                    .iter()
                    .find(|configured| configured.key == key)
                    .map(|configured| configured.support),
                Some(ConfigSupport::Parsed)
            );
        }
        assert!(!snapshot.has_errors(), "{:?}", snapshot.diagnostics);
    }

    #[test]
    fn parses_ghostty_color_grammar_and_full_x11_catalog() {
        for (input, expected) in [
            ("#345", [0x33, 0x44, 0x55]),
            ("345", [0x33, 0x44, 0x55]),
            ("#123456789", [0x12, 0x45, 0x78]),
            ("#123456789abc", [0x12, 0x56, 0x9a]),
            ("rgb:7f/a0a0/0", [127, 160, 0]),
            ("rgbi:1.0/0.5/0", [255, 127, 0]),
            ("LawnGreen", [124, 252, 0]),
            ("medium spring green", [0, 250, 154]),
            (" Forest Green ", [34, 139, 34]),
            ("green", [0, 255, 0]),
        ] {
            assert_eq!(parse_color(input), Some(expected), "{input}");
        }
        for input in [
            "transparent",
            "forest_green",
            "rgb:0.5/0/1",
            "rgbi:NaN/0/1",
            "rgbi:1.1/0/1",
            "rgb:f/f/f/0",
            "#ffff",
            "#€",
            "123456789",
        ] {
            assert_eq!(parse_color(input), None, "{input}");
        }
    }

    #[test]
    fn strips_utf8_bom_and_accepts_bare_cli_style_options() {
        let temporary = TempDir::new().unwrap();
        let config = temporary.path().join("config");
        write(
            &config,
            "\u{feff}background = 112233\nwindow-save-state\nfont-size\n",
        );

        let snapshot = load_config(&ConfigLoadOptions::explicit(&config));
        assert_eq!(snapshot.renderer.background, [0x11, 0x22, 0x33]);
        assert!(
            snapshot
                .configured_keys
                .iter()
                .any(|configured| configured.key == "window-save-state")
        );
        assert!(
            snapshot
                .diagnostics
                .iter()
                .any(|diagnostic| diagnostic.code == "recognized-not-applied"
                    && diagnostic.key.as_deref() == Some("window-save-state"))
        );
        assert!(
            snapshot
                .diagnostics
                .iter()
                .any(|diagnostic| diagnostic.code == "invalid-value"
                    && diagnostic.key.as_deref() == Some("font-size"))
        );
        assert!(snapshot.diagnostics.iter().all(
            |diagnostic| diagnostic.code != "unknown-key" && diagnostic.code != "invalid-line"
        ));
    }

    #[test]
    fn windows_discovery_uses_local_app_data_before_home() {
        let temporary = TempDir::new().unwrap();
        let local_app_data = temporary.path().join("local");
        let home = temporary.path().join("home");
        let options = ConfigLoadOptions {
            load_default_files: true,
            explicit_path: None,
            home_dir: Some(home),
            xdg_config_home: None,
            local_app_data: Some(local_app_data.clone()),
            macos: false,
            windows: true,
        };

        assert_eq!(
            standard_config_paths(&options),
            [
                local_app_data.join("ghostty/config"),
                local_app_data.join("ghostty/config.ghostty"),
            ]
        );
    }

    #[test]
    fn reload_revision_changes_only_when_snapshot_changes() {
        let temporary = TempDir::new().unwrap();
        let config = temporary.path().join("config");
        write(&config, "background = 111111\n");
        let manager = ConfigManager::load(ConfigLoadOptions::explicit(&config));
        let first = manager.snapshot();
        let (same, changed) = manager.reload();
        assert!(!changed);
        assert_eq!(first.revision, same.revision);
        write(&config, "background = 222222\n");
        let (next, changed) = manager.reload();
        assert!(changed);
        assert_ne!(first.revision, next.revision);
    }
}
