use std::{
    collections::{HashMap, HashSet, VecDeque},
    sync::{Arc, Mutex, RwLock},
    time::Duration,
};

use anyhow::{Context, Result, bail};
use ghosttea_text::{FontMode, TextEngine};
use serde::Deserialize;
use serde_json::{Value, json};
use subtle::ConstantTimeEq;
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt},
    sync::{broadcast, watch},
    task::JoinHandle,
};

use crate::{
    FrameHub, ipc, mesh, session,
    session::{
        AutomationInputOperation, ExitCallback, KeyInput, MouseInput, Persistence, Session,
        SpawnOptions, TerminationSource,
    },
    tunnel_protocol,
};

const MAX_CONTROL_BYTES: usize = 1024 * 1024;
const MAX_FRAME_BYTES: usize = 16 * 1024 * 1024;
const MAX_FRAME_SUBSCRIPTION_BYTES: usize = 1024 * 1024;
const MAX_FRAME_SUBSCRIPTIONS: usize = 4096;
const MAX_AUTH_TOKEN_BYTES: usize = 1024;
const MAX_TERMINAL_COLS: u16 = 1_000;
const MAX_TERMINAL_ROWS: u16 = 1_000;
const MAX_CLOSED_OWNER_TOMBSTONES: usize = 16_384;
const CLOSED_OWNER_BLOOM_BITS: usize = 1 << 23;
const CLOSED_OWNER_BLOOM_HASHES: u64 = 4;
const CONTROL_PROTOCOL_MAJOR: u16 = 1;
const CONTROL_PROTOCOL_MINOR: u16 = 8;
const ACTIVITY_EVENT_PROTOCOL_MINOR: u16 = 6;
const EVENTS_LOST_PROTOCOL_MINOR: u16 = 8;
const ACTIVITY_SAMPLE_INTERVAL: Duration = Duration::from_millis(200);
const EVENT_CHANNEL_CAPACITY: usize = 1024;
/// How long an accepted connection may take to present its token before the
/// daemon reclaims the task and socket.
const AUTH_TIMEOUT: Duration = Duration::from_secs(10);

fn client_accepts_event(event: &Value, protocol_minor: u16) -> bool {
    event.get("type").and_then(Value::as_str) != Some("session-activity-changed")
        || protocol_minor >= ACTIVITY_EVENT_PROTOCOL_MINOR
}

struct TaskGuard(JoinHandle<()>);

