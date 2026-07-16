use std::{
    collections::{BTreeMap, BTreeSet, HashMap, HashSet},
    io::{Read, Write},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc,
    },
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use anyhow::{Context, Result};
use ghosttea_text::{FontStyle, GlyphDefinition, ShapedRow, StyleSpan, TextEngine};
use ghosttea_vt::{GhosttyTerminalCore, TerminalSnapshot};
use portable_pty::{Child, CommandBuilder, MasterPty, PtySize, native_pty_system};
use serde::{Deserialize, Serialize};
use tokio::sync::broadcast;
use uuid::Uuid;

use crate::{
    authority::{ControlChanged, ControllerState, ViewAccess, ViewAuthority},
    frame::{FrameCursor, TextSnapshot, encode_text_snapshot},
    tunnel_protocol::{
        LogicalCell, LogicalCellStyle, LogicalCursor, LogicalRow, LogicalTerminalSnapshot,
    },
};

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum Persistence {
    TerminateWithApp,
    KeepUntilExit,
    KeepUntilExplicitClose,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum TerminationSource {
    #[default]
    User,
    Application,
    ServiceShutdown,
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum ExitOutcome {
    Completed,
    Crashed,
    Signaled,
    UserTerminated,
    ApplicationTerminated,
    ServiceTerminated,
    Unknown,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionExit {
    pub exit_code: Option<i32>,
    pub exit_signal: Option<String>,
    pub requested_termination: Option<TerminationSource>,
    pub exit_outcome: ExitOutcome,
}

fn classify_exit(
    exit_code: Option<i32>,
    exit_signal: Option<&str>,
    source: Option<TerminationSource>,
) -> ExitOutcome {
    match source {
        Some(TerminationSource::User) => ExitOutcome::UserTerminated,
        Some(TerminationSource::Application) => ExitOutcome::ApplicationTerminated,
        Some(TerminationSource::ServiceShutdown) => ExitOutcome::ServiceTerminated,
        None if exit_signal.is_some() => ExitOutcome::Signaled,
        None if exit_code == Some(0) => ExitOutcome::Completed,
        None if exit_code.is_some() => ExitOutcome::Crashed,
        None => ExitOutcome::Unknown,
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "mode", rename_all = "kebab-case")]
pub enum SessionEnvironment {
    Inherit {
        #[serde(default)]
        overrides: HashMap<String, String>,
    },
    Clean {
        #[serde(default)]
        variables: HashMap<String, String>,
    },
}

#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum AutomationInputOperation {
    Text { text: String },
    Paste { text: String, submit: bool },
    Interrupt,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AutomationInputResult {
    pub accepted: bool,
    pub human_input_epoch: u64,
    pub input_sequence: Option<u64>,
}

pub type ExitCallback = Arc<dyn Fn(String, SessionExit, Persistence) + Send + Sync>;

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpawnOptions {
    pub executable: String,
    #[serde(default)]
    pub args: Vec<String>,
    pub cwd: Option<String>,
    /// Legacy additive environment overlay. New callers should use `environment`.
    #[serde(default)]
    pub env: HashMap<String, String>,
    pub environment: Option<SessionEnvironment>,
    pub cols: u16,
    pub rows: u16,
    pub persistence: Persistence,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum KeyAction {
    Down,
    Up,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyInput {
    #[serde(rename = "type")]
    pub action: KeyAction,
    pub key: String,
    pub code: String,
    pub repeat: bool,
    pub shift: bool,
    pub control: bool,
    pub alt: bool,
    pub meta: bool,
    #[serde(default)]
    pub unshifted_codepoint: u32,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum MouseAction {
    Press,
    Release,
    Motion,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MouseInput {
    pub action: MouseAction,
    pub button: u8,
    pub x: f32,
    pub y: f32,
    pub screen_width: u32,
    pub screen_height: u32,
    pub cell_width: u32,
    pub cell_height: u32,
    pub padding_left: u32,
    pub padding_top: u32,
    pub shift: bool,
    pub control: bool,
    pub alt: bool,
    pub meta: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSummary {
    pub id: String,
    pub handle: String,
    pub executable: String,
    pub cols: u16,
    pub rows: u16,
    pub exited: bool,
    pub title: Option<String>,
    pub cwd: Option<String>,
    pub bell_count: u64,
    pub pid: Option<u32>,
    pub created_at_ms: u64,
    pub exit_code: Option<i32>,
    pub exit_signal: Option<String>,
    pub requested_termination: Option<TerminationSource>,
    pub exit_outcome: Option<ExitOutcome>,
}

pub struct Session {
    summary: Mutex<SessionSummary>,
    handle: u64,
    session_epoch: u64,
    created_at_ms: u64,
    process: PtyProcess,
    terminal: Mutex<GhosttyTerminalCore>,
    sequence: AtomicU64,
    revision: AtomicU64,
    layout_epoch: AtomicU64,
    exited: AtomicBool,
    frames: broadcast::Sender<Vec<u8>>,
    text_engine: Arc<Mutex<TextEngine>>,
    render_cache: Mutex<RenderCache>,
    persistence: Persistence,
    on_exit: ExitCallback,
    authority: Mutex<ViewAuthority>,
    input_tx: mpsc::SyncSender<InputOperation>,
    input_order: Mutex<InputOrderState>,
    termination_started: AtomicBool,
    requested_termination: Mutex<Option<TerminationSource>>,
    latest_logical: Mutex<Option<LogicalTerminalSnapshot>>,
    logical_tx: broadcast::Sender<LogicalTerminalSnapshot>,
    control_tx: broadcast::Sender<ControlChanged>,
}

enum InputOperation {
    Text(String),
    Paste(String),
    Key(KeyInput),
    Mouse(MouseInput),
    Scroll(isize),
    Focus(bool),
    Interrupt,
    Automation(AutomationInputOperation),
}

#[derive(Default)]
struct InputOrderState {
    human_input_epoch: u64,
    input_sequence: u64,
}

struct PtyProcess {
    master: Mutex<Box<dyn MasterPty + Send>>,
    writer: Mutex<Box<dyn Write + Send>>,
    child: Mutex<Box<dyn Child + Send + Sync>>,
    pid: Option<u32>,
}

struct ObservedProcessExit {
    exit_code: Option<i32>,
    exit_signal: Option<String>,
}

const INTERRUPT_GRACE: Duration = Duration::from_secs(2);
const TERMINATE_GRACE: Duration = Duration::from_secs(2);

impl PtyProcess {
    fn write(&self, bytes: &[u8]) -> Result<()> {
        if bytes.is_empty() {
            return Ok(());
        }
        let mut writer = self.writer.lock().unwrap();
        writer.write_all(bytes)?;
        writer.flush()?;
        Ok(())
    }

    fn resize(&self, cols: u16, rows: u16) -> Result<()> {
        self.master.lock().unwrap().resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })?;
        Ok(())
    }

    fn wait(&self) -> ObservedProcessExit {
        match self.child.lock().unwrap().wait() {
            Ok(status) => ObservedProcessExit {
                exit_code: status
                    .signal()
                    .is_none()
                    .then(|| i32::try_from(status.exit_code()).ok())
                    .flatten(),
                exit_signal: status.signal().map(str::to_owned),
            },
            Err(_) => ObservedProcessExit {
                exit_code: None,
                exit_signal: None,
            },
        }
    }
}

#[cfg(unix)]
fn signal_process_group(pid: Option<u32>, signal: libc::c_int) -> Result<()> {
    let Some(pid) = pid.and_then(|pid| i32::try_from(pid).ok()) else {
        return Ok(());
    };
    let result = unsafe { libc::kill(-pid, signal) };
    if result == 0 {
        return Ok(());
    }
    let error = std::io::Error::last_os_error();
    if error.raw_os_error() == Some(libc::ESRCH) {
        Ok(())
    } else {
        Err(error.into())
    }
}

fn is_private_service_environment(key: &str) -> bool {
    matches!(
        key,
        "GHOSTTEA_AUTH_TOKEN"
            | "TERMINALD_AUTH_TOKEN"
            | "GHOSTTEA_CONTROL_SOCKET"
            | "TERMINALD_CONTROL_SOCKET"
            | "GHOSTTEA_FRAME_SOCKET"
            | "TERMINALD_FRAME_SOCKET"
            | "TRUFFLE_TEST_AUTHKEY"
            | "TRUFFLE_SIDECAR_PATH"
    ) || key.starts_with("GHOSTTEA_TRUFFLE_")
        || key.starts_with("TERMINALD_TRUFFLE_")
        || key.starts_with("GHOSTTEA_EXTERNAL_")
}

fn configure_environment(
    command: &mut CommandBuilder,
    legacy: HashMap<String, String>,
    environment: Option<SessionEnvironment>,
) {
    let environment = environment.unwrap_or(SessionEnvironment::Inherit { overrides: legacy });
    match environment {
        SessionEnvironment::Inherit { overrides } => {
            for (key, _) in std::env::vars().filter(|(key, _)| is_private_service_environment(key))
            {
                command.env_remove(key);
            }
            for (key, value) in overrides {
                command.env(key, value);
            }
        }
        SessionEnvironment::Clean { variables } => {
            command.env_clear();
            for (key, value) in variables {
                command.env(key, value);
            }
        }
    }
    command.env("TERM", "xterm-256color");
}

#[derive(Clone, PartialEq, Eq)]
struct RowShapeKey {
    text: String,
    spans: Vec<(usize, usize, FontStyle)>,
}

#[derive(Clone)]
struct CachedRow {
    key: RowShapeKey,
    shaped: ShapedRow,
}

struct RenderCache {
    rows: Vec<Option<CachedRow>>,
    sent_glyphs: HashSet<u32>,
    force_full: bool,
    reset_catalog: bool,
}

impl RenderCache {
    fn new() -> Self {
        Self {
            rows: Vec::new(),
            sent_glyphs: HashSet::new(),
            force_full: true,
            reset_catalog: true,
        }
    }
}

impl Session {
    pub fn spawn(
        options: SpawnOptions,
        frames: broadcast::Sender<Vec<u8>>,
        text_engine: Arc<Mutex<TextEngine>>,
        on_exit: ExitCallback,
    ) -> Result<Arc<Self>> {
        let SpawnOptions {
            executable,
            args,
            cwd,
            env,
            environment,
            cols,
            rows,
            persistence,
        } = options;
        let pair = native_pty_system().openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })?;
        let mut command = CommandBuilder::new(&executable);
        command.args(args);
        if let Some(cwd) = cwd {
            command.cwd(cwd);
        }
        configure_environment(&mut command, env, environment);
        let child = pair
            .slave
            .spawn_command(command)
            .context("failed to spawn PTY command")?;
        let pid = child.process_id();
        drop(pair.slave);
        let reader = pair.master.try_clone_reader()?;
        let writer = pair.master.take_writer()?;
        let (input_tx, input_rx) = mpsc::sync_channel(1024);
        let id = Uuid::new_v4().to_string();
        let id_bytes = *Uuid::parse_str(&id)?.as_bytes();
        let handle = u64::from_le_bytes(id_bytes[..8].try_into().unwrap());
        let session_epoch = u64::from_le_bytes(id_bytes[8..].try_into().unwrap()).max(1);
        let created_at_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;
        let (logical_tx, _) = broadcast::channel(8);
        let (control_tx, _) = broadcast::channel(16);
        let session = Arc::new(Self {
            summary: Mutex::new(SessionSummary {
                id,
                handle: handle.to_string(),
                executable,
                cols,
                rows,
                exited: false,
                title: None,
                cwd: None,
                bell_count: 0,
                pid,
                created_at_ms,
                exit_code: None,
                exit_signal: None,
                requested_termination: None,
                exit_outcome: None,
            }),
            handle,
            session_epoch,
            created_at_ms,
            process: PtyProcess {
                master: Mutex::new(pair.master),
                writer: Mutex::new(writer),
                child: Mutex::new(child),
                pid,
            },
            terminal: Mutex::new(GhosttyTerminalCore::new(cols, rows, 10_000)?),
            sequence: AtomicU64::new(0),
            revision: AtomicU64::new(0),
            layout_epoch: AtomicU64::new(1),
            exited: AtomicBool::new(false),
            frames,
            text_engine,
            render_cache: Mutex::new(RenderCache::new()),
            persistence,
            on_exit,
            authority: Mutex::new(ViewAuthority::new(cols, rows)),
            input_tx,
            input_order: Mutex::new(InputOrderState::default()),
            termination_started: AtomicBool::new(false),
            requested_termination: Mutex::new(None),
            latest_logical: Mutex::new(None),
            logical_tx,
            control_tx,
        });
        Self::start_input_actor(&session, input_rx);
        Self::start_reader(&session, reader);
        Ok(session)
    }

    fn start_input_actor(session: &Arc<Self>, input_rx: mpsc::Receiver<InputOperation>) {
        let session = Arc::clone(session);
        std::thread::Builder::new()
            .name(format!("pty-input-{}", session.id()))
            .spawn(move || {
                while let Ok(operation) = input_rx.recv() {
                    if let Err(error) = session.execute_input(operation) {
                        eprintln!(
                            "[ghosttea] PTY input failed for {}: {error:#}",
                            session.id()
                        );
                    }
                    if session.has_exited() {
                        break;
                    }
                }
            })
            .expect("PTY input actor");
    }

    fn start_reader(session: &Arc<Self>, mut reader: Box<dyn Read + Send>) {
        const FRAME_INTERVAL: Duration = Duration::from_millis(8);
        const MAX_BATCH_BYTES: usize = 256 * 1024;
        let (output_tx, output_rx) = mpsc::sync_channel::<Vec<u8>>(32);
        let reader_id = session.id();
        std::thread::Builder::new()
            .name(format!("pty-read-{reader_id}"))
            .spawn(move || {
                let mut bytes = [0_u8; 16 * 1024];
                while let Ok(count) = reader.read(&mut bytes) {
                    if count == 0 {
                        break;
                    }
                    if output_tx.send(bytes[..count].to_vec()).is_err() {
                        break;
                    }
                }
            })
            .expect("PTY read thread");

        let session = Arc::clone(session);
        std::thread::Builder::new()
            .name(format!("pty-frame-{}", session.id()))
            .spawn(move || {
                while let Ok(first) = output_rx.recv() {
                    let deadline = Instant::now() + FRAME_INTERVAL;
                    let mut batch = first;
                    while batch.len() < MAX_BATCH_BYTES {
                        let now = Instant::now();
                        if now >= deadline {
                            break;
                        }
                        match output_rx.recv_timeout(deadline.saturating_duration_since(now)) {
                            Ok(bytes) => batch.extend_from_slice(&bytes),
                            Err(mpsc::RecvTimeoutError::Timeout) => break,
                            Err(mpsc::RecvTimeoutError::Disconnected) => break,
                        }
                    }
                    let (snapshot, response) = {
                        let mut terminal = session.terminal.lock().unwrap();
                        terminal.feed(&batch);
                        if session.has_active_views() {
                            (Some(terminal.snapshot()), Vec::new())
                        } else {
                            (None, terminal.take_pty_response())
                        }
                    };
                    if !response.is_empty() {
                        let _ = session.process.write(&response);
                    }
                    if let Some(snapshot) = snapshot {
                        match snapshot {
                            Ok(snapshot) => session.publish_snapshot(snapshot),
                            Err(error) => {
                                eprintln!("ghostty snapshot failed for {}: {error}", session.id())
                            }
                        }
                    }
                }
                session.exited.store(true, Ordering::Release);
                let observed = session.process.wait();
                let requested_termination = *session.requested_termination.lock().unwrap();
                let exit_outcome = classify_exit(
                    observed.exit_code,
                    observed.exit_signal.as_deref(),
                    requested_termination,
                );
                let exit = SessionExit {
                    exit_code: observed.exit_code,
                    exit_signal: observed.exit_signal,
                    requested_termination,
                    exit_outcome,
                };
                {
                    let mut summary = session.summary.lock().unwrap();
                    summary.exited = true;
                    summary.exit_code = exit.exit_code;
                    summary.exit_signal.clone_from(&exit.exit_signal);
                    summary.requested_termination = exit.requested_termination;
                    summary.exit_outcome = Some(exit.exit_outcome);
                }
                if session.has_active_views()
                    && let Ok(snapshot) = session.terminal.lock().unwrap().snapshot()
                {
                    session.publish_snapshot(snapshot);
                }
                (session.on_exit)(session.id(), exit, session.persistence);
            })
            .expect("PTY reader thread");
    }

    fn publish_snapshot(&self, snapshot: TerminalSnapshot) {
        if !snapshot.pty_response.is_empty() {
            let _ = self.process.write(&snapshot.pty_response);
        }
        let mut summary = self.summary.lock().unwrap();
        summary.cols = snapshot.cols;
        summary.rows = snapshot.rows.len() as u16;
        summary.title = snapshot.title.clone();
        summary.cwd = snapshot.cwd.clone();
        if snapshot.bell {
            summary.bell_count = summary.bell_count.saturating_add(1);
        }
        let cols = summary.cols;
        drop(summary);
        let sequence = self.sequence.fetch_add(1, Ordering::AcqRel) + 1;
        let revision = self.revision.fetch_add(1, Ordering::AcqRel) + 1;
        let logical = LogicalTerminalSnapshot {
            session_epoch: self.session_epoch,
            layout_epoch: self.layout_epoch.load(Ordering::Acquire),
            terminal_revision: revision,
            cols,
            rows: snapshot
                .rows
                .iter()
                .cloned()
                .zip(snapshot.cells.iter())
                .map(|(text, cells)| LogicalRow {
                    text,
                    cells: cells
                        .iter()
                        .map(|cell| LogicalCell {
                            column: cell.column,
                            span: cell.span,
                            text: cell.text.clone(),
                            style: LogicalCellStyle {
                                bold: cell.style.bold,
                                italic: cell.style.italic,
                                faint: cell.style.faint,
                                inverse: cell.style.inverse,
                                invisible: cell.style.invisible,
                                strikethrough: cell.style.strikethrough,
                                underline: cell.style.underline,
                                foreground: cell.style.foreground,
                                background: cell.style.background,
                            },
                        })
                        .collect(),
                })
                .collect(),
            cursor: LogicalCursor {
                x: snapshot.cursor.x,
                y: snapshot.cursor.y,
                visible: snapshot.cursor.visible,
                style: snapshot.cursor.style,
                blinking: snapshot.cursor.blinking,
            },
            mouse_tracking: snapshot.mouse_tracking,
            title: snapshot.title.clone(),
            cwd: snapshot.cwd.clone(),
        };
        *self.latest_logical.lock().unwrap() = Some(logical.clone());
        let _ = self.logical_tx.send(logical);
        let cursor = FrameCursor {
            x: snapshot.cursor.x,
            y: snapshot.cursor.y,
            visible: snapshot.cursor.visible,
            style: snapshot.cursor.style,
            blinking: snapshot.cursor.blinking,
        };
        let (shaped_rows, updated_rows, full_snapshot, new_definitions) = {
            let mut cache = self.render_cache.lock().unwrap();
            let row_count = snapshot.rows.len();
            let cache_resized = cache.rows.len() != row_count;
            if cache_resized {
                cache.rows.resize_with(row_count, || None);
            }
            let full_snapshot = snapshot.damage.full || cache.force_full || cache_resized;
            let mut updated: BTreeSet<u16> = if full_snapshot {
                (0..row_count.min(u16::MAX as usize))
                    .map(|row| row as u16)
                    .collect()
            } else {
                snapshot
                    .damage
                    .dirty_rows
                    .iter()
                    .copied()
                    .filter(|row| (*row as usize) < row_count)
                    .collect()
            };
            for (row, cached) in cache.rows.iter().enumerate() {
                if cached.is_none() {
                    updated.insert(row as u16);
                }
            }
            if cache.reset_catalog {
                cache.sent_glyphs.clear();
                cache.reset_catalog = false;
            }

            let mut engine = self.text_engine.lock().unwrap();
            for row_index in updated.iter().copied() {
                let row = &snapshot.rows[row_index as usize];
                let cells = &snapshot.cells[row_index as usize];
                let mut byte_offset = 0;
                let span_tuples: Vec<_> = cells
                    .iter()
                    .filter_map(|cell| {
                        if byte_offset >= row.len() {
                            return None;
                        }
                        let byte_start = byte_offset;
                        byte_offset = (byte_offset + cell.text.len()).min(row.len());
                        Some((
                            byte_start,
                            byte_offset,
                            FontStyle {
                                bold: cell.style.bold,
                                italic: cell.style.italic,
                            },
                        ))
                    })
                    .collect();
                let key = RowShapeKey {
                    text: row.clone(),
                    spans: span_tuples.clone(),
                };
                if cache.rows[row_index as usize]
                    .as_ref()
                    .is_some_and(|cached| cached.key == key)
                {
                    continue;
                }
                let spans: Vec<_> = span_tuples
                    .into_iter()
                    .map(|(byte_start, byte_end, style)| StyleSpan {
                        byte_start,
                        byte_end,
                        style,
                    })
                    .collect();
                match engine.shape_styled_row(row, &spans) {
                    Ok(shaped) => cache.rows[row_index as usize] = Some(CachedRow { key, shaped }),
                    Err(error) => {
                        eprintln!(
                            "native text shaping failed for {} row {row_index}: {error}",
                            self.id()
                        );
                        cache.force_full = true;
                        cache.reset_catalog = true;
                        return;
                    }
                }
            }
            cache.force_full = false;
            let shaped_rows: Vec<_> = cache
                .rows
                .iter()
                .map(|row| {
                    row.as_ref()
                        .map(|cached| cached.shaped.clone())
                        .unwrap_or_default()
                })
                .collect();
            let mut new_definitions = BTreeMap::<u32, GlyphDefinition>::new();
            for row_index in &updated {
                for definition in &shaped_rows[*row_index as usize].definitions {
                    if cache.sent_glyphs.insert(definition.id) {
                        new_definitions.insert(definition.id, definition.clone());
                    }
                }
            }
            (
                shaped_rows,
                updated.into_iter().collect::<Vec<_>>(),
                full_snapshot,
                new_definitions.into_values().collect::<Vec<_>>(),
            )
        };
        match encode_text_snapshot(TextSnapshot {
            session_handle: self.handle,
            session_epoch: self.session_epoch,
            layout_epoch: self.layout_epoch.load(Ordering::Acquire),
            sequence,
            revision,
            cols,
            rows: &snapshot.rows,
            shaped_rows: &shaped_rows,
            cells: &snapshot.cells,
            updated_rows: &updated_rows,
            full_snapshot,
            mouse_tracking: snapshot.mouse_tracking,
            new_glyph_definitions: &new_definitions,
            clipboard: snapshot.clipboard.as_deref(),
            cursor: &cursor,
        }) {
            Ok(frame) => {
                let _ = self.frames.send(frame);
            }
            Err(error) => {
                eprintln!("frame encoding failed for {}: {error}", self.id());
                let mut cache = self.render_cache.lock().unwrap();
                cache.force_full = true;
                cache.reset_catalog = true;
            }
        }
    }

    pub fn id(&self) -> String {
        self.summary.lock().unwrap().id.clone()
    }
    pub fn summary(&self) -> SessionSummary {
        self.summary.lock().unwrap().clone()
    }
    pub fn session_epoch(&self) -> u64 {
        self.session_epoch
    }
    pub fn created_at_ms(&self) -> u64 {
        self.created_at_ms
    }
    pub fn logical_snapshot(&self) -> Option<LogicalTerminalSnapshot> {
        self.latest_logical.lock().unwrap().clone()
    }
    pub fn subscribe_logical(&self) -> broadcast::Receiver<LogicalTerminalSnapshot> {
        self.logical_tx.subscribe()
    }
    pub fn has_exited(&self) -> bool {
        self.exited.load(Ordering::Acquire)
    }
    pub fn persistence(&self) -> Persistence {
        self.persistence
    }
    pub fn attach_view(&self, view_id: &str, client_id: &str) -> Result<u64> {
        self.attach_view_with_access(view_id, client_id, ViewAccess::ReadWrite)
    }

    pub fn attach_view_with_access(
        &self,
        view_id: &str,
        client_id: &str,
        access: ViewAccess,
    ) -> Result<u64> {
        self.authority
            .lock()
            .unwrap()
            .attach(view_id, client_id, access)
    }

    pub fn detach_view(&self, view_id: &str, client_id: &str) -> bool {
        self.authority.lock().unwrap().detach(view_id, client_id)
    }

    pub fn has_active_views(&self) -> bool {
        self.authority.lock().unwrap().has_views()
    }

    pub fn claim_control(
        &self,
        view_id: &str,
        client_id: &str,
        cols: u16,
        rows: u16,
    ) -> Result<ControlChanged> {
        let mut authority = self.authority.lock().unwrap();
        let previous_size = authority.size();
        let mut next = authority.clone();
        let changed = next.claim_control(view_id, client_id, cols, rows)?;
        if changed.size_changed {
            self.apply_resize(cols, rows, changed.layout_epoch, previous_size)?;
        }
        *authority = next;
        drop(authority);
        let _ = self.control_tx.send(changed.clone());
        Ok(changed)
    }

    #[allow(clippy::too_many_arguments)]
    pub fn resize_view(
        &self,
        view_id: &str,
        client_id: &str,
        control_epoch: u64,
        resize_sequence: u64,
        cols: u16,
        rows: u16,
    ) -> Result<bool> {
        let mut authority = self.authority.lock().unwrap();
        let previous_size = authority.size();
        let Some(prepared) = authority.prepare_resize(
            view_id,
            client_id,
            control_epoch,
            resize_sequence,
            cols,
            rows,
        )?
        else {
            return Ok(false);
        };
        if prepared.size_changed {
            self.apply_resize(cols, rows, prepared.layout_epoch, previous_size)?;
        }
        authority.commit_resize(view_id, prepared);
        Ok(prepared.size_changed)
    }

    pub fn control_state(&self) -> (Option<ControllerState>, u16, u16, u64) {
        let authority = self.authority.lock().unwrap();
        let (cols, rows) = authority.size();
        (
            authority.controller().cloned(),
            cols,
            rows,
            authority.layout_epoch(),
        )
    }

    pub fn subscribe_control(&self) -> broadcast::Receiver<ControlChanged> {
        self.control_tx.subscribe()
    }

    pub fn announce_control(&self) {
        let authority = self.authority.lock().unwrap();
        let Some(controller) = authority.controller().cloned() else {
            return;
        };
        let (cols, rows) = authority.size();
        let _ = self.control_tx.send(ControlChanged {
            controller,
            cols,
            rows,
            layout_epoch: authority.layout_epoch(),
            size_changed: false,
        });
    }

    pub fn refresh(&self) -> Result<()> {
        {
            let mut cache = self.render_cache.lock().unwrap();
            cache.force_full = true;
            cache.reset_catalog = true;
        }
        let snapshot = self.terminal.lock().unwrap().snapshot()?;
        self.publish_snapshot(snapshot);
        Ok(())
    }

    fn authorize_and_enqueue(
        &self,
        view_id: &str,
        client_id: &str,
        attachment_epoch: u64,
        input_sequence: u64,
        operation: InputOperation,
        counts_as_human_input: bool,
    ) -> Result<()> {
        if !self.authority.lock().unwrap().authorize_input(
            view_id,
            client_id,
            attachment_epoch,
            input_sequence,
        )? {
            return Ok(());
        }
        let mut order = self.input_order.lock().unwrap();
        self.input_tx
            .try_send(operation)
            .map_err(|error| anyhow::anyhow!("terminal input queue unavailable: {error}"))?;
        if counts_as_human_input {
            order.human_input_epoch = order.human_input_epoch.saturating_add(1);
        }
        order.input_sequence = order.input_sequence.saturating_add(1);
        Ok(())
    }

    pub fn automation_state(&self) -> u64 {
        self.input_order.lock().unwrap().human_input_epoch
    }

    pub fn automation_input(
        &self,
        expected_human_input_epoch: u64,
        operation: AutomationInputOperation,
    ) -> Result<AutomationInputResult> {
        let mut order = self.input_order.lock().unwrap();
        if order.human_input_epoch != expected_human_input_epoch {
            return Ok(AutomationInputResult {
                accepted: false,
                human_input_epoch: order.human_input_epoch,
                input_sequence: None,
            });
        }
        self.input_tx
            .try_send(InputOperation::Automation(operation))
            .map_err(|error| anyhow::anyhow!("terminal input queue unavailable: {error}"))?;
        order.input_sequence = order.input_sequence.saturating_add(1);
        Ok(AutomationInputResult {
            accepted: true,
            human_input_epoch: order.human_input_epoch,
            input_sequence: Some(order.input_sequence),
        })
    }

    pub fn send_text(
        &self,
        view_id: &str,
        client_id: &str,
        attachment_epoch: u64,
        input_sequence: u64,
        text: String,
    ) -> Result<()> {
        self.authorize_and_enqueue(
            view_id,
            client_id,
            attachment_epoch,
            input_sequence,
            InputOperation::Text(text),
            true,
        )
    }

    pub fn paste(
        &self,
        view_id: &str,
        client_id: &str,
        attachment_epoch: u64,
        input_sequence: u64,
        text: String,
    ) -> Result<()> {
        self.authorize_and_enqueue(
            view_id,
            client_id,
            attachment_epoch,
            input_sequence,
            InputOperation::Paste(text),
            true,
        )
    }

    pub fn key(
        &self,
        view_id: &str,
        client_id: &str,
        attachment_epoch: u64,
        input_sequence: u64,
        input: KeyInput,
    ) -> Result<()> {
        self.authorize_and_enqueue(
            view_id,
            client_id,
            attachment_epoch,
            input_sequence,
            InputOperation::Key(input),
            true,
        )
    }

    pub fn mouse(
        &self,
        view_id: &str,
        client_id: &str,
        attachment_epoch: u64,
        input_sequence: u64,
        input: MouseInput,
    ) -> Result<()> {
        self.authorize_and_enqueue(
            view_id,
            client_id,
            attachment_epoch,
            input_sequence,
            InputOperation::Mouse(input),
            true,
        )
    }

    pub fn focus(
        &self,
        view_id: &str,
        client_id: &str,
        attachment_epoch: u64,
        input_sequence: u64,
        focused: bool,
    ) -> Result<()> {
        self.authorize_and_enqueue(
            view_id,
            client_id,
            attachment_epoch,
            input_sequence,
            InputOperation::Focus(focused),
            false,
        )
    }

    pub fn scroll(
        &self,
        view_id: &str,
        client_id: &str,
        attachment_epoch: u64,
        input_sequence: u64,
        rows: isize,
    ) -> Result<()> {
        self.authorize_and_enqueue(
            view_id,
            client_id,
            attachment_epoch,
            input_sequence,
            InputOperation::Scroll(rows),
            true,
        )
    }

    pub fn interrupt(
        &self,
        view_id: &str,
        client_id: &str,
        attachment_epoch: u64,
        input_sequence: u64,
    ) -> Result<()> {
        self.authorize_and_enqueue(
            view_id,
            client_id,
            attachment_epoch,
            input_sequence,
            InputOperation::Interrupt,
            true,
        )
    }

    fn execute_input(&self, operation: InputOperation) -> Result<()> {
        match operation {
            InputOperation::Text(text) => self.process.write(text.as_bytes()),
            InputOperation::Paste(text) => {
                let bytes = self.terminal.lock().unwrap().encode_paste(&text)?;
                self.process.write(&bytes)
            }
            InputOperation::Key(input) => self.execute_key(&input),
            InputOperation::Mouse(input) => self.execute_mouse(&input),
            InputOperation::Scroll(rows) => self.execute_scroll(rows),
            InputOperation::Focus(focused) => {
                let bytes = self.terminal.lock().unwrap().encode_focus(focused)?;
                self.process.write(&bytes)
            }
            InputOperation::Interrupt => self.process.write(b"\x03"),
            InputOperation::Automation(operation) => self.execute_automation_input(operation),
        }
    }

    fn execute_automation_input(&self, operation: AutomationInputOperation) -> Result<()> {
        match operation {
            AutomationInputOperation::Text { text } => self.process.write(text.as_bytes()),
            AutomationInputOperation::Paste { text, submit } => {
                let bytes = {
                    let mut terminal = self.terminal.lock().unwrap();
                    let mut bytes = terminal.encode_paste(&text)?;
                    if submit {
                        bytes.extend_from_slice(&terminal.encode_key("Enter", "", 0, 0, 1)?);
                    }
                    bytes
                };
                self.process.write(&bytes)
            }
            AutomationInputOperation::Interrupt => self.process.write(b"\x03"),
        }
    }

    fn execute_key(&self, input: &KeyInput) -> Result<()> {
        let mut mods = 0_u16;
        if input.shift {
            mods |= 1 << 0;
        }
        if input.control {
            mods |= 1 << 1;
        }
        if input.alt {
            mods |= 1 << 2;
        }
        if input.meta {
            mods |= 1 << 3;
        }
        let action = match input.action {
            KeyAction::Up => 0,
            KeyAction::Down if input.repeat => 2,
            KeyAction::Down => 1,
        };
        let text = if !matches!(input.action, KeyAction::Up)
            && input.key.chars().count() == 1
            && !input.key.chars().any(char::is_control)
        {
            input.key.as_str()
        } else {
            ""
        };
        let bytes = self.terminal.lock().unwrap().encode_key(
            &input.code,
            text,
            input.unshifted_codepoint,
            mods,
            action,
        )?;
        self.process.write(&bytes)
    }

    fn execute_mouse(&self, input: &MouseInput) -> Result<()> {
        let action = match input.action {
            MouseAction::Press => 0,
            MouseAction::Release => 1,
            MouseAction::Motion => 2,
        };
        let mut mods = 0_u16;
        if input.shift {
            mods |= 1 << 0;
        }
        if input.control {
            mods |= 1 << 1;
        }
        if input.alt {
            mods |= 1 << 2;
        }
        if input.meta {
            mods |= 1 << 3;
        }
        let bytes = self.terminal.lock().unwrap().encode_mouse(
            action,
            input.button,
            mods,
            input.x,
            input.y,
            input.screen_width,
            input.screen_height,
            input.cell_width,
            input.cell_height,
            input.padding_left,
            input.padding_top,
        )?;
        self.process.write(&bytes)
    }

    fn execute_scroll(&self, rows: isize) -> Result<()> {
        if rows == 0 {
            return Ok(());
        }
        let (snapshot, alternate_input) = {
            let mut terminal = self.terminal.lock().unwrap();
            if terminal.alternate_scroll() {
                let code = if rows < 0 { "ArrowUp" } else { "ArrowDown" };
                let mut input = Vec::new();
                for _ in 0..rows.unsigned_abs().min(100) {
                    input.extend_from_slice(&terminal.encode_key(code, "", 0, 0, 1)?);
                }
                (None, input)
            } else {
                terminal.scroll(rows);
                (Some(terminal.snapshot()?), Vec::new())
            }
        };
        if !alternate_input.is_empty() {
            self.process.write(&alternate_input)?;
        }
        if let Some(snapshot) = snapshot {
            self.publish_snapshot(snapshot);
        }
        Ok(())
    }

    fn apply_resize(
        &self,
        cols: u16,
        rows: u16,
        layout_epoch: u64,
        previous_size: (u16, u16),
    ) -> Result<()> {
        self.process.resize(cols, rows)?;
        let snapshot = {
            let mut terminal = self.terminal.lock().unwrap();
            if let Err(error) = terminal.resize(cols, rows) {
                let _ = self.process.resize(previous_size.0, previous_size.1);
                return Err(error.into());
            }
            match terminal.snapshot() {
                Ok(snapshot) => snapshot,
                Err(error) => {
                    let _ = terminal.resize(previous_size.0, previous_size.1);
                    let _ = self.process.resize(previous_size.0, previous_size.1);
                    return Err(error.into());
                }
            }
        };
        self.layout_epoch.store(layout_epoch, Ordering::Release);
        self.publish_snapshot(snapshot);
        Ok(())
    }

    pub fn set_colors(
        &self,
        foreground: [u8; 3],
        background: [u8; 3],
        cursor: [u8; 3],
    ) -> Result<()> {
        let snapshot = {
            let mut terminal = self.terminal.lock().unwrap();
            terminal.set_colors(foreground, background, cursor)?;
            terminal.snapshot()?
        };
        self.publish_snapshot(snapshot);
        Ok(())
    }

    pub fn terminate(self: &Arc<Self>, source: TerminationSource) -> Result<()> {
        if self.has_exited() {
            return Ok(());
        }
        if self.termination_started.swap(true, Ordering::AcqRel) {
            return Ok(());
        }
        *self.requested_termination.lock().unwrap() = Some(source);
        self.summary.lock().unwrap().requested_termination = Some(source);
        {
            let mut order = self.input_order.lock().unwrap();
            if self.input_tx.try_send(InputOperation::Interrupt).is_ok() {
                order.input_sequence = order.input_sequence.saturating_add(1);
            } else {
                let _ = self.process.write(b"\x03");
            }
        }
        let session = Arc::clone(self);
        if let Err(error) = thread::Builder::new()
            .name(format!("pty-terminate-{}", session.id()))
            .spawn(move || {
                thread::sleep(INTERRUPT_GRACE);
                #[cfg(unix)]
                {
                    if !session.has_exited()
                        && let Err(error) = signal_process_group(session.process.pid, libc::SIGTERM)
                    {
                        eprintln!(
                            "[ghosttea] failed to terminate process group {}: {error:#}",
                            session.id()
                        );
                    }
                    if !session.has_exited() {
                        thread::sleep(TERMINATE_GRACE);
                    }
                    if !session.has_exited()
                        && let Err(error) = signal_process_group(session.process.pid, libc::SIGKILL)
                    {
                        eprintln!(
                            "[ghosttea] failed to sweep process group {}: {error:#}",
                            session.id()
                        );
                    }
                }
                #[cfg(not(unix))]
                {
                    if !session.has_exited() {
                        let _ = session.process.child.lock().unwrap().kill();
                    }
                }
            })
        {
            self.termination_started.store(false, Ordering::Release);
            return Err(error.into());
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clean_environment_contains_only_explicit_variables_and_terminal_contract() {
        let mut command = CommandBuilder::new("test");
        configure_environment(
            &mut command,
            HashMap::new(),
            Some(SessionEnvironment::Clean {
                variables: HashMap::from([
                    ("PATH".to_owned(), "/usr/bin:/bin".to_owned()),
                    ("AGENT_TOKEN".to_owned(), "allowed".to_owned()),
                ]),
            }),
        );
        assert_eq!(
            command.get_env("PATH"),
            Some(std::ffi::OsStr::new("/usr/bin:/bin"))
        );
        assert_eq!(
            command.get_env("AGENT_TOKEN"),
            Some(std::ffi::OsStr::new("allowed"))
        );
        assert_eq!(
            command.get_env("TERM"),
            Some(std::ffi::OsStr::new("xterm-256color"))
        );
        assert_eq!(command.get_env("GHOSTTEA_AUTH_TOKEN"), None);
    }

    #[test]
    fn identifies_service_environment_that_must_not_be_inherited() {
        assert!(is_private_service_environment("GHOSTTEA_AUTH_TOKEN"));
        assert!(is_private_service_environment(
            "GHOSTTEA_TRUFFLE_CAPABILITY"
        ));
        assert!(is_private_service_environment("TRUFFLE_TEST_AUTHKEY"));
        assert!(!is_private_service_environment("HOME"));
        assert!(!is_private_service_environment("CLAUDE_CODE_OAUTH_TOKEN"));
    }

    #[test]
    fn classifies_requested_and_observed_exit_outcomes() {
        assert_eq!(classify_exit(Some(0), None, None), ExitOutcome::Completed);
        assert_eq!(classify_exit(Some(2), None, None), ExitOutcome::Crashed);
        assert_eq!(
            classify_exit(None, Some("Terminated"), None),
            ExitOutcome::Signaled
        );
        assert_eq!(
            classify_exit(None, Some("Killed"), Some(TerminationSource::Application)),
            ExitOutcome::ApplicationTerminated
        );
    }
}
