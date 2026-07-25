use std::{
    collections::HashMap,
    io::{Read, Write},
    path::Path,
    sync::{
        Arc, Mutex, Weak,
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use anyhow::{Context, Result};
use ghosttea_core::{
    ClipboardRequest, ControlChanged, ControllerState, InputOrderState, LogicalTerminalSnapshot,
    RenderRequest, TerminalEffect, TerminalModel, TerminalModelOptions, TerminalRuntime,
    TerminalUpdate, ViewAccess, ViewAuthority,
};
use ghosttea_text::TextEngine;
use portable_pty::{Child, CommandBuilder, MasterPty, PtySize, native_pty_system};
use serde::{Deserialize, Serialize};
use tokio::sync::broadcast;
use uuid::Uuid;

use crate::FrameHub;

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

#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum SessionProgramKind {
    InteractiveShell,
    Application,
    #[default]
    Auto,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ResolvedProgramKind {
    InteractiveShell,
    Application,
    Unknown,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum SessionActivityKind {
    ShellIdle,
    ForegroundJob,
    Unknown,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum SessionActivitySource {
    ShellIntegration,
    ProcessGroup,
    Unsupported,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum SessionActivityConfidence {
    Authoritative,
    Heuristic,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SessionActivity {
    pub kind: SessionActivityKind,
    pub source: SessionActivitySource,
    pub confidence: SessionActivityConfidence,
    pub root_process_group_id: Option<i32>,
    pub foreground_process_group_id: Option<i32>,
    pub observed_at_ms: u64,
}

impl SessionActivity {
    pub(crate) fn unsupported(observed_at_ms: u64) -> Self {
        Self {
            kind: SessionActivityKind::Unknown,
            source: SessionActivitySource::Unsupported,
            confidence: SessionActivityConfidence::Heuristic,
            root_process_group_id: None,
            foreground_process_group_id: None,
            observed_at_ms,
        }
    }

    fn same_observation(&self, other: &Self) -> bool {
        self.kind == other.kind
            && self.source == other.source
            && self.confidence == other.confidence
            && self.root_process_group_id == other.root_process_group_id
            && self.foreground_process_group_id == other.foreground_process_group_id
    }
}

impl Default for SessionActivity {
    fn default() -> Self {
        Self::unsupported(0)
    }
}

/// Infer activity from the PTY's foreground process group. Windows has no
/// process groups and reports `SessionActivity::unsupported` instead.
#[cfg(unix)]
fn classify_process_group_activity(
    program_kind: ResolvedProgramKind,
    root_process_group_id: Option<i32>,
    foreground_process_group_id: Option<i32>,
) -> SessionActivityKind {
    match (
        program_kind,
        root_process_group_id,
        foreground_process_group_id,
    ) {
        (_, Some(root), Some(foreground)) if root != foreground => {
            SessionActivityKind::ForegroundJob
        }
        (ResolvedProgramKind::InteractiveShell, Some(_), Some(_)) => SessionActivityKind::ShellIdle,
        (ResolvedProgramKind::Application, Some(_), Some(_)) => SessionActivityKind::ForegroundJob,
        _ => SessionActivityKind::Unknown,
    }
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
    #[serde(default)]
    pub program_kind: SessionProgramKind,
    pub owner_id: Option<String>,
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
    pub read_write: bool,
    pub title: Option<String>,
    pub cwd: Option<String>,
    pub bell_count: u64,
    pub pid: Option<u32>,
    pub created_at_ms: u64,
    pub exit_code: Option<i32>,
    pub exit_signal: Option<String>,
    pub requested_termination: Option<TerminationSource>,
    pub exit_outcome: Option<ExitOutcome>,
    pub owner_id: Option<String>,
    pub activity: SessionActivity,
}

pub struct Session {
    summary: Mutex<SessionSummary>,
    created_at_ms: u64,
    process: PtyProcess,
    model: Mutex<TerminalModel>,
    model_operation: Mutex<()>,
    exited: AtomicBool,
    frames: FrameHub,
    persistence: Persistence,
    on_exit: ExitCallback,
    authority: Mutex<ViewAuthority>,
    input_tx: mpsc::SyncSender<InputOperation>,
    input_order: Mutex<InputOrderState>,
    termination_started: AtomicBool,
    requested_termination: Mutex<Option<TerminationSource>>,
    logical_tx: broadcast::Sender<LogicalTerminalSnapshot>,
    control_tx: broadcast::Sender<ControlChanged>,
    activity_tx: broadcast::Sender<SessionActivity>,
    program_kind: ResolvedProgramKind,
}

enum InputOperation {
    Shutdown,
    Text(String),
    Paste(String),
    Key(KeyInput),
    Mouse(MouseInput),
    Scroll(isize),
    ScrollTo(usize),
    Focus(bool),
    Interrupt,
    Automation(AutomationInputOperation),
}

struct PtyProcess {
    master: Mutex<Box<dyn MasterPty + Send>>,
    writer: Mutex<Box<dyn Write + Send>>,
    child: Mutex<Box<dyn Child + Send + Sync>>,
    /// Read only by the process-group paths. Windows signals the child through
    /// `Child::kill` and never addresses it by identifier.
    #[cfg_attr(not(unix), allow(dead_code))]
    pid: Option<u32>,
}

struct ObservedProcessExit {
    exit_code: Option<i32>,
    exit_signal: Option<String>,
}

const INTERRUPT_GRACE: Duration = Duration::from_secs(2);
/// Grace between SIGTERM and SIGKILL. Windows escalates straight from the
/// interrupt to `Child::kill`, so it has no intermediate step to wait out.
#[cfg(unix)]
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

    #[cfg(unix)]
    fn process_group_activity(
        &self,
        program_kind: ResolvedProgramKind,
        observed_at_ms: u64,
    ) -> SessionActivity {
        let foreground_process_group_id = self.master.lock().unwrap().process_group_leader();
        let root_process_group_id = self.pid.and_then(|pid| {
            let pid = i32::try_from(pid).ok()?;
            let process_group_id = unsafe { libc::getpgid(pid) };
            (process_group_id > 0).then_some(process_group_id)
        });
        let kind = classify_process_group_activity(
            program_kind,
            root_process_group_id,
            foreground_process_group_id,
        );
        SessionActivity {
            kind,
            source: SessionActivitySource::ProcessGroup,
            confidence: SessionActivityConfidence::Heuristic,
            root_process_group_id,
            foreground_process_group_id,
            observed_at_ms,
        }
    }

    #[cfg(not(unix))]
    fn process_group_activity(
        &self,
        _program_kind: ResolvedProgramKind,
        observed_at_ms: u64,
    ) -> SessionActivity {
        SessionActivity::unsupported(observed_at_ms)
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

fn is_private_service_environment(key: &str, extra_prefixes: &[String]) -> bool {
    matches!(
        key,
        "GHOSTTEA_AUTH_TOKEN"
            | "TERMINALD_AUTH_TOKEN"
            | "GHOSTTEA_CONTROL_SOCKET"
            | "TERMINALD_CONTROL_SOCKET"
            | "GHOSTTEA_FRAME_SOCKET"
            | "TERMINALD_FRAME_SOCKET"
            | "GHOSTTEA_FONT_DIR"
            | "TERMINALD_FONT_DIR"
            | "TRUFFLE_TEST_AUTHKEY"
            | "TRUFFLE_SIDECAR_PATH"
    ) || key.starts_with("GHOSTTEA_TRUFFLE_")
        || key.starts_with("TERMINALD_TRUFFLE_")
        || key.starts_with("GHOSTTEA_EXTERNAL_")
        || extra_prefixes.iter().any(|prefix| key.starts_with(prefix))
}

fn remove_private_service_environment(
    command: &mut CommandBuilder,
    inherited_keys: impl IntoIterator<Item = String>,
    extra_prefixes: &[String],
) {
    for key in inherited_keys {
        if is_private_service_environment(&key, extra_prefixes) {
            command.env_remove(key);
        }
    }
}

fn configure_environment(
    command: &mut CommandBuilder,
    legacy: HashMap<String, String>,
    environment: Option<SessionEnvironment>,
    extra_private_prefixes: &[String],
) {
    let environment = environment.unwrap_or(SessionEnvironment::Inherit { overrides: legacy });
    match environment {
        SessionEnvironment::Inherit { overrides } => {
            remove_private_service_environment(
                command,
                std::env::vars().map(|(key, _)| key),
                extra_private_prefixes,
            );
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

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn resolve_program_kind(
    configured: SessionProgramKind,
    executable: &str,
    args: &[String],
) -> ResolvedProgramKind {
    match configured {
        SessionProgramKind::InteractiveShell => ResolvedProgramKind::InteractiveShell,
        SessionProgramKind::Application => ResolvedProgramKind::Application,
        SessionProgramKind::Auto => {
            let executable = Path::new(executable)
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or(executable)
                .trim_start_matches('-');
            let recognized_shell = matches!(
                executable,
                "sh" | "ash"
                    | "bash"
                    | "dash"
                    | "elvish"
                    | "fish"
                    | "ksh"
                    | "mksh"
                    | "nu"
                    | "xonsh"
                    | "zsh"
            );
            let invokes_command = args
                .iter()
                .any(|arg| arg == "-c" || arg == "--command" || !arg.starts_with('-'));
            if recognized_shell && !invokes_command {
                ResolvedProgramKind::InteractiveShell
            } else if recognized_shell {
                ResolvedProgramKind::Application
            } else {
                ResolvedProgramKind::Unknown
            }
        }
    }
}

impl Session {
    pub fn spawn(
        options: SpawnOptions,
        frames: FrameHub,
        text_engine: Arc<Mutex<TextEngine>>,
        on_exit: ExitCallback,
    ) -> Result<Arc<Self>> {
        Self::spawn_with_private_env_prefixes(options, frames, text_engine, &[], on_exit)
    }

    pub(crate) fn spawn_with_private_env_prefixes(
        options: SpawnOptions,
        frames: FrameHub,
        text_engine: Arc<Mutex<TextEngine>>,
        extra_private_prefixes: &[String],
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
            program_kind,
            owner_id,
        } = options;
        let program_kind = resolve_program_kind(program_kind, &executable, &args);
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
        configure_environment(&mut command, env, environment, extra_private_prefixes);
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
        let created_at_ms = now_ms();
        let (logical_tx, _) = broadcast::channel(8);
        let (control_tx, _) = broadcast::channel(16);
        let (activity_tx, _) = broadcast::channel(16);
        let runtime = Arc::new(TerminalRuntime::from_shared_text_engine(text_engine));
        let model = TerminalModel::new(
            runtime,
            TerminalModelOptions {
                session_handle: handle,
                session_epoch,
                layout_epoch: 1,
                cols,
                rows,
                scrollback_bytes: 10_000,
            },
        )?;
        let session = Arc::new(Self {
            summary: Mutex::new(SessionSummary {
                id,
                handle: handle.to_string(),
                executable,
                cols,
                rows,
                exited: false,
                read_write: true,
                title: None,
                cwd: None,
                bell_count: 0,
                pid,
                created_at_ms,
                exit_code: None,
                exit_signal: None,
                requested_termination: None,
                exit_outcome: None,
                owner_id,
                activity: SessionActivity::unsupported(created_at_ms),
            }),
            created_at_ms,
            process: PtyProcess {
                master: Mutex::new(pair.master),
                writer: Mutex::new(writer),
                child: Mutex::new(child),
                pid,
            },
            model: Mutex::new(model),
            model_operation: Mutex::new(()),
            exited: AtomicBool::new(false),
            frames,
            persistence,
            on_exit,
            authority: Mutex::new(ViewAuthority::new(cols, rows)),
            input_tx,
            input_order: Mutex::new(InputOrderState::default()),
            termination_started: AtomicBool::new(false),
            requested_termination: Mutex::new(None),
            logical_tx,
            control_tx,
            activity_tx,
            program_kind,
        });
        let _ = session.sample_activity();
        Self::start_input_actor(&session, input_rx);
        Self::start_reader(&session, reader);
        Ok(session)
    }

    fn start_input_actor(session: &Arc<Self>, input_rx: mpsc::Receiver<InputOperation>) {
        let session_id = session.id();
        let session = Arc::downgrade(session);
        std::thread::Builder::new()
            .name(format!("pty-input-{session_id}"))
            .spawn(move || {
                while let Ok(operation) = input_rx.recv() {
                    if matches!(operation, InputOperation::Shutdown) {
                        break;
                    }
                    let Some(session) = Weak::upgrade(&session) else {
                        break;
                    };
                    if session.has_exited() {
                        break;
                    }
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
                    let render = if session.has_active_views() {
                        RenderRequest::Damage
                    } else {
                        RenderRequest::None
                    };
                    let _operation = session.model_operation.lock().unwrap();
                    let update = session.model.lock().unwrap().feed(&batch, render);
                    match update {
                        Ok(update) => session.execute_update(update),
                        Err(error) => {
                            eprintln!("terminal model feed failed for {}: {error:#}", session.id())
                        }
                    }
                }
                session.exited.store(true, Ordering::Release);
                // Wake the input actor even when no more user input will arrive.
                // The actor only holds a Weak reference while blocked, so this
                // message is lifecycle coordination rather than an ownership
                // requirement.
                let _ = session.input_tx.try_send(InputOperation::Shutdown);
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
                if session.has_active_views() {
                    let _operation = session.model_operation.lock().unwrap();
                    match session.model.lock().unwrap().refresh(RenderRequest::Damage) {
                        Ok(update) => session.execute_update(update),
                        Err(error) => eprintln!(
                            "terminal model final refresh failed for {}: {error:#}",
                            session.id()
                        ),
                    }
                }
                (session.on_exit)(session.id(), exit, session.persistence);
            })
            .expect("PTY reader thread");
    }

    fn execute_update(&self, update: TerminalUpdate) {
        for effect in update {
            match effect {
                TerminalEffect::WriteToTransport(bytes) => {
                    if let Err(error) = self.process.write(&bytes) {
                        eprintln!(
                            "[ghosttea] terminal reply write failed for {}: {error:#}",
                            self.id()
                        );
                    }
                }
                TerminalEffect::MetadataChanged(metadata) => {
                    let mut summary = self.summary.lock().unwrap();
                    summary.cols = metadata.cols;
                    summary.rows = metadata.rows;
                    summary.title = metadata.title;
                    summary.cwd = metadata.cwd;
                }
                TerminalEffect::Bell => {
                    let mut summary = self.summary.lock().unwrap();
                    summary.bell_count = summary.bell_count.saturating_add(1);
                }
                TerminalEffect::ClipboardRequest(ClipboardRequest::Write(_)) => {
                    // The existing desktop renderer applies clipboard policy from the
                    // matching ordered TRF1 frame. Native Apple hosts handle this effect
                    // directly at their policy boundary.
                }
                TerminalEffect::LogicalSnapshotReady(snapshot) => {
                    let _ = self.logical_tx.send(snapshot);
                }
                TerminalEffect::FrameReady(frame) => {
                    self.frames.publish(frame);
                }
            }
        }
    }

    pub fn id(&self) -> String {
        self.summary.lock().unwrap().id.clone()
    }
    pub fn summary(&self) -> SessionSummary {
        self.summary.lock().unwrap().clone()
    }

    pub fn sample_activity(&self) -> Option<SessionActivity> {
        if self.has_exited() {
            return None;
        }
        let next = self
            .process
            .process_group_activity(self.program_kind, now_ms());
        let changed = {
            let mut summary = self.summary.lock().unwrap();
            if summary.activity.observed_at_ms != 0 && summary.activity.same_observation(&next) {
                false
            } else {
                summary.activity = next.clone();
                true
            }
        };
        if !changed {
            return None;
        }
        let _ = self.activity_tx.send(next.clone());
        Some(next)
    }

    pub fn subscribe_activity(&self) -> broadcast::Receiver<SessionActivity> {
        self.activity_tx.subscribe()
    }

    pub fn announce_activity(&self) {
        let _ = self
            .activity_tx
            .send(self.summary.lock().unwrap().activity.clone());
    }

    pub fn selection_text(
        &self,
        start_column: u16,
        start_row: u32,
        end_column: u16,
        end_row: u32,
        select_all: bool,
    ) -> Result<String> {
        let _operation = self.model_operation.lock().unwrap();
        self.model
            .lock()
            .unwrap()
            .selection_text((start_column, start_row), (end_column, end_row), select_all)
            .context("format terminal selection")
    }
    pub fn session_epoch(&self) -> u64 {
        self.model.lock().unwrap().session_epoch()
    }
    pub fn created_at_ms(&self) -> u64 {
        self.created_at_ms
    }
    pub fn logical_snapshot(&self) -> Option<LogicalTerminalSnapshot> {
        self.model.lock().unwrap().latest_logical()
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
        let attachment_epoch = {
            let mut authority = self.authority.lock().unwrap();
            authority.attach(view_id, client_id, access)?
        };
        let _operation = self.model_operation.lock().unwrap();
        let update = self.model.lock().unwrap().refresh(RenderRequest::Full)?;
        self.execute_update(update);
        Ok(attachment_epoch)
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
        if prepared.size_changed() {
            self.apply_resize(cols, rows, prepared.layout_epoch(), previous_size)?;
        }
        authority.commit_resize(view_id, prepared);
        Ok(prepared.size_changed())
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
        let _operation = self.model_operation.lock().unwrap();
        let update = self.model.lock().unwrap().refresh(RenderRequest::Full)?;
        self.execute_update(update);
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
            order.record_input(true);
        } else {
            order.record_input(false);
        }
        Ok(())
    }

    pub fn automation_state(&self) -> u64 {
        self.input_order.lock().unwrap().human_input_epoch()
    }

    pub fn automation_input(
        &self,
        expected_human_input_epoch: u64,
        operation: AutomationInputOperation,
    ) -> Result<AutomationInputResult> {
        let mut order = self.input_order.lock().unwrap();
        if !order.accepts_automation(expected_human_input_epoch) {
            return Ok(AutomationInputResult {
                accepted: false,
                human_input_epoch: order.human_input_epoch(),
                input_sequence: None,
            });
        }
        self.input_tx
            .try_send(InputOperation::Automation(operation))
            .map_err(|error| anyhow::anyhow!("terminal input queue unavailable: {error}"))?;
        let input_sequence = order.record_input(false);
        Ok(AutomationInputResult {
            accepted: true,
            human_input_epoch: order.human_input_epoch(),
            input_sequence: Some(input_sequence),
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

    pub fn scroll_to(
        &self,
        view_id: &str,
        client_id: &str,
        attachment_epoch: u64,
        input_sequence: u64,
        row: usize,
    ) -> Result<()> {
        self.authorize_and_enqueue(
            view_id,
            client_id,
            attachment_epoch,
            input_sequence,
            InputOperation::ScrollTo(row),
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
        let _operation = self.model_operation.lock().unwrap();
        match operation {
            InputOperation::Shutdown => Ok(()),
            InputOperation::Text(text) => self.process.write(text.as_bytes()),
            InputOperation::Paste(text) => {
                let bytes = self.model.lock().unwrap().encode_paste(&text)?;
                self.process.write(&bytes)
            }
            InputOperation::Key(input) => self.execute_key(&input),
            InputOperation::Mouse(input) => self.execute_mouse(&input),
            InputOperation::Scroll(rows) => self.execute_scroll(rows),
            InputOperation::ScrollTo(row) => self.execute_scroll_to(row),
            InputOperation::Focus(focused) => {
                let bytes = self.model.lock().unwrap().encode_focus(focused)?;
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
                    let mut model = self.model.lock().unwrap();
                    let mut bytes = model.encode_paste(&text)?;
                    if submit {
                        bytes.extend_from_slice(&model.encode_key("Enter", "", 0, 0, 1)?);
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
        let bytes = self.model.lock().unwrap().encode_key(
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
        let bytes = self.model.lock().unwrap().encode_mouse(
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
        let (update, alternate_input) = {
            let mut model = self.model.lock().unwrap();
            if model.alternate_scroll() {
                let code = if rows < 0 { "ArrowUp" } else { "ArrowDown" };
                let mut input = Vec::new();
                for _ in 0..rows.unsigned_abs().min(100) {
                    input.extend_from_slice(&model.encode_key(code, "", 0, 0, 1)?);
                }
                (None, input)
            } else {
                (Some(model.scroll(rows, RenderRequest::Damage)?), Vec::new())
            }
        };
        if !alternate_input.is_empty() {
            self.process.write(&alternate_input)?;
        }
        if let Some(update) = update {
            self.execute_update(update);
        }
        Ok(())
    }

    fn execute_scroll_to(&self, row: usize) -> Result<()> {
        let update = self
            .model
            .lock()
            .unwrap()
            .scroll_to(row, RenderRequest::Damage)?;
        self.execute_update(update);
        Ok(())
    }

    fn apply_resize(
        &self,
        cols: u16,
        rows: u16,
        layout_epoch: u64,
        previous_size: (u16, u16),
    ) -> Result<()> {
        let _operation = self.model_operation.lock().unwrap();
        self.process.resize(cols, rows)?;
        let update =
            match self
                .model
                .lock()
                .unwrap()
                .resize(cols, rows, layout_epoch, RenderRequest::Full)
            {
                Ok(update) => update,
                Err(error) => {
                    let _ = self.process.resize(previous_size.0, previous_size.1);
                    return Err(error);
                }
            };
        self.execute_update(update);
        Ok(())
    }

    pub fn set_colors(
        &self,
        foreground: [u8; 3],
        background: [u8; 3],
        cursor: [u8; 3],
    ) -> Result<()> {
        let _operation = self.model_operation.lock().unwrap();
        let update = self.model.lock().unwrap().set_colors(
            foreground,
            background,
            cursor,
            RenderRequest::Full,
        )?;
        self.execute_update(update);
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
                order.record_input(false);
            } else {
                let _operation = self.model_operation.lock().unwrap();
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

    #[cfg(unix)]
    fn wait_for_activity(
        session: &Session,
        expected: SessionActivityKind,
        timeout: Duration,
    ) -> bool {
        let started = Instant::now();
        while started.elapsed() < timeout {
            let _ = session.sample_activity();
            if session.summary().activity.kind == expected {
                return true;
            }
            thread::sleep(Duration::from_millis(20));
        }
        false
    }

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
            &[],
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
        assert!(is_private_service_environment("GHOSTTEA_AUTH_TOKEN", &[]));
        assert!(is_private_service_environment(
            "GHOSTTEA_TRUFFLE_CAPABILITY",
            &[],
        ));
        assert!(is_private_service_environment("TRUFFLE_TEST_AUTHKEY", &[]));
        assert!(is_private_service_environment(
            "FIELD_CONTROL_TOKEN",
            &["FIELD_".to_owned()],
        ));
        assert!(!is_private_service_environment(
            "HOME",
            &["FIELD_".to_owned()],
        ));
        assert!(!is_private_service_environment(
            "CLAUDE_CODE_OAUTH_TOKEN",
            &["FIELD_".to_owned()],
        ));
    }

    #[test]
    fn strips_host_private_prefixes_from_an_inherited_command() {
        let mut command = CommandBuilder::new("test");
        command.env("FIELD_CONTROL_TOKEN", "private");
        command.env("CLAUDE_CODE_OAUTH_TOKEN", "agent-owned");
        remove_private_service_environment(
            &mut command,
            [
                "FIELD_CONTROL_TOKEN".to_owned(),
                "CLAUDE_CODE_OAUTH_TOKEN".to_owned(),
            ],
            &["FIELD_".to_owned()],
        );
        assert_eq!(command.get_env("FIELD_CONTROL_TOKEN"), None);
        assert_eq!(
            command.get_env("CLAUDE_CODE_OAUTH_TOKEN"),
            Some(std::ffi::OsStr::new("agent-owned"))
        );
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

    #[test]
    fn resolves_explicit_and_auto_program_kinds_without_mistaking_shell_scripts_for_prompts() {
        assert_eq!(
            resolve_program_kind(SessionProgramKind::InteractiveShell, "/bin/custom", &[]),
            ResolvedProgramKind::InteractiveShell
        );
        assert_eq!(
            resolve_program_kind(SessionProgramKind::Auto, "/bin/zsh", &[]),
            ResolvedProgramKind::InteractiveShell
        );
        assert_eq!(
            resolve_program_kind(
                SessionProgramKind::Auto,
                "/bin/sh",
                &["-c".into(), "sleep 1".into()]
            ),
            ResolvedProgramKind::Application
        );
        assert_eq!(
            resolve_program_kind(SessionProgramKind::Auto, "/usr/bin/vim", &[]),
            ResolvedProgramKind::Unknown
        );
    }

    #[cfg(unix)]
    #[test]
    fn classifies_process_groups_only_when_program_identity_supports_the_inference() {
        assert_eq!(
            classify_process_group_activity(
                ResolvedProgramKind::InteractiveShell,
                Some(10),
                Some(10)
            ),
            SessionActivityKind::ShellIdle
        );
        assert_eq!(
            classify_process_group_activity(
                ResolvedProgramKind::InteractiveShell,
                Some(10),
                Some(20)
            ),
            SessionActivityKind::ForegroundJob
        );
        assert_eq!(
            classify_process_group_activity(ResolvedProgramKind::Application, Some(10), Some(10)),
            SessionActivityKind::ForegroundJob
        );
        assert_eq!(
            classify_process_group_activity(ResolvedProgramKind::Unknown, Some(10), Some(10)),
            SessionActivityKind::Unknown
        );
        assert_eq!(
            classify_process_group_activity(ResolvedProgramKind::Unknown, Some(10), Some(20)),
            SessionActivityKind::ForegroundJob
        );
    }

    #[cfg(unix)]
    #[test]
    fn naturally_exited_sessions_release_under_churn() {
        let frames = FrameHub::new(8);
        let text_engine = Arc::new(Mutex::new(TextEngine::discover().unwrap()));
        let mut sessions = Vec::with_capacity(128);
        for _ in 0..128 {
            let (exited_tx, exited_rx) = mpsc::channel();
            let session = Session::spawn(
                SpawnOptions {
                    executable: "/bin/sh".into(),
                    args: vec!["-c".into(), "exit 0".into()],
                    cwd: None,
                    env: HashMap::new(),
                    environment: Some(SessionEnvironment::Clean {
                        variables: HashMap::from([("PATH".into(), "/usr/bin:/bin".into())]),
                    }),
                    cols: 80,
                    rows: 24,
                    persistence: Persistence::KeepUntilExit,
                    program_kind: SessionProgramKind::Application,
                    owner_id: None,
                },
                frames.clone(),
                Arc::clone(&text_engine),
                Arc::new(move |_, _, _| {
                    let _ = exited_tx.send(());
                }),
            )
            .unwrap();
            sessions.push(Arc::downgrade(&session));
            exited_rx
                .recv_timeout(Duration::from_secs(5))
                .expect("short-lived session did not report exit");
            drop(session);
        }

        let started = Instant::now();
        while sessions.iter().any(|session| session.strong_count() > 0)
            && started.elapsed() < Duration::from_secs(5)
        {
            thread::yield_now();
        }
        assert!(
            sessions.iter().all(|session| session.strong_count() == 0),
            "one or more exited sessions are still retained by a per-session actor"
        );
    }

    #[cfg(unix)]
    #[test]
    fn observes_real_shell_foreground_jobs_interrupts_pipelines_and_background_jobs() {
        let shell = if Path::new("/bin/zsh").exists() {
            "/bin/zsh"
        } else {
            "/bin/sh"
        };
        let frames = FrameHub::new(8);
        let (exited_tx, exited_rx) = mpsc::channel();
        let session = Session::spawn(
            SpawnOptions {
                executable: shell.into(),
                args: Vec::new(),
                cwd: None,
                env: HashMap::new(),
                environment: Some(SessionEnvironment::Clean {
                    variables: HashMap::from([("PATH".into(), "/usr/bin:/bin".into())]),
                }),
                cols: 80,
                rows: 24,
                persistence: Persistence::TerminateWithApp,
                program_kind: SessionProgramKind::InteractiveShell,
                owner_id: None,
            },
            frames,
            Arc::new(Mutex::new(TextEngine::discover().unwrap())),
            Arc::new(move |_, _, _| {
                let _ = exited_tx.send(());
            }),
        )
        .unwrap();
        let view_id = "activity-test-view";
        let client_id = "activity-test-client";
        let attachment_epoch = session.attach_view(view_id, client_id).unwrap();

        assert!(wait_for_activity(
            &session,
            SessionActivityKind::ShellIdle,
            Duration::from_secs(2)
        ));
        let mut changes = session.subscribe_activity();
        assert!(session.sample_activity().is_none());
        assert!(matches!(
            changes.try_recv(),
            Err(broadcast::error::TryRecvError::Empty)
        ));

        session
            .send_text(
                view_id,
                client_id,
                attachment_epoch,
                1,
                "sleep 5 | cat\n".into(),
            )
            .unwrap();
        assert!(wait_for_activity(
            &session,
            SessionActivityKind::ForegroundJob,
            Duration::from_secs(2)
        ));
        session
            .interrupt(view_id, client_id, attachment_epoch, 2)
            .unwrap();
        assert!(wait_for_activity(
            &session,
            SessionActivityKind::ShellIdle,
            Duration::from_secs(2)
        ));

        session
            .send_text(view_id, client_id, attachment_epoch, 3, "sleep 1\n".into())
            .unwrap();
        assert!(wait_for_activity(
            &session,
            SessionActivityKind::ForegroundJob,
            Duration::from_secs(2)
        ));
        assert!(wait_for_activity(
            &session,
            SessionActivityKind::ShellIdle,
            Duration::from_secs(3)
        ));

        session
            .send_text(view_id, client_id, attachment_epoch, 4, "cat\n".into())
            .unwrap();
        assert!(wait_for_activity(
            &session,
            SessionActivityKind::ForegroundJob,
            Duration::from_secs(2)
        ));
        session
            .interrupt(view_id, client_id, attachment_epoch, 5)
            .unwrap();
        assert!(wait_for_activity(
            &session,
            SessionActivityKind::ShellIdle,
            Duration::from_secs(2)
        ));

        session
            .send_text(
                view_id,
                client_id,
                attachment_epoch,
                6,
                "sleep 1 &\n".into(),
            )
            .unwrap();
        thread::sleep(Duration::from_millis(250));
        let _ = session.sample_activity();
        assert!(wait_for_activity(
            &session,
            SessionActivityKind::ShellIdle,
            Duration::from_secs(2)
        ));

        session
            .terminate(TerminationSource::ServiceShutdown)
            .unwrap();
        exited_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("shell did not exit during test cleanup");
        assert!(session.sample_activity().is_none());
    }
}