impl Drop for TaskGuard {
    fn drop(&mut self) {
        self.0.abort();
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Envelope {
    request_id: u64,
    #[serde(flatten)]
    command: Command,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FrameSubscription {
    #[serde(default)]
    request_id: u64,
    session_handles: Vec<String>,
}

#[derive(Default)]
struct OwnerTombstones {
    recent_owners: HashSet<String>,
    order: VecDeque<String>,
    // The archive is monotonic: it can reject a never-seen owner on a rare
    // false positive, but it never forgets and reopens an owner that was closed.
    archived: Option<Box<[u64]>>,
}

impl OwnerTombstones {
    fn contains(&self, owner_id: &str) -> bool {
        self.recent_owners.contains(owner_id) || self.archived_contains(owner_id)
    }

    fn insert(&mut self, owner_id: String) {
        if self.contains(&owner_id) {
            return;
        }
        if !self.recent_owners.insert(owner_id.clone()) {
            return;
        }
        self.order.push_back(owner_id);
        while self.recent_owners.len() > MAX_CLOSED_OWNER_TOMBSTONES {
            if let Some(expired) = self.order.pop_front() {
                self.recent_owners.remove(&expired);
                self.archive(&expired);
            }
        }
    }

    fn archive(&mut self, owner_id: &str) {
        let archived = self.archived.get_or_insert_with(|| {
            vec![0; CLOSED_OWNER_BLOOM_BITS / u64::BITS as usize].into_boxed_slice()
        });
        for index in owner_bloom_indexes(owner_id) {
            archived[index / u64::BITS as usize] |= 1_u64 << (index % u64::BITS as usize);
        }
    }

    fn archived_contains(&self, owner_id: &str) -> bool {
        self.archived.as_ref().is_some_and(|archived| {
            owner_bloom_indexes(owner_id).into_iter().all(|index| {
                archived[index / u64::BITS as usize] & (1_u64 << (index % u64::BITS as usize)) != 0
            })
        })
    }
}

fn owner_bloom_indexes(owner_id: &str) -> [usize; CLOSED_OWNER_BLOOM_HASHES as usize] {
    let first = owner_hash(owner_id.as_bytes(), 0xcbf2_9ce4_8422_2325);
    let second = owner_hash(owner_id.as_bytes(), 0x9e37_79b9_7f4a_7c15) | 1;
    std::array::from_fn(|index| {
        first
            .wrapping_add((index as u64).wrapping_mul(second))
            .wrapping_add((index as u64).wrapping_mul(index as u64)) as usize
            & (CLOSED_OWNER_BLOOM_BITS - 1)
    })
}

fn owner_hash(bytes: &[u8], seed: u64) -> u64 {
    bytes.iter().fold(seed, |hash, byte| {
        (hash ^ u64::from(*byte)).wrapping_mul(0x0000_0100_0000_01b3)
    })
}

#[derive(Deserialize)]
#[serde(
    tag = "type",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
enum Command {
    Hello {
        protocol_major: u16,
        protocol_minor: u16,
        client_build: String,
    },
    CreateSession {
        options: SpawnOptions,
    },
    ListSessions,
    ListRemoteHosts,
    ListRemoteSessions {
        device_id: String,
    },
    OpenRemoteSession {
        device_id: String,
        remote_session_id: String,
        cols: u64,
        rows: u64,
        owner_id: Option<String>,
    },
    GetSession {
        session_id: String,
    },
    RefreshSession {
        session_id: String,
    },
    AttachSession {
        session_id: String,
        view_id: String,
    },
    DetachSession {
        session_id: String,
        view_id: String,
    },
    SendText {
        session_id: String,
        view_id: String,
        attachment_epoch: u64,
        input_sequence: u64,
        text: String,
    },
    Paste {
        session_id: String,
        view_id: String,
        attachment_epoch: u64,
        input_sequence: u64,
        text: String,
    },
    SendKey {
        session_id: String,
        view_id: String,
        attachment_epoch: u64,
        input_sequence: u64,
        event: KeyInput,
    },
    SendMouse {
        session_id: String,
        view_id: String,
        attachment_epoch: u64,
        input_sequence: u64,
        event: MouseInput,
    },
    Scroll {
        session_id: String,
        view_id: String,
        attachment_epoch: u64,
        input_sequence: u64,
        rows: i64,
    },
    ScrollTo {
        session_id: String,
        view_id: String,
        attachment_epoch: u64,
        input_sequence: u64,
        row: u64,
    },
    Focus {
        session_id: String,
        view_id: String,
        attachment_epoch: u64,
        input_sequence: u64,
        focused: bool,
    },
    FocusAndResize {
        session_id: String,
        view_id: String,
        attachment_epoch: u64,
        cols: u64,
        rows: u64,
    },
    Resize {
        session_id: String,
        view_id: String,
        attachment_epoch: u64,
        control_epoch: u64,
        resize_sequence: u64,
        cols: u64,
        rows: u64,
    },
    SetColors {
        session_id: String,
        foreground: [u8; 3],
        background: [u8; 3],
        cursor: [u8; 3],
    },
    SelectionText {
        session_id: String,
        view_id: String,
        attachment_epoch: u64,
        start_column: u64,
        start_row: u64,
        end_column: u64,
        end_row: u64,
        select_all: bool,
    },
    Interrupt {
        session_id: String,
        view_id: String,
        attachment_epoch: u64,
        input_sequence: u64,
    },
    GetAutomationState {
        session_id: String,
    },
    AutomationInput {
        session_id: String,
        expected_human_input_epoch: u64,
        operation: AutomationInputOperation,
    },
    Terminate {
        session_id: String,
        #[serde(default)]
        source: TerminationSource,
    },
    CloseSessionOwner {
        owner_id: String,
    },
    #[serde(other)]
    Unknown,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ResponseEnvelope {
    request_id: u64,
    #[serde(flatten)]
    body: ResponseBody,
}

#[derive(serde::Serialize)]
#[serde(
    tag = "type",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
enum ResponseBody {
    Hello {
        protocol_major: u16,
        protocol_minor: u16,
        server_build: String,
    },
    SessionCreated {
        session: session::SessionSummary,
    },
    Session {
        session: session::SessionSummary,
    },
    Sessions {
        sessions: Vec<session::SessionSummary>,
    },
    RemoteHosts {
        hosts: Vec<mesh::RemoteHostSummary>,
    },
    RemoteSessions {
        device_id: String,
        sessions: Vec<tunnel_protocol::SharedSessionSummary>,
    },
    ViewAttached {
        session_id: String,
        view_id: String,
        attachment_epoch: u64,
        read_write: bool,
    },
    ControlClaimed {
        session_id: String,
        controller_view_id: String,
        control_epoch: u64,
        cols: u16,
        rows: u16,
        layout_epoch: u64,
    },
    AutomationState {
        session_id: String,
        human_input_epoch: u64,
    },
    AutomationInputResult {
        session_id: String,
        accepted: bool,
        human_input_epoch: u64,
        input_sequence: Option<u64>,
        reason: Option<&'static str>,
    },
    SelectionText {
        text: String,
    },
    Ok,
    Error {
        message: String,
    },
}

pub type Registry = Arc<RwLock<HashMap<String, Arc<Session>>>>;

#[derive(Clone)]
struct ControlContext {
    registry: Registry,
    frames: FrameHub,
    event_tx: broadcast::Sender<Value>,
    text_engine: Arc<Mutex<TextEngine>>,
    mesh_runtime: Arc<dyn mesh::RemoteTerminalRuntime>,
    closed_owners: Arc<tokio::sync::Mutex<OwnerTombstones>>,
    private_env_prefixes: Arc<[String]>,
}

/// Local IPC endpoints and bearer token owned by the embedding application.
///
/// An endpoint is a Unix-domain socket path on Unix hosts and a named pipe
/// name such as `\\.\pipe\ghosttea-<instance>-control` on Windows.
pub struct TerminalServiceConfig {
    pub control_socket: String,
    pub frame_socket: String,
    pub auth_token: String,
}

/// Pre-bound local IPC listeners supplied by an embedding application.
///
/// Constructing these outside [`TerminalService`] lets a host own runtime
/// directory creation, endpoint replacement, permissions, and startup order.
pub struct TerminalServiceListeners {
    control: ipc::Listener,
    frames: ipc::Listener,
}

impl TerminalServiceListeners {
    pub fn new(control: ipc::Listener, frames: ipc::Listener) -> Self {
        Self { control, frames }
    }
}

/// What the service resolved on its way to serving, handed to the callback
/// installed with [`TerminalService::with_ready`].
///
/// The font values are the ones a host banner would report; they are delivered
/// as values rather than as a rendered string so the host owns its own
/// formatting.
#[derive(Clone, Debug)]
pub struct ReadyInfo {
    pub primary_family: String,
    pub font_mode: FontMode,
}

/// A terminal session service that can run locally or expose sessions through
/// an injected remote transport.
pub struct TerminalService {
    config: TerminalServiceConfig,
    mesh: Option<Box<dyn mesh::TerminalMesh>>,
    text_engine: Option<TextEngine>,
    private_env_prefixes: Vec<String>,
    ready: Option<Box<dyn FnOnce(ReadyInfo) + Send>>,
}

impl TerminalService {
    pub fn new(config: TerminalServiceConfig) -> Self {
        Self {
            config,
            mesh: None,
            text_engine: None,
            private_env_prefixes: Vec::new(),
            ready: None,
        }
    }

    /// Observe the moment the service has resolved its text engine and is
    /// about to accept connections.
    ///
    /// The library writes nothing to stdout: a host process may be speaking
    /// its own protocol there. A host that wants a readiness banner prints it
    /// from here, which also lets it choose the wording and the stream.
    pub fn with_ready<F>(mut self, ready: F) -> Self
    where
        F: FnOnce(ReadyInfo) + Send + 'static,
    {
        self.ready = Some(Box::new(ready));
        self
    }

    /// Strip additional host-private prefixes from inherited PTY
    /// environments. Explicit clean variables and inherited-mode overrides
    /// remain caller-owned and may intentionally reintroduce a value.
    pub fn with_private_env_prefixes<I, S>(mut self, prefixes: I) -> Result<Self>
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        for prefix in prefixes {
            let prefix = prefix.into();
            if prefix.is_empty() {
                bail!("private environment prefixes must not be empty");
            }
            if !self.private_env_prefixes.contains(&prefix) {
                self.private_env_prefixes.push(prefix);
            }
        }
        Ok(self)
    }

    /// Use host-provided font bytes and metrics instead of system discovery.
    pub fn with_text_engine(mut self, text_engine: TextEngine) -> Self {
        self.text_engine = Some(text_engine);
        self
    }

    /// Attach a terminal-scoped adapter around an already-running Truffle
    /// node. The terminal service never stops the underlying node.
    pub fn with_terminal_mesh<M>(mut self, mesh: M) -> Self
    where
        M: mesh::TerminalMesh + 'static,
    {
        self.mesh = Some(Box::new(mesh));
        self
    }

    /// Bind the configured endpoints using Ghosttea's convenience stale-endpoint
    /// replacement policy.
    pub fn bind(&self) -> Result<TerminalServiceListeners> {
        ipc::remove_stale_endpoint(&self.config.control_socket)?;
        ipc::remove_stale_endpoint(&self.config.frame_socket)?;
        Ok(TerminalServiceListeners::new(
            ipc::Listener::bind(&self.config.control_socket)?,
            ipc::Listener::bind(&self.config.frame_socket)?,
        ))
    }

    /// Bind the configured listeners and serve until either listener fails.
    pub async fn run(self) -> Result<()> {
        let listeners = self.bind()?;
        self.serve(listeners).await
    }

    /// Serve authenticated control and frame traffic on host-owned listeners.
    pub async fn serve(self, listeners: TerminalServiceListeners) -> Result<()> {
        let configured_text_engine = self.text_engine;
        let ready = self.ready;
        let auth_token = self.config.auth_token;
        let TerminalServiceListeners { control, frames } = listeners;
        let frame_hub = FrameHub::new(32);
        let (event_tx, _) = broadcast::channel::<Value>(EVENT_CHANNEL_CAPACITY);
        let registry: Registry = Arc::new(RwLock::new(HashMap::new()));
        let activity_registry = Arc::clone(&registry);
        let _activity_sampler_task = TaskGuard(tokio::spawn(async move {
            let mut interval = tokio::time::interval(ACTIVITY_SAMPLE_INTERVAL);
            interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            loop {
                interval.tick().await;
                let sessions = activity_registry
                    .read()
                    .unwrap()
                    .values()
                    .cloned()
                    .collect::<Vec<_>>();
                for session in sessions {
                    let _ = session.sample_activity();
                }
            }
        }));
        let mesh_runtime = self
            .mesh
            .as_ref()
            .map(|mesh| mesh.runtime())
            .unwrap_or_else(|| Arc::new(mesh::NoRemoteRuntime));
        let mut remote_controls = mesh_runtime.subscribe_control();
        let mut remote_activities = mesh_runtime.subscribe_activity();
        let remote_events = event_tx.clone();
        let _remote_control_task = TaskGuard(tokio::spawn(async move {
            loop {
                match remote_controls.recv().await {
                    Ok(changed) => {
                        let _ = remote_events.send(json!({
                            "requestId": 0,
                            "type": "control-changed",
                            "sessionId": changed.session_id,
                            "controllerViewId": changed.controller_view_id,
                            "controlEpoch": changed.control_epoch,
                            "cols": changed.cols,
                            "rows": changed.rows,
                            "layoutEpoch": changed.layout_epoch,
                        }));
                    }
                    Err(broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(broadcast::error::RecvError::Closed) => break,
                }
            }
        }));
        let remote_activity_events = event_tx.clone();
        let _remote_activity_task = TaskGuard(tokio::spawn(async move {
            loop {
                match remote_activities.recv().await {
                    Ok(changed) => {
                        let _ = remote_activity_events.send(json!({
                            "requestId": 0,
                            "type": "session-activity-changed",
                            "sessionId": changed.session_id,
                            "activity": changed.activity,
                        }));
                    }
                    Err(broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(broadcast::error::RecvError::Closed) => break,
                }
            }
        }));
        let text_engine = Arc::new(Mutex::new(match configured_text_engine {
            Some(text_engine) => text_engine,
            None => TextEngine::discover().context("system font discovery failed")?,
        }));

        if let Some(ready) = ready {
            // Read the values, release the lock, then hand them over: the
            // callback is host code and must not run under a service mutex.
            let info = {
                let engine = text_engine.lock().unwrap();
                ReadyInfo {
                    primary_family: engine.primary_family().to_owned(),
                    font_mode: engine.font_mode(),
                }
            };
            ready(info);
        }
        let _mesh_task = self.mesh.map(|mesh| {
            let mesh_registry = Arc::clone(&registry);
            TaskGuard(tokio::spawn(async move {
                if let Err(error) = mesh.serve(mesh_registry).await {
                    eprintln!("[terminal-mesh] stopped: {error:#}");
                }
            }))
        });
        let control_task = serve_control(
            control,
            auth_token.clone(),
            ControlContext {
                registry: Arc::clone(&registry),
                frames: frame_hub.clone(),
                event_tx,
                text_engine,
                mesh_runtime,
                closed_owners: Arc::default(),
                private_env_prefixes: self.private_env_prefixes.into(),
            },
        );
        let frame_task = serve_frames(frames, auth_token, frame_hub);
        tokio::try_join!(control_task, frame_task).map(|_| ())
    }
}

async fn read_packet<R: AsyncRead + Unpin>(stream: &mut R, limit: usize) -> Result<Vec<u8>> {
    let length = stream.read_u32_le().await? as usize;
    if length > limit {
        bail!("packet exceeds limit");
    }
    let mut bytes = vec![0; length];
    stream.read_exact(&mut bytes).await?;
    Ok(bytes)
}

async fn write_packet<W: AsyncWrite + Unpin>(stream: &mut W, bytes: &[u8]) -> Result<()> {
    stream.write_u32_le(bytes.len() as u32).await?;
    stream.write_all(bytes).await?;
    Ok(())
}

fn auth_tokens_equal(received: &[u8], expected: &[u8]) -> bool {
    if received.len() > MAX_AUTH_TOKEN_BYTES || expected.len() > MAX_AUTH_TOKEN_BYTES {
        return false;
    }
    let mut received_padded = [0_u8; MAX_AUTH_TOKEN_BYTES];
    let mut expected_padded = [0_u8; MAX_AUTH_TOKEN_BYTES];
    received_padded[..received.len()].copy_from_slice(received);
    expected_padded[..expected.len()].copy_from_slice(expected);
    bool::from(received_padded.ct_eq(&expected_padded) & received.len().ct_eq(&expected.len()))
}

async fn authenticate<S: AsyncRead + AsyncWrite + Unpin>(
    stream: &mut S,
    expected: &str,
) -> Result<()> {
    let token = read_packet(stream, MAX_AUTH_TOKEN_BYTES).await?;
    if !auth_tokens_equal(&token, expected.as_bytes()) {
        bail!("authentication failed");
    }
    write_packet(stream, b"ok").await
}

/// Commands that dial the mesh and may block on the network for as long as a
/// peer takes to answer. They run off the connection loop so input queued
/// behind them on the same socket stays latency-clean. None of them touch the
/// connection's view-attachment bookkeeping.
fn runs_off_connection_loop(command: &Command) -> bool {
    matches!(
        command,
        Command::ListRemoteHosts
            | Command::ListRemoteSessions { .. }
            | Command::OpenRemoteSession { .. }
    )
}

async fn serve_control(
    mut listener: ipc::Listener,
    token: String,
    context: ControlContext,
) -> Result<()> {
    loop {
        let mut socket = listener.accept().await?;
        let token = token.clone();
        let context = context.clone();
        tokio::spawn(async move {
            match tokio::time::timeout(AUTH_TIMEOUT, authenticate(&mut socket, &token)).await {
                Ok(Ok(())) => {}
                Ok(Err(_)) | Err(_) => return,
            }
            let mut events = context.event_tx.subscribe();
            let (mut reader, mut writer) = tokio::io::split(socket);
            let client_id = uuid::Uuid::new_v4().to_string();
            let mut attached = HashMap::<(String, String), u64>::new();
            let mut client_protocol_minor = 0_u16;
            // One writer task serializes packets from the connection loop and
            // from any commands running off it; clients pair responses to
            // requests by identifier, not by arrival order.
            let (outbound_tx, mut outbound_rx) = tokio::sync::mpsc::channel::<Vec<u8>>(256);
            let _writer_task = TaskGuard(tokio::spawn(async move {
                while let Some(bytes) = outbound_rx.recv().await {
                    if write_packet(&mut writer, &bytes).await.is_err() {
                        break;
                    }
                }
            }));
            loop {
                tokio::select! {
                    packet = read_packet(&mut reader, MAX_CONTROL_BYTES) => {
                        let Ok(packet) = packet else { break; };
                        let Ok(command) = serde_json::from_slice::<Envelope>(&packet) else { break; };
                        if let Command::Hello { protocol_major, protocol_minor, .. } = &command.command
                            && *protocol_major == CONTROL_PROTOCOL_MAJOR
                        {
                            client_protocol_minor = (*protocol_minor).min(CONTROL_PROTOCOL_MINOR);
                        }
                        let notification = command.request_id == 0;
                        if runs_off_connection_loop(&command.command) {
                            let context = context.clone();
                            let client_id = client_id.clone();
                            let outbound = outbound_tx.clone();
                            tokio::spawn(async move {
                                let mut detached_bookkeeping = HashMap::new();
                                let response = handle_command(command, &client_id, &mut detached_bookkeeping, &context).await;
                                if !notification {
                                    let _ = outbound.send(serde_json::to_vec(&response).unwrap()).await;
                                }
                            });
                            continue;
                        }
                        let response = handle_command(command, &client_id, &mut attached, &context).await;
                        if !notification && outbound_tx.send(serde_json::to_vec(&response).unwrap()).await.is_err() { break; }
                    }
                    event = events.recv() => match event {
                        Ok(event) => {
                            if !client_accepts_event(&event, client_protocol_minor) {
                                continue;
                            }
                            if outbound_tx.send(serde_json::to_vec(&event).unwrap()).await.is_err() { break; }
                        }
                        Err(broadcast::error::RecvError::Lagged(skipped)) => {
                            // Never drop events silently: a missed
                            // session-exited would leave a client showing a
                            // ghost session forever. Clients that understand
                            // the notice re-list sessions to resynchronize.
                            if client_protocol_minor < EVENTS_LOST_PROTOCOL_MINOR {
                                continue;
                            }
                            let notice = serde_json::to_vec(&json!({
                                "requestId": 0,
                                "type": "events-lost",
                                "skipped": skipped,
                            }))
                            .unwrap();
                            if outbound_tx.send(notice).await.is_err() { break; }
                        }
                        Err(broadcast::error::RecvError::Closed) => break,
                    }
                }
            }
            for ((session_id, view_id), attachment_epoch) in attached {
                if let Some(session) = context.registry.read().unwrap().get(&session_id).cloned() {
                    session.detach_view(&view_id, &client_id);
                } else {
                    context
                        .mesh_runtime
                        .detach_view(&session_id, &view_id, attachment_epoch)
                        .await;
                }
            }
        });
    }
}

async fn handle_command(
    command: Envelope,
    client_id: &str,
    attached: &mut HashMap<(String, String), u64>,
    context: &ControlContext,
) -> ResponseEnvelope {
    let request_id = command.request_id;
    let registry = &context.registry;
    let event_tx = &context.event_tx;
    let result: Result<ResponseBody> = async {
        match command.command {
            Command::Hello {
                protocol_major,
                protocol_minor,
                client_build,
            } => {
                let _client = (protocol_major, protocol_minor, client_build);
                Ok(ResponseBody::Hello {
                    protocol_major: CONTROL_PROTOCOL_MAJOR,
                    protocol_minor: CONTROL_PROTOCOL_MINOR,
                    server_build: env!("CARGO_PKG_VERSION").to_owned(),
                })
            }
            Command::CreateSession { options } => {
                validate_grid(options.cols, options.rows)?;
                validate_owner(options.owner_id.as_deref())?;
                if let Some(owner) = options.owner_id.as_deref()
                    && context.closed_owners.lock().await.contains(owner)
                {
                    bail!("session owner is already closed");
                }
                let registry_on_exit = Arc::clone(registry);
                let events_on_exit = event_tx.clone();
                let (session_exit_tx, mut control_exit) = watch::channel(false);
                let mut activity_exit = session_exit_tx.subscribe();
                let on_exit: ExitCallback = Arc::new(move |session_id, exit, persistence| {
                    session_exit_tx.send_replace(true);
                    if persistence != Persistence::KeepUntilExplicitClose {
                        registry_on_exit.write().unwrap().remove(&session_id);
                    }
                    let _ = events_on_exit.send(json!({
                        "requestId": 0,
                        "type": "session-exited",
                        "sessionId": session_id,
                        "exitCode": exit.exit_code,
                        "exitSignal": exit.exit_signal,
                        "requestedTermination": exit.requested_termination,
                        "exitOutcome": exit.exit_outcome,
                    }));
                });
                // openpty plus fork/exec is blocking work; keep it off the
                // async workers so concurrent creates don't stall the runtime.
                let session = {
                    let frames = context.frames.clone();
                    let text_engine = Arc::clone(&context.text_engine);
                    let private_env_prefixes = Arc::clone(&context.private_env_prefixes);
                    tokio::task::spawn_blocking(move || {
                        Session::spawn_with_private_env_prefixes(
                            options,
                            frames,
                            text_engine,
                            &private_env_prefixes,
                            on_exit,
                        )
                    })
                    .await
                    .context("session spawn task stopped")??
                };
                let summary = session.summary();
                let mut controls = session.subscribe_control();
                let mut activities = session.subscribe_activity();
                let control_session_id = summary.id.clone();
                let activity_session_id = summary.id.clone();
                let control_events = event_tx.clone();
                let activity_events = event_tx.clone();
                let control_session = Arc::downgrade(&session);
                let activity_session = Arc::downgrade(&session);
                tokio::spawn(async move {
                    loop {
                        tokio::select! {
                            changed = control_exit.changed() => {
                                if changed.is_err() || *control_exit.borrow() {
                                    break;
                                }
                            }
                            changed = controls.recv() => match changed {
                                Ok(changed) => {
                                    let _ = control_events.send(json!({
                                        "requestId": 0,
                                        "type": "control-changed",
                                        "sessionId": control_session_id,
                                        "controllerViewId": changed.controller.view_id,
                                        "controlEpoch": changed.controller.control_epoch,
                                        "cols": changed.cols,
                                        "rows": changed.rows,
                                        "layoutEpoch": changed.layout_epoch,
                                    }));
                                }
                                Err(broadcast::error::RecvError::Lagged(_)) => {
                                    // Skipped intermediates don't matter as
                                    // long as the client ends on the current
                                    // controller and size.
                                    let Some(session) = control_session.upgrade() else {
                                        break;
                                    };
                                    let (controller, cols, rows, layout_epoch) =
                                        session.control_state();
                                    let Some(controller) = controller else {
                                        continue;
                                    };
                                    let _ = control_events.send(json!({
                                        "requestId": 0,
                                        "type": "control-changed",
                                        "sessionId": control_session_id,
                                        "controllerViewId": controller.view_id,
                                        "controlEpoch": controller.control_epoch,
                                        "cols": cols,
                                        "rows": rows,
                                        "layoutEpoch": layout_epoch,
                                    }));
                                }
                                Err(broadcast::error::RecvError::Closed) => break,
                            },
                        }
                    }
                });
                tokio::spawn(async move {
                    loop {
                        let activity = tokio::select! {
                            changed = activity_exit.changed() => {
                                if changed.is_err() || *activity_exit.borrow() {
                                    break;
                                }
                                continue;
                            }
                            activity = activities.recv() => match activity {
                                Ok(activity) => activity,
                                Err(broadcast::error::RecvError::Lagged(_)) => {
                                    let Some(session) = activity_session.upgrade() else {
                                        break;
                                    };
                                    session.summary().activity
                                }
                                Err(broadcast::error::RecvError::Closed) => break,
                            },
                        };
                        let _ = activity_events.send(json!({
                            "requestId": 0,
                            "type": "session-activity-changed",
                            "sessionId": activity_session_id,
                            "activity": activity,
                        }));
                    }
                });
                // Re-check the tombstone while holding the lock across the
                // insert: a concurrent close-session-owner either finds this
                // session in the registry and sweeps it, or its tombstone is
                // already visible here and the create fails.
                {
                    let owner_lifecycle = context.closed_owners.lock().await;
                    if summary
                        .owner_id
                        .as_deref()
                        .is_some_and(|owner| owner_lifecycle.contains(owner))
                    {
                        drop(owner_lifecycle);
                        let _ = session.terminate(TerminationSource::User);
                        bail!("session owner is already closed");
                    }
                    registry
                        .write()
                        .unwrap()
                        .insert(summary.id.clone(), Arc::clone(&session));
                }
                if session.has_exited()
                    && session.persistence() != Persistence::KeepUntilExplicitClose
                {
                    registry.write().unwrap().remove(&summary.id);
                }
                Ok(ResponseBody::SessionCreated { session: summary })
            }
            Command::ListSessions => {
                let mut sessions: Vec<_> = {
                    registry
                        .read()
                        .unwrap()
                        .values()
                        .map(|session| session.summary())
                        .collect()
                };
                sessions.extend(context.mesh_runtime.summaries().await);
                Ok(ResponseBody::Sessions { sessions })
            }
            Command::ListRemoteHosts => Ok(ResponseBody::RemoteHosts {
                hosts: context.mesh_runtime.hosts().await?,
            }),
            Command::ListRemoteSessions { device_id } => {
                let sessions = context.mesh_runtime.list_sessions(&device_id).await?;
                Ok(ResponseBody::RemoteSessions {
                    device_id,
                    sessions,
                })
            }
            Command::OpenRemoteSession {
                device_id,
                remote_session_id,
                cols,
                rows,
                owner_id,
            } => {
                let cols = checked_dimension(cols, "cols", 2, MAX_TERMINAL_COLS)?;
                let rows = checked_dimension(rows, "rows", 1, MAX_TERMINAL_ROWS)?;
                validate_owner(owner_id.as_deref())?;
                if let Some(owner) = owner_id.as_deref()
                    && context.closed_owners.lock().await.contains(owner)
                {
                    bail!("session owner is already closed");
                }
                // The network dial happens without the owner lock so a slow
                // peer can never stall unrelated session creation; the
                // tombstone is re-checked once the session exists.
                let session = context
                    .mesh_runtime
                    .open_session(mesh::RemoteSessionOpen {
                        device_id,
                        remote_session_id,
                        cols,
                        rows,
                        owner_id,
                        frames: context.frames.clone(),
                        text_engine: Arc::clone(&context.text_engine),
                    })
                    .await?;
                let closed_after_open = match session.owner_id.as_deref() {
                    Some(owner) => context.closed_owners.lock().await.contains(owner),
                    None => false,
                };
                if closed_after_open {
                    context.mesh_runtime.close_session(&session.id).await;
                    bail!("session owner is already closed");
                }
                Ok(ResponseBody::SessionCreated { session })
            }
            Command::GetSession { session_id } => {
                let session =
                    if let Some(session) = registry.read().unwrap().get(&session_id).cloned() {
                        session.summary()
                    } else {
                        context
                            .mesh_runtime
                            .summary(&session_id)
                            .await
                            .context("unknown session")?
                    };
                Ok(ResponseBody::Session { session })
            }
            Command::RefreshSession { session_id } => {
                if let Some(session) = registry.read().unwrap().get(&session_id).cloned() {
                    session.refresh()?;
                } else {
                    context.mesh_runtime.refresh(&session_id).await?;
                }
                Ok(ResponseBody::Ok)
            }
            Command::AttachSession {
                session_id,
                view_id,
            } => {
                let key = (session_id.clone(), view_id.clone());
                let (attachment_epoch, read_write) = if let Some(epoch) =
                    attached.get(&key).copied()
                {
                    let read_write = if registry.read().unwrap().contains_key(&session_id) {
                        true
                    } else {
                        context
                            .mesh_runtime
                            .summary(&session_id)
                            .await
                            .context("unknown remote session")?
                            .read_write
                    };
                    (epoch, read_write)
                } else {
                    let attachment =
                        if let Some(session) = registry.read().unwrap().get(&session_id).cloned() {
                            let epoch = session.attach_view(&view_id, client_id)?;
                            mesh::RemoteAttachment {
                                attachment_epoch: epoch,
                                read_write: true,
                            }
                        } else {
                            context
                                .mesh_runtime
                                .attach_view(&session_id, &view_id)
                                .await?
                        };
                    attached.insert(key, attachment.attachment_epoch);
                    (attachment.attachment_epoch, attachment.read_write)
                };
                Ok(ResponseBody::ViewAttached {
                    session_id,
                    view_id,
                    attachment_epoch,
                    read_write,
                })
            }
            Command::DetachSession {
                session_id,
                view_id,
            } => {
                if let Some(epoch) = attached.remove(&(session_id.clone(), view_id.clone())) {
                    if let Some(session) = registry.read().unwrap().get(&session_id).cloned() {
                        session.detach_view(&view_id, client_id);
                    } else {
                        context
                            .mesh_runtime
                            .detach_view(&session_id, &view_id, epoch)
                            .await;
                    }
                }
                Ok(ResponseBody::Ok)
            }
            Command::SendText {
                session_id,
                view_id,
                attachment_epoch,
                input_sequence,
                text,
            } => {
                if let Some(session) = registry.read().unwrap().get(&session_id).cloned() {
                    session.send_text(
                        &view_id,
                        client_id,
                        attachment_epoch,
                        input_sequence,
                        text,
                    )?;
                } else {
                    context
                        .mesh_runtime
                        .send_input(
                            &session_id,
                            &view_id,
                            attachment_epoch,
                            input_sequence,
                            tunnel_protocol::TunnelInput::Text(text),
                        )
                        .await?;
                }
                Ok(ResponseBody::Ok)
            }
            Command::Paste {
                session_id,
                view_id,
                attachment_epoch,
                input_sequence,
                text,
            } => {
                if let Some(session) = registry.read().unwrap().get(&session_id).cloned() {
                    session.paste(&view_id, client_id, attachment_epoch, input_sequence, text)?;
                } else {
                    context
                        .mesh_runtime
                        .send_input(
                            &session_id,
                            &view_id,
                            attachment_epoch,
                            input_sequence,
                            tunnel_protocol::TunnelInput::Paste(text),
                        )
                        .await?;
                }
                Ok(ResponseBody::Ok)
            }
            Command::SendKey {
                session_id,
                view_id,
                attachment_epoch,
                input_sequence,
                event,
            } => {
                if let Some(session) = registry.read().unwrap().get(&session_id).cloned() {
                    session.key(&view_id, client_id, attachment_epoch, input_sequence, event)?;
                } else {
                    context
                        .mesh_runtime
                        .send_input(
                            &session_id,
                            &view_id,
                            attachment_epoch,
                            input_sequence,
                            tunnel_protocol::TunnelInput::Key(event),
                        )
                        .await?;
                }
                Ok(ResponseBody::Ok)
            }
            Command::SendMouse {
                session_id,
                view_id,
                attachment_epoch,
                input_sequence,
                event,
            } => {
                if event.screen_width > 32_768
                    || event.screen_height > 32_768
                    || event.cell_width == 0
                    || event.cell_height == 0
                    || !event.x.is_finite()
                    || !event.y.is_finite()
                {
                    bail!("invalid mouse geometry");
                }
                if let Some(session) = registry.read().unwrap().get(&session_id).cloned() {
                    session.mouse(&view_id, client_id, attachment_epoch, input_sequence, event)?;
                } else {
                    context
                        .mesh_runtime
                        .send_input(
                            &session_id,
                            &view_id,
                            attachment_epoch,
                            input_sequence,
                            tunnel_protocol::TunnelInput::Mouse(event),
                        )
                        .await?;
                }
                Ok(ResponseBody::Ok)
            }
            Command::Scroll {
                session_id,
                view_id,
                attachment_epoch,
                input_sequence,
                rows,
            } => {
                let rows = rows.clamp(-10_000, 10_000);
                if let Some(session) = registry.read().unwrap().get(&session_id).cloned() {
                    session.scroll(
                        &view_id,
                        client_id,
                        attachment_epoch,
                        input_sequence,
                        isize::try_from(rows)?,
                    )?;
                } else {
                    context
                        .mesh_runtime
                        .send_input(
                            &session_id,
                            &view_id,
                            attachment_epoch,
                            input_sequence,
                            tunnel_protocol::TunnelInput::Scroll(rows),
                        )
                        .await?;
                }
                Ok(ResponseBody::Ok)
            }
            Command::ScrollTo {
                session_id,
                view_id,
                attachment_epoch,
                input_sequence,
                row,
            } => {
                if let Some(session) = registry.read().unwrap().get(&session_id).cloned() {
                    session.scroll_to(
                        &view_id,
                        client_id,
                        attachment_epoch,
                        input_sequence,
                        usize::try_from(row)?,
                    )?;
                } else {
                    context
                        .mesh_runtime
                        .send_input(
                            &session_id,
                            &view_id,
                            attachment_epoch,
                            input_sequence,
                            tunnel_protocol::TunnelInput::ScrollTo(row),
                        )
                        .await?;
                }
                Ok(ResponseBody::Ok)
            }
            Command::Focus {
                session_id,
                view_id,
                attachment_epoch,
                input_sequence,
                focused,
            } => {
                if let Some(session) = registry.read().unwrap().get(&session_id).cloned() {
                    session.focus(
                        &view_id,
                        client_id,
                        attachment_epoch,
                        input_sequence,
                        focused,
                    )?;
                } else {
                    context
                        .mesh_runtime
                        .send_input(
                            &session_id,
                            &view_id,
                            attachment_epoch,
                            input_sequence,
                            tunnel_protocol::TunnelInput::Focus(focused),
                        )
                        .await?;
                }
                Ok(ResponseBody::Ok)
            }
            Command::FocusAndResize {
                session_id,
                view_id,
                attachment_epoch,
                cols,
                rows,
            } => {
                require_attachment(attached, &session_id, &view_id, attachment_epoch)?;
                let cols = checked_dimension(cols, "cols", 2, MAX_TERMINAL_COLS)?;
                let rows = checked_dimension(rows, "rows", 1, MAX_TERMINAL_ROWS)?;
                let (controller_view_id, control_epoch, cols, rows, layout_epoch) =
                    if let Some(session) = registry.read().unwrap().get(&session_id).cloned() {
                        let changed = session.claim_control(&view_id, client_id, cols, rows)?;
                        (
                            changed.controller.view_id,
                            changed.controller.control_epoch,
                            changed.cols,
                            changed.rows,
                            changed.layout_epoch,
                        )
                    } else {
                        let changed = context
                            .mesh_runtime
                            .claim_control(&session_id, &view_id, attachment_epoch, cols, rows)
                            .await?;
                        (
                            changed.controller_view_id,
                            changed.control_epoch,
                            changed.cols,
                            changed.rows,
                            changed.layout_epoch,
                        )
                    };
                Ok(ResponseBody::ControlClaimed {
                    session_id,
                    controller_view_id,
                    control_epoch,
                    cols,
                    rows,
                    layout_epoch,
                })
            }
            Command::Resize {
                session_id,
                view_id,
                attachment_epoch,
                control_epoch,
                resize_sequence,
                cols,
                rows,
            } => {
                require_attachment(attached, &session_id, &view_id, attachment_epoch)?;
                let cols = checked_dimension(cols, "cols", 2, MAX_TERMINAL_COLS)?;
                let rows = checked_dimension(rows, "rows", 1, MAX_TERMINAL_ROWS)?;
                if let Some(session) = registry.read().unwrap().get(&session_id).cloned() {
                    session.resize_view(
                        &view_id,
                        client_id,
                        control_epoch,
                        resize_sequence,
                        cols,
                        rows,
                    )?;
                } else {
                    context
                        .mesh_runtime
                        .resize(
                            &session_id,
                            &view_id,
                            mesh::RemoteResize {
                                attachment_epoch,
                                control_epoch,
                                resize_sequence,
                                cols,
                                rows,
                            },
                        )
                        .await?;
                }
                Ok(ResponseBody::Ok)
            }
            Command::SetColors {
                session_id,
                foreground,
                background,
                cursor,
            } => {
                if let Some(session) = registry.read().unwrap().get(&session_id).cloned() {
                    session.set_colors(foreground, background, cursor)?;
                } else if context.mesh_runtime.summary(&session_id).await.is_none() {
                    bail!("unknown session");
                }
                Ok(ResponseBody::Ok)
            }
            Command::SelectionText {
                session_id,
                view_id,
                attachment_epoch,
                start_column,
                start_row,
                end_column,
                end_row,
                select_all,
            } => {
                require_attachment(attached, &session_id, &view_id, attachment_epoch)?;
                let start_column =
                    checked_dimension(start_column, "startColumn", 0, MAX_TERMINAL_COLS)?;
                let end_column = checked_dimension(end_column, "endColumn", 0, MAX_TERMINAL_COLS)?;
                let start_row = u32::try_from(start_row).context("startRow is out of range")?;
                let end_row = u32::try_from(end_row).context("endRow is out of range")?;
                let text = if let Some(session) = registry.read().unwrap().get(&session_id).cloned()
                {
                    session.selection_text(
                        start_column,
                        start_row,
                        end_column,
                        end_row,
                        select_all,
                    )?
                } else {
                    context
                        .mesh_runtime
                        .selection_text(
                            &session_id,
                            &view_id,
                            mesh::RemoteSelection {
                                attachment_epoch,
                                start_column,
                                start_row,
                                end_column,
                                end_row,
                                select_all,
                            },
                        )
                        .await?
                };
                Ok(ResponseBody::SelectionText { text })
            }
            Command::Interrupt {
                session_id,
                view_id,
                attachment_epoch,
                input_sequence,
            } => {
                if let Some(session) = registry.read().unwrap().get(&session_id).cloned() {
                    session.interrupt(&view_id, client_id, attachment_epoch, input_sequence)?;
                } else {
                    context
                        .mesh_runtime
                        .send_input(
                            &session_id,
                            &view_id,
                            attachment_epoch,
                            input_sequence,
                            tunnel_protocol::TunnelInput::Interrupt,
                        )
                        .await?;
                }
                Ok(ResponseBody::Ok)
            }
            Command::GetAutomationState { session_id } => {
                let session = registry
                    .read()
                    .unwrap()
                    .get(&session_id)
                    .cloned()
                    .context("unknown or remote session")?;
                Ok(ResponseBody::AutomationState {
                    session_id,
                    human_input_epoch: session.automation_state(),
                })
            }
            Command::AutomationInput {
                session_id,
                expected_human_input_epoch,
                operation,
            } => {
                let session = registry
                    .read()
                    .unwrap()
                    .get(&session_id)
                    .cloned()
                    .context("unknown or remote session")?;
                let result = session.automation_input(expected_human_input_epoch, operation)?;
                Ok(ResponseBody::AutomationInputResult {
                    session_id,
                    accepted: result.accepted,
                    human_input_epoch: result.human_input_epoch,
                    input_sequence: result.input_sequence,
                    reason: (!result.accepted).then_some("human-input-conflict"),
                })
            }
            Command::Terminate { session_id, source } => {
                let local_session = { registry.read().unwrap().get(&session_id).cloned() };
                if let Some(session) = local_session {
                    for (view_id, _) in remove_session_attachments(attached, &session_id) {
                        session.detach_view(&view_id, client_id);
                    }
                    session.terminate(source)?;
                    registry.write().unwrap().remove(&session_id);
                } else {
                    if !context.mesh_runtime.close_session(&session_id).await {
                        bail!("unknown session");
                    }
                    remove_session_attachments(attached, &session_id);
                }
                Ok(ResponseBody::Ok)
            }
            Command::CloseSessionOwner { owner_id } => {
                validate_owner(Some(&owner_id))?;
                // The tombstone alone closes the owner; the sweeps below run
                // without the lock so a slow mesh peer can never stall
                // unrelated session creation behind an owner closure.
                context.closed_owners.lock().await.insert(owner_id.clone());
                let local_sessions = registry
                    .read()
                    .unwrap()
                    .values()
                    .filter(|session| session.owner_id().as_deref() == Some(owner_id.as_str()))
                    .cloned()
                    .collect::<Vec<_>>();
                for session in local_sessions {
                    for (view_id, _) in remove_session_attachments(attached, &session.id()) {
                        session.detach_view(&view_id, client_id);
                    }
                    // One failed termination must not strand the owner's
                    // remaining sessions in the registry.
                    if let Err(error) = session.terminate(TerminationSource::User) {
                        eprintln!(
                            "[ghosttea] failed to terminate session {} while closing owner {owner_id}: {error:#}",
                            session.id()
                        );
                    }
                    registry.write().unwrap().remove(&session.id());
                }
                let remote_sessions = context.mesh_runtime.summaries().await;
                for session in remote_sessions {
                    if session.owner_id.as_deref() == Some(owner_id.as_str()) {
                        context.mesh_runtime.close_session(&session.id).await;
                        remove_session_attachments(attached, &session.id);
                    }
                }
                Ok(ResponseBody::Ok)
            }
            Command::Unknown => bail!("unknown command"),
        }
    }
    .await;
    ResponseEnvelope {
        request_id,
        body: result.unwrap_or_else(|error| ResponseBody::Error {
            message: error.to_string(),
        }),
    }
}

fn validate_grid(cols: u16, rows: u16) -> Result<()> {
    if !(2..=MAX_TERMINAL_COLS).contains(&cols) {
        bail!("cols must be between 2 and {MAX_TERMINAL_COLS}");
    }
    if !(1..=MAX_TERMINAL_ROWS).contains(&rows) {
        bail!("rows must be between 1 and {MAX_TERMINAL_ROWS}");
    }
    Ok(())
}

fn validate_owner(owner_id: Option<&str>) -> Result<()> {
    if owner_id.is_some_and(|owner| owner.is_empty() || owner.len() > 256) {
        bail!("ownerId must contain between 1 and 256 bytes");
    }
    Ok(())
}

fn checked_dimension(value: u64, name: &str, minimum: u16, maximum: u16) -> Result<u16> {
    let value = u16::try_from(value).with_context(|| format!("{name} is out of range"))?;
    if !(minimum..=maximum).contains(&value) {
        bail!("{name} must be between {minimum} and {maximum}");
    }
    Ok(value)
}

fn require_attachment(
    attached: &HashMap<(String, String), u64>,
    session_id: &str,
    view_id: &str,
    attachment_epoch: u64,
) -> Result<()> {
    if attached
        .get(&(session_id.to_owned(), view_id.to_owned()))
        .is_some_and(|epoch| *epoch == attachment_epoch)
    {
        Ok(())
    } else {
        bail!("stale or unknown view attachment")
    }
}

fn remove_session_attachments(
    attached: &mut HashMap<(String, String), u64>,
    session_id: &str,
) -> Vec<(String, u64)> {
    let mut removed = Vec::new();
    attached.retain(|(attached_session_id, view_id), attachment_epoch| {
        if attached_session_id != session_id {
            return true;
        }
        removed.push((view_id.clone(), *attachment_epoch));
        false
    });
    removed
}

async fn serve_frames(mut listener: ipc::Listener, token: String, frames: FrameHub) -> Result<()> {
    loop {
        let mut socket = listener.accept().await?;
        let token = token.clone();
        let frames = frames.clone();
        let (mut rx, mut last_seen_ordinal) = frames.subscribe();
        tokio::spawn(async move {
            match tokio::time::timeout(AUTH_TIMEOUT, authenticate(&mut socket, &token)).await {
                Ok(Ok(())) => {}
                Ok(Err(_)) | Err(_) => return,
            }
            let (mut reader, mut writer) = tokio::io::split(socket);
            let mut subscription_starts = HashMap::<u64, u64>::new();
            loop {
                tokio::select! {
                    packet = read_packet(&mut reader, MAX_FRAME_SUBSCRIPTION_BYTES) => {
                        let Ok(packet) = packet else { break; };
                        let Ok(subscription) = serde_json::from_slice::<FrameSubscription>(&packet) else { break; };
                        if subscription.session_handles.len() > MAX_FRAME_SUBSCRIPTIONS {
                            break;
                        }
                        let Ok(parsed) = subscription
                            .session_handles
                            .into_iter()
                            .map(|handle| handle.parse::<u64>())
                            .collect::<Result<HashSet<_>, _>>()
                        else {
                            break;
                        };
                        let subscription_ordinal = frames.current_ordinal();
                        subscription_starts.retain(|handle, _| parsed.contains(handle));
                        for handle in parsed {
                            subscription_starts
                                .entry(handle)
                                .or_insert(subscription_ordinal);
                        }
                        let acknowledgement = serde_json::to_vec(&json!({
                            "type": "subscription-ack",
                            "requestId": subscription.request_id,
                        }))
                        .unwrap();
                        if write_packet(&mut writer, &acknowledgement).await.is_err() {
                            break;
                        }
                    }
                    frame = rx.recv() => match frame {
                        Ok(frame) if frame.len() <= MAX_FRAME_BYTES => {
                            if frame.ordinal <= last_seen_ordinal {
                                continue;
                            }
                            if frame.ordinal > last_seen_ordinal.saturating_add(1) {
                                let first = last_seen_ordinal.saturating_add(1);
                                let last = frame.ordinal.saturating_sub(1);
                                if let Some(notice) = frame_gap_notice(
                                    &frames,
                                    first,
                                    last,
                                    &subscription_starts,
                                )
                                    && write_packet(&mut writer, &notice).await.is_err()
                                {
                                    break;
                                }
                            }
                            last_seen_ordinal = frame.ordinal;
                            if subscription_starts
                                .get(&frame.session_handle)
                                .is_some_and(|start| frame.ordinal > *start)
                                && write_packet(&mut writer, &frame).await.is_err()
                            {
                                break;
                            }
                        }
                        Ok(_) => break,
                        Err(broadcast::error::RecvError::Lagged(skipped)) => {
                            let first = last_seen_ordinal.saturating_add(1);
                            let last = last_seen_ordinal.saturating_add(skipped);
                            last_seen_ordinal = last;
                            if let Some(notice) = frame_gap_notice(
                                &frames,
                                first,
                                last,
                                &subscription_starts,
                            )
                                && write_packet(&mut writer, &notice).await.is_err()
                            {
                                break;
                            }
                        }
                        Err(_) => break,
                    }
                }
            }
        });
    }
}

fn frame_gap_notice(
    frames: &FrameHub,
    first_ordinal: u64,
    last_ordinal: u64,
    subscription_starts: &HashMap<u64, u64>,
) -> Option<Vec<u8>> {
    let (handles, history_complete) =
        frames.affected_handles(first_ordinal, last_ordinal, subscription_starts);
    if handles.is_empty() {
        return None;
    }
    Some(
        serde_json::to_vec(&json!({
            "type": "frame-gap",
            "skipped": last_ordinal.saturating_sub(first_ordinal).saturating_add(1),
            "sessionHandles": handles.into_iter().map(|handle| handle.to_string()).collect::<Vec<_>>(),
            "historyComplete": history_complete,
        }))
        .unwrap(),
    )
}

#[cfg(test)]
fn frame_session_handle(frame: &[u8]) -> Option<u64> {
    Some(u64::from_le_bytes(frame.get(8..16)?.try_into().ok()?))
}

#[cfg(test)]
mod protocol_tests {
    use super::*;

    /// An endpoint name no other test shares, in the two forms `ipc::Listener`
    /// accepts: a socket path on Unix, a pipe name on Windows.
    struct Endpoint {
        name: String,
        /// Never read: held so the socket's directory outlives the test.
        #[cfg(unix)]
        #[allow(dead_code)]
        directory: tempfile::TempDir,
    }

    fn unique_endpoint(label: &str) -> Endpoint {
        #[cfg(windows)]
        {
            let id = uuid::Uuid::new_v4();
            Endpoint {
                name: format!(r"\\.\pipe\ghosttea-service-test-{label}-{id}"),
            }
        }
        #[cfg(unix)]
        {
            let directory = tempfile::tempdir().unwrap();
            let name = directory
                .path()
                .join(format!("{label}.sock"))
                .to_string_lossy()
                .into_owned();
            Endpoint { name, directory }
        }
    }

    /// The library announces readiness to its host instead of printing it.
    ///
    /// This is the behavioral half of the stdout contract; the source guard
    /// below is the half that keeps it from regressing.
    #[tokio::test]
    async fn serve_reports_readiness_to_the_host_rather_than_printing_it() {
        let control = unique_endpoint("ready-control");
        let frames = unique_endpoint("ready-frames");
        let engine = TextEngine::discover().unwrap();
        let expected_family = engine.primary_family().to_owned();
        let expected_mode = engine.font_mode();

        let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();
        let service = TerminalService::new(TerminalServiceConfig {
            control_socket: control.name.clone(),
            frame_socket: frames.name.clone(),
            auth_token: "secret".to_owned(),
        })
        .with_text_engine(engine)
        .with_ready(move |info| {
            let _ = ready_tx.send(info);
        });

        // `run` only returns on listener failure, so the readiness signal is
        // the sole way to observe that serving began.
        let serving = tokio::spawn(async move { service.run().await });
        let info = tokio::time::timeout(Duration::from_secs(30), ready_rx)
            .await
            .expect("readiness was never signalled")
            .expect("the service dropped the readiness sender");
        serving.abort();

        assert_eq!(info.primary_family, expected_family);
        assert_eq!(info.font_mode, expected_mode);
    }

    /// Nothing in the library may write to stdout: an embedding host owns that
    /// stream and may be speaking its own protocol on it. The readiness hook
    /// exists so `ghosttead` can print its banner without the library doing so.
    ///
    /// Scans each source only up to its test module, since test code may print
    /// freely. `eprintln!` is deliberately not matched — stderr stays open to
    /// the library for diagnostics.
    #[test]
    fn the_library_never_writes_to_the_host_stdout() {
        fn scan(directory: &std::path::Path, offenders: &mut Vec<String>) {
            for entry in std::fs::read_dir(directory).unwrap() {
                let path = entry.unwrap().path();
                if path.is_dir() {
                    scan(&path, offenders);
                    continue;
                }
                if path.extension().and_then(|extension| extension.to_str()) != Some("rs") {
                    continue;
                }
                let source = std::fs::read_to_string(&path).unwrap();
                let library = match source.find("#[cfg(test)]") {
                    Some(tests_begin) => &source[..tests_begin],
                    None => &source[..],
                };
                for (index, line) in library.lines().enumerate() {
                    // Drop the stderr macros first: `eprintln!` contains
                    // `println!`, and stderr stays open to the library.
                    let sanitized = line.replace("eprintln!", "").replace("eprint!", "");
                    let writes_stdout = sanitized.contains("println!")
                        || sanitized.contains("print!")
                        || sanitized.contains("stdout()");
                    // A doc comment may legitimately name the macro it replaced.
                    if writes_stdout && !line.trim_start().starts_with("//") {
                        offenders.push(format!(
                            "{}:{}: {}",
                            path.display(),
                            index + 1,
                            line.trim()
                        ));
                    }
                }
            }
        }

        let mut offenders = Vec::new();
        scan(
            &std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src"),
            &mut offenders,
        );
        assert!(
            offenders.is_empty(),
            "the ghosttea library must not write to the host's stdout; \
             use TerminalService::with_ready and let the host print:\n{}",
            offenders.join("\n")
        );
    }

    #[test]
    fn verifies_local_auth_tokens_without_length_shortcuts() {
        assert!(auth_tokens_equal(b"secret", b"secret"));
        assert!(auth_tokens_equal(b"", b""));
        assert!(!auth_tokens_equal(b"secret", b"secreu"));
        assert!(!auth_tokens_equal(b"secret", b"secret-longer"));
        assert!(!auth_tokens_equal(
            &vec![b'x'; MAX_AUTH_TOKEN_BYTES + 1],
            b"secret",
        ));
    }

    #[test]
    fn validates_host_private_environment_prefixes() {
        let config = TerminalServiceConfig {
            control_socket: "control.sock".to_owned(),
            frame_socket: "frames.sock".to_owned(),
            auth_token: "secret".to_owned(),
        };
        let service = TerminalService::new(config)
            .with_private_env_prefixes(["FIELD_", "FIELD_"])
            .unwrap();
        assert_eq!(service.private_env_prefixes, ["FIELD_"]);

        let config = TerminalServiceConfig {
            control_socket: "control.sock".to_owned(),
            frame_socket: "frames.sock".to_owned(),
            auth_token: "secret".to_owned(),
        };
        assert!(
            TerminalService::new(config)
                .with_private_env_prefixes([""])
                .is_err()
        );
    }

    #[test]
    fn deserializes_typed_commands() {
        let envelope: Envelope = serde_json::from_value(json!({
            "requestId": 12,
            "type": "resize",
            "sessionId": "session",
            "viewId": "view",
            "attachmentEpoch": 3,
            "controlEpoch": 4,
            "resizeSequence": 2,
            "cols": 120,
            "rows": 40,
        }))
        .unwrap();
        assert_eq!(envelope.request_id, 12);
        match envelope.command {
            Command::Resize {
                session_id,
                cols,
                rows,
                ..
            } => {
                assert_eq!(session_id, "session");
                assert_eq!((cols, rows), (120, 40));
            }
            _ => panic!("expected resize command"),
        }
    }

    #[test]
    fn deserializes_layout_identity_for_key_events_with_legacy_fallback() {
        let key_command = |unshifted_codepoint: Option<u32>| {
            let mut event = json!({
                "type": "down",
                "key": "w",
                "code": "KeyW",
                "repeat": false,
                "shift": false,
                "control": false,
                "alt": false,
                "meta": false,
            });
            if let Some(codepoint) = unshifted_codepoint {
                event["unshiftedCodepoint"] = json!(codepoint);
            }
            serde_json::from_value::<Envelope>(json!({
                "requestId": 13,
                "type": "send-key",
                "sessionId": "session",
                "viewId": "view",
                "attachmentEpoch": 3,
                "inputSequence": 1,
                "event": event,
            }))
            .unwrap()
        };

        for (value, expected) in [(Some(u32::from('w')), u32::from('w')), (None, 0)] {
            match key_command(value).command {
                Command::SendKey { event, .. } => assert_eq!(event.unshifted_codepoint, expected),
                _ => panic!("expected send-key command"),
            }
        }
    }

    #[test]
    fn frame_subscriptions_and_frame_handles_are_typed() {
        let subscription: FrameSubscription = serde_json::from_value(json!({
            "type": "subscribe",
            "requestId": 9,
            "sessionHandles": ["7", "11"]
        }))
        .unwrap();
        assert_eq!(subscription.request_id, 9);
        assert_eq!(subscription.session_handles, vec!["7", "11"]);

        let mut frame = vec![0_u8; 16];
        frame[8..16].copy_from_slice(&11_u64.to_le_bytes());
        assert_eq!(frame_session_handle(&frame), Some(11));
        assert_eq!(frame_session_handle(&frame[..15]), None);
    }

    #[test]
    fn closed_owner_tombstones_have_a_fixed_capacity() {
        let mut tombstones = OwnerTombstones::default();
        assert!(tombstones.archived.is_none());
        let closed_owner_count = MAX_CLOSED_OWNER_TOMBSTONES + 50_000;
        for index in 0..closed_owner_count {
            tombstones.insert(format!("owner-{index}"));
        }

        assert_eq!(tombstones.recent_owners.len(), MAX_CLOSED_OWNER_TOMBSTONES);
        assert_eq!(tombstones.order.len(), MAX_CLOSED_OWNER_TOMBSTONES);
        assert_eq!(
            tombstones.archived.as_ref().unwrap().len(),
            CLOSED_OWNER_BLOOM_BITS / u64::BITS as usize
        );
        for index in [
            0,
            1_000,
            MAX_CLOSED_OWNER_TOMBSTONES,
            closed_owner_count - 1,
        ] {
            assert!(tombstones.contains(&format!("owner-{index}")));
        }
        assert!(!tombstones.contains("owner-never-closed"));
    }

    #[test]
    fn terminating_a_session_removes_all_of_its_attachment_bookkeeping() {
        let mut attached = HashMap::from([
            (("session-a".to_owned(), "view-1".to_owned()), 1),
            (("session-a".to_owned(), "view-2".to_owned()), 2),
            (("session-b".to_owned(), "view-3".to_owned()), 3),
        ]);

        let mut removed = remove_session_attachments(&mut attached, "session-a");
        removed.sort();
        assert_eq!(
            removed,
            vec![("view-1".to_owned(), 1), ("view-2".to_owned(), 2)]
        );
        assert_eq!(
            attached,
            HashMap::from([(("session-b".to_owned(), "view-3".to_owned()), 3)])
        );
    }

    #[test]
    fn deserializes_absolute_terminal_selection_requests() {
        let envelope: Envelope = serde_json::from_value(json!({
            "requestId": 14,
            "type": "selection-text",
            "sessionId": "session",
            "viewId": "view",
            "attachmentEpoch": 3,
            "startColumn": 1,
            "startRow": 120,
            "endColumn": 8,
            "endRow": 124,
            "selectAll": false
        }))
        .unwrap();
        match envelope.command {
            Command::SelectionText {
                start_row, end_row, ..
            } => assert_eq!((start_row, end_row), (120, 124)),
            _ => panic!("expected selection-text command"),
        }
    }

    #[test]
    fn serializes_typed_responses() {
        let value = serde_json::to_value(ResponseEnvelope {
            request_id: 7,
            body: ResponseBody::Hello {
                protocol_major: CONTROL_PROTOCOL_MAJOR,
                protocol_minor: CONTROL_PROTOCOL_MINOR,
                server_build: "test".to_owned(),
            },
        })
        .unwrap();
        assert_eq!(value["requestId"], 7);
        assert_eq!(value["type"], "hello");
        assert_eq!(value["protocolMajor"], 1);
    }

    #[test]
    fn activity_events_are_gated_by_the_negotiated_minor_without_hiding_other_events() {
        let activity = json!({ "type": "session-activity-changed" });
        let exit = json!({ "type": "session-exited" });
        assert!(!client_accepts_event(
            &activity,
            ACTIVITY_EVENT_PROTOCOL_MINOR - 1
        ));
        assert!(client_accepts_event(
            &activity,
            ACTIVITY_EVENT_PROTOCOL_MINOR
        ));
        assert!(client_accepts_event(&exit, 0));
    }

    #[test]
    fn deserializes_automation_without_view_authority() {
        let envelope: Envelope = serde_json::from_value(json!({
            "requestId": 21,
            "type": "automation-input",
            "sessionId": "session",
            "expectedHumanInputEpoch": 4,
            "operation": { "kind": "paste", "text": "hello", "submit": true },
        }))
        .unwrap();
        match envelope.command {
            Command::AutomationInput {
                session_id,
                expected_human_input_epoch,
                operation: AutomationInputOperation::Paste { text, submit },
            } => {
                assert_eq!(session_id, "session");
                assert_eq!(expected_human_input_epoch, 4);
                assert_eq!(text, "hello");
                assert!(submit);
            }
            _ => panic!("expected automation input command"),
        }
    }

    #[test]
    fn deserializes_transactional_session_owner_closure() {
        let envelope: Envelope = serde_json::from_value(json!({
            "requestId": 22,
            "type": "close-session-owner",
            "ownerId": "tab-a",
        }))
        .unwrap();
        match envelope.command {
            Command::CloseSessionOwner { owner_id } => assert_eq!(owner_id, "tab-a"),
            _ => panic!("expected close-session-owner command"),
        }
    }

    #[test]
    fn preserves_unknown_commands_as_typed_errors() {
        let envelope: Envelope = serde_json::from_value(json!({
            "requestId": 20,
            "type": "future-command",
        }))
        .unwrap();
        assert!(matches!(envelope.command, Command::Unknown));
    }
}
