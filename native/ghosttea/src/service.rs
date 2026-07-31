use std::{
    collections::{HashMap, HashSet, VecDeque},
    sync::{
        Arc, Mutex, RwLock, Weak,
        atomic::{self, AtomicBool, AtomicUsize},
    },
    time::{Duration, Instant},
};

use anyhow::{Context, Result, bail};
use ghosttea_config::{ConfigLoadOptions, ConfigManager, ConfigSnapshot};
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
const CONTROL_PROTOCOL_MINOR: u16 = 10;
const ACTIVITY_EVENT_PROTOCOL_MINOR: u16 = 6;
const EVENTS_LOST_PROTOCOL_MINOR: u16 = 8;
const SESSION_CREATED_PROTOCOL_MINOR: u16 = 9;
const CONFIG_EVENT_PROTOCOL_MINOR: u16 = 10;
// A gate above the advertised minor would be unreachable: no client could ever
// negotiate high enough to receive the event it guards.
const _: () = assert!(SESSION_CREATED_PROTOCOL_MINOR <= CONTROL_PROTOCOL_MINOR);
const _: () = assert!(CONFIG_EVENT_PROTOCOL_MINOR <= CONTROL_PROTOCOL_MINOR);
const _: () = assert!(EVENTS_LOST_PROTOCOL_MINOR <= CONTROL_PROTOCOL_MINOR);
const _: () = assert!(ACTIVITY_EVENT_PROTOCOL_MINOR <= CONTROL_PROTOCOL_MINOR);
const ACTIVITY_SAMPLE_INTERVAL: Duration = Duration::from_millis(200);
const EVENT_CHANNEL_CAPACITY: usize = 1024;
/// How long an accepted connection may take to present its token before the
/// daemon reclaims the task and socket.
const AUTH_TIMEOUT: Duration = Duration::from_secs(10);

/// Whether a broadcast event may reach a client that negotiated this minor.
///
/// A pushed event added after a client's version must not surprise it, so each
/// one names the minor that introduced it. (`events-lost` is gated at its send
/// site instead: it is generated per connection rather than broadcast.)
fn client_accepts_event(event: &Value, protocol_minor: u16) -> bool {
    match event.get("type").and_then(Value::as_str) {
        Some("session-activity-changed") => protocol_minor >= ACTIVITY_EVENT_PROTOCOL_MINOR,
        Some("session-created") => protocol_minor >= SESSION_CREATED_PROTOCOL_MINOR,
        Some("config-changed") => protocol_minor >= CONFIG_EVENT_PROTOCOL_MINOR,
        _ => true,
    }
}

/// Announce a session that has just entered the local registry.
///
/// Carries the full summary so a subscriber needs no follow-up `list-sessions`,
/// and reuses the `session` key of the create response so one event name keeps
/// one shape on the wire; `requestId: 0` marks it as pushed.
fn announce_session_created(
    event_tx: &broadcast::Sender<Value>,
    summary: &session::SessionSummary,
) {
    let Ok(session) = serde_json::to_value(summary) else {
        return;
    };
    let _ = event_tx.send(json!({
        "requestId": 0,
        "type": "session-created",
        "session": session,
    }));
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
    GetConfig,
    ReloadConfig,
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
    SetPersistence {
        session_id: String,
        persistence: Persistence,
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
        config_revision: String,
    },
    Config {
        config: ConfigSnapshot,
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
    config: ConfigManager,
    shutdown: Arc<ShutdownState>,
}

/// Sessions that have been told to end but are no longer registry-resident.
///
/// The invariant this exists for: **a session whose ladder has started and
/// which is not in the registry must be here.** Termination removes the
/// registry entry immediately while the child can still take seconds to die,
/// so without this a drain snapshot would miss exactly the sessions that are
/// mid-death — resolve, let the host exit, and orphan them mid-grace.
/// Held weakly on purpose. A strong reference would keep every closed
/// session's PTY master, writer, shutdown pipe and scrollback alive until the
/// next shutdown — which for a long-running host means every closed tab leaks
/// a terminal. While a session is genuinely dying its reader and escalator
/// threads each hold a strong reference, so upgrading here always succeeds for
/// anything that still matters.
type DyingSessions = Mutex<HashMap<String, Weak<Session>>>;

/// Everything a shutdown needs to stop admissions and find what to drain.
#[derive(Default)]
struct ShutdownState {
    /// Set once, before the drain snapshots. Never cleared: a service that has
    /// begun shutting down does not reopen.
    admissions_closed: AtomicBool,
    /// Creates past the entry check but not yet resolved. A create parked in
    /// `spawn_blocking` is invisible to every snapshot, so the drain cannot
    /// conclude while this is non-zero.
    creates_in_flight: AtomicUsize,
    /// Published before `admissions_closed` flips, so a create refused inside
    /// the barrier can bound its own doomed session by the same deadline.
    deadline: Mutex<Option<Instant>>,
    dying: DyingSessions,
}

impl ShutdownState {
    /// Deposit into the dying set, then start the ladder — never the reverse,
    /// or the session is briefly terminating and untracked.
    fn terminate_tracked(
        &self,
        session: &Arc<Session>,
        source: TerminationSource,
        deadline: Option<Instant>,
    ) -> Result<()> {
        // Resolved before the lock: taking `dying` and then a session lock is
        // the only nesting here, and not needing it keeps the set's lock a
        // leaf.
        let session_id = session.id();
        {
            let mut dying = self.dying.lock().unwrap();
            // Prune here as well as in the drain: without a shutdown to force
            // it, nothing else would ever clear entries whose sessions have
            // finished, and the map would grow for the life of the host.
            dying.retain(|_, session| {
                session
                    .upgrade()
                    .is_some_and(|session| !session.has_concluded())
            });
            dying.insert(session_id, Arc::downgrade(session));
        }
        match deadline {
            Some(deadline) => session.terminate_within(source, deadline),
            None => session.terminate(source),
        }
    }

    /// Drop entries that have finished concluding. Lazy on purpose: a task per
    /// dying session would hold an `Arc` each and could go unscheduled during
    /// the very shutdown this set serves.
    fn prune_dying(&self) -> Vec<Arc<Session>> {
        let mut dying = self.dying.lock().unwrap();
        let mut alive = Vec::new();
        dying.retain(|_, session| match session.upgrade() {
            Some(session) if !session.has_concluded() => {
                alive.push(session);
                true
            }
            _ => false,
        });
        alive
    }

    fn admissions_closed(&self) -> bool {
        self.admissions_closed.load(atomic::Ordering::SeqCst)
    }
}

/// Marks a create as past the entry check and not yet resolved.
///
/// Released on drop, so every exit path — refusal, spawn failure, success —
/// decrements exactly once, and always after the session it produced has been
/// made visible in the registry or the dying set.
struct CreateInFlight<'a>(&'a ShutdownState);

impl<'a> CreateInFlight<'a> {
    fn enter(shutdown: &'a ShutdownState) -> Self {
        shutdown
            .creates_in_flight
            .fetch_add(1, atomic::Ordering::SeqCst);
        Self(shutdown)
    }
}

impl Drop for CreateInFlight<'_> {
    fn drop(&mut self) {
        self.0
            .creates_in_flight
            .fetch_sub(1, atomic::Ordering::SeqCst);
    }
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
    config_load_options: ConfigLoadOptions,
    mesh: Option<Box<dyn mesh::TerminalMesh>>,
    text_engine: Option<TextEngine>,
    private_env_prefixes: Vec<String>,
    ready: Option<Box<dyn FnOnce(ReadyInfo) + Send>>,
}

impl TerminalService {
    pub fn new(config: TerminalServiceConfig) -> Self {
        Self {
            config,
            config_load_options: ConfigLoadOptions::default(),
            mesh: None,
            text_engine: None,
            private_env_prefixes: Vec::new(),
            ready: None,
        }
    }

    /// Load an application-owned Ghostty-syntax overlay after Ghostty's
    /// standard user configuration files.
    pub fn with_config_path(mut self, path: impl Into<std::path::PathBuf>) -> Self {
        self.config_load_options.explicit_path = Some(path.into());
        self
    }

    /// Replace configuration source discovery. Embedders and tests can use
    /// this to opt out of standard files or provide isolated roots.
    pub fn with_config_load_options(mut self, options: ConfigLoadOptions) -> Self {
        self.config_load_options = options;
        self
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
    ///
    /// Returns only when a listener fails. A host that needs to stop the
    /// service deliberately wants [`TerminalService::serve_managed`].
    pub async fn serve(self, listeners: TerminalServiceListeners) -> Result<()> {
        let (handle, serving) = self.serve_managed(listeners);
        // Held for the lifetime of the future on purpose: while a handle
        // exists the coordinator keeps waiting for a shutdown that, here,
        // nobody can ask for — which is exactly this function's contract.
        let _handle = handle;
        serving.await
    }

    /// Serve, and hand back a handle that can stop the service.
    ///
    /// The future resolves on listener failure as [`TerminalService::serve`]
    /// does, and additionally on a completed
    /// [`ServiceHandle::shutdown`] — the first non-failure way serving ends.
    pub fn serve_managed(
        self,
        listeners: TerminalServiceListeners,
    ) -> (ServiceHandle, impl Future<Output = Result<()>>) {
        let (requests, shutdown_rx) = tokio::sync::mpsc::channel(1);
        let shutdown: Arc<ShutdownState> = Arc::default();
        (
            ServiceHandle {
                requests,
                shutdown: Arc::clone(&shutdown),
            },
            self.serve_until_shutdown(listeners, shutdown_rx, shutdown),
        )
    }

    async fn serve_until_shutdown(
        self,
        listeners: TerminalServiceListeners,
        mut shutdown_rx: tokio::sync::mpsc::Receiver<ShutdownRequest>,
        shutdown: Arc<ShutdownState>,
    ) -> Result<()> {
        let configured_text_engine = self.text_engine;
        let config = ConfigManager::load(self.config_load_options);
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
        let context = ControlContext {
            registry: Arc::clone(&registry),
            frames: frame_hub.clone(),
            event_tx,
            text_engine,
            mesh_runtime,
            closed_owners: Arc::default(),
            private_env_prefixes: self.private_env_prefixes.into(),
            config,
            shutdown: Arc::clone(&shutdown),
        };
        // Spawned rather than joined in place: the drain has to run *while*
        // both keep serving, so observers can watch `terminate`, `list-sessions`
        // and events for the whole of it. A select!-cancel shape would silence
        // exactly the connections that need to see the drain happen.
        let mut control_task =
            tokio::spawn(serve_control(control, auth_token.clone(), context.clone()));
        let mut frame_task = tokio::spawn(serve_frames(frames, auth_token, frame_hub));
        let finish = |result: std::result::Result<Result<()>, tokio::task::JoinError>| match result
        {
            Ok(served) => served,
            Err(error) => Err(anyhow::Error::new(error)).context("terminal listener task stopped"),
        };
        let mut handles_dropped = false;
        loop {
            tokio::select! {
                served = &mut control_task => return finish(served),
                served = &mut frame_task => return finish(served),
                // Once every handle is gone `recv` is permanently ready with
                // `None`, so this arm has to leave the select rather than
                // `continue` into a loop that never awaits anything again.
                request = shutdown_rx.recv(), if !handles_dropped => {
                    let Some(request) = request else {
                        handles_dropped = true;
                        continue;
                    };
                    let report = drain(&context, request.budget).await;
                    let _ = request.reply.send(report);
                    control_task.abort();
                    frame_task.abort();
                    return Ok(());
                }
            }
        }
    }
}

/// What a drain actually managed to do.
///
/// Reported rather than summarised as success: an embedder that promised "no
/// PTY outlives the service" needs to know when that promise was kept on time,
/// kept by force, or not kept at all.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct DrainReport {
    /// Concluded within their deadline.
    pub drained: usize,
    /// Concluded, but only after the deadline forced the ladder to the end.
    pub killed: usize,
    /// Still not concluded when the budget ran out, by session id.
    pub unresponsive: Vec<String>,
    /// Creates still inside their spawn when the budget ran out. Non-zero means
    /// a PTY may have been born that this drain could not wait for.
    pub pending_creates: usize,
    pub spent: Duration,
}

struct ShutdownRequest {
    budget: Duration,
    reply: tokio::sync::oneshot::Sender<DrainReport>,
}

/// Asks a running service to stop admitting sessions and drain the ones it has.
#[derive(Clone)]
pub struct ServiceHandle {
    requests: tokio::sync::mpsc::Sender<ShutdownRequest>,
    shutdown: Arc<ShutdownState>,
}

impl ServiceHandle {
    /// How many terminated-but-unregistered sessions are currently tracked.
    ///
    /// Read only by the Unix drain tests, which are the only ones that drive a
    /// live service over a socket.
    #[cfg(all(test, unix))]
    fn dying_count(&self) -> usize {
        self.shutdown.dying.lock().unwrap().len()
    }

    /// Stop admissions, drain every local session, and resolve when they have
    /// all concluded or `budget` expires — whichever comes first.
    ///
    /// The budget bounds the whole drain: ladder phases are scaled to fit it,
    /// so a small budget compresses the graces rather than reporting healthy
    /// sessions as unresponsive. Remote sessions are out of scope; they are
    /// governed by the host that owns them.
    pub async fn shutdown(&self, budget: Duration) -> Result<DrainReport> {
        // Answer precisely rather than leaving the caller to infer it from a
        // closed channel: admissions close as the first act of a drain, so a
        // second request — concurrent or after the fact — is distinguishable
        // from a service that simply stopped.
        if self.shutdown.admissions_closed() {
            bail!("terminal service is already shutting down");
        }
        let (reply, answer) = tokio::sync::oneshot::channel();
        self.requests
            .send(ShutdownRequest { budget, reply })
            .await
            .map_err(|_| anyhow::anyhow!("terminal service is already shutting down or stopped"))?;
        answer
            .await
            .context("terminal service stopped before reporting its drain")
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

/// Time held back from the session deadline so a forced end still has room to
/// reap, stamp, and broadcast before the budget expires.
///
/// A tuning knob rather than a constant: the conclusion path's final refresh
/// renders through the one shared text engine, so many still-viewed sessions
/// concluding at once serialise there. Calibrated for a handful of panes.
const REAP_RESERVE: Duration = Duration::from_millis(250);

/// How often to re-check when the only thing left is a create still inside its
/// `spawn_blocking`. There is nothing to await on, so this is a poll — kept
/// short because it bounds how long a drain lingers after the last session.
const IN_FLIGHT_POLL: Duration = Duration::from_millis(5);

/// A moment at the end of a drain for connection tasks to write the exit
/// events they were just handed.
///
/// The drain observes conclusion directly from the session, which can outrun a
/// client's socket; without this, stopping the listeners can cut off the very
/// `session-exited` an observer was watching the drain for. Taken out of the
/// remaining budget, never added to it.
const EVENT_FLUSH: Duration = Duration::from_millis(100);

/// Stop admitting sessions, end every local one, and report honestly.
///
/// The ordering here is the whole correctness argument:
///
/// 1. publish the deadline, so a create refused inside the barrier can bound
///    the session it already forked;
/// 2. close admissions;
/// 3. take and release the owner lock — the same lock a create holds across
///    its registry insert, so every in-flight create is now either inserted
///    (and visible below) or destined to be refused;
/// 4. only then start looking at what is live.
async fn drain(context: &ControlContext, budget: Duration) -> DrainReport {
    let started = Instant::now();
    // Saturating rather than `+`: an absurd budget from a caller must not
    // panic the task that owns the reply channel.
    let budget_ends = started
        .checked_add(budget)
        .unwrap_or_else(|| started + Duration::from_secs(3_600));
    let session_deadline = budget_ends.checked_sub(REAP_RESERVE).unwrap_or(started);

    *context.shutdown.deadline.lock().unwrap() = Some(session_deadline);
    context
        .shutdown
        .admissions_closed
        .store(true, atomic::Ordering::SeqCst);
    drop(context.closed_owners.lock().await);

    let mut concluded_at: HashMap<String, Option<Instant>> = HashMap::new();
    loop {
        // The counter is read *before* the snapshot, and a refusal deposits
        // into the dying set before it decrements. So a zero here means every
        // refusal's deposit is already visible to the snapshot taken next;
        // reading them the other way round could miss a session that landed in
        // between and let the drain resolve over a live PTY.
        let in_flight = context
            .shutdown
            .creates_in_flight
            .load(atomic::Ordering::SeqCst);
        let live = live_sessions(context);
        if live.is_empty() {
            if in_flight == 0 {
                break;
            }
            // Nothing to await yet, but a create is still inside its spawn.
            // Yield rather than spin: on a current-thread runtime a tight loop
            // here would starve the very task being waited for, turning a
            // bounded wait into a guaranteed one.
            tokio::time::sleep(IN_FLIGHT_POLL).await;
            if Instant::now() >= budget_ends {
                break;
            }
            continue;
        }
        for session in &live {
            concluded_at.entry(session.id()).or_default();
            if let Err(error) = session.terminate_within(
                session::TerminationSource::ServiceShutdown,
                session_deadline,
            ) {
                eprintln!(
                    "[ghosttea] failed to terminate {} during shutdown: {error:#}",
                    session.id()
                );
            }
        }
        for session in live {
            let remaining = budget_ends.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                break;
            }
            let mut conclusion = session.subscribe_conclusion();
            // Both results matter: the outer is the timeout, the inner would be
            // a closed channel. Only an actual conclusion counts as one.
            if matches!(
                tokio::time::timeout(remaining, conclusion.wait_for(|concluded| *concluded)).await,
                Ok(Ok(_))
            ) {
                concluded_at.insert(session.id(), Some(Instant::now()));
            }
        }
        if Instant::now() >= budget_ends {
            break;
        }
    }

    let flush = budget_ends
        .saturating_duration_since(Instant::now())
        .min(EVENT_FLUSH);
    if !flush.is_zero() {
        tokio::time::sleep(flush).await;
    }

    let mut report = DrainReport {
        pending_creates: context
            .shutdown
            .creates_in_flight
            .load(atomic::Ordering::SeqCst),
        ..DrainReport::default()
    };
    for (session_id, concluded) in concluded_at {
        // Timing is the only signal, so a session that concluded while another
        // was being awaited can be booked late; the distinction is a quality
        // report, not a correctness claim.
        match concluded {
            Some(at) if at <= session_deadline => report.drained += 1,
            Some(_) => report.killed += 1,
            None => report.unresponsive.push(session_id),
        }
    }
    report.unresponsive.sort();
    report.spent = started.elapsed();
    report
}

/// Everything this host still has to end: registered sessions plus the ones
/// already dying outside the registry, minus whatever has finished concluding.
///
/// One session is deliberately invisible here: one exiting *naturally* is
/// removed from the registry by `on_exit` a moment before its conclusion is
/// signalled, so in that window it is in neither set. That costs the report a
/// count, never a PTY — the child is reaped and the exit broadcast before
/// `on_exit` runs. Signalling conclusion earlier would close the gap and break
/// the property the drain depends on, that conclusion is strictly later than
/// exit; the undercount is the cheaper of the two.
fn live_sessions(context: &ControlContext) -> Vec<Arc<Session>> {
    // The registry guard below is a statement-scoped temporary, released at the
    // `;` before `prune_dying` takes the dying set on the next statement. Keep
    // it that way: binding it to a variable would hold registry across dying,
    // which is the reverse of the order termination takes them in.
    let mut live: HashMap<String, Arc<Session>> = context
        .registry
        .read()
        .unwrap()
        .values()
        .filter(|session| !session.has_concluded())
        .map(|session| (session.id(), Arc::clone(session)))
        .collect();
    for session in context.shutdown.prune_dying() {
        live.entry(session.id()).or_insert(session);
    }
    live.into_values().collect()
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
                    config_revision: context.config.snapshot().revision.clone(),
                })
            }
            Command::GetConfig => Ok(ResponseBody::Config {
                config: context.config.snapshot().as_ref().clone(),
            }),
            Command::ReloadConfig => {
                let (config, changed) = context.config.reload();
                if changed {
                    let colors = &config.terminal;
                    let sessions = registry
                        .read()
                        .unwrap()
                        .values()
                        .cloned()
                        .collect::<Vec<_>>();
                    for session in sessions {
                        session.set_colors(colors.foreground, colors.background, colors.cursor)?;
                    }
                    let config_value = serde_json::to_value(config.as_ref())
                        .context("serialize reloaded configuration")?;
                    let _ = event_tx.send(json!({
                        "requestId": 0,
                        "type": "config-changed",
                        "config": config_value,
                    }));
                }
                Ok(ResponseBody::Config {
                    config: config.as_ref().clone(),
                })
            }
            Command::CreateSession { options } => {
                validate_grid(options.cols, options.rows)?;
                validate_owner(options.owner_id.as_deref())?;
                // Count first, then check — the order is the guarantee. A
                // create that reads the flag as open before being descheduled
                // has already made itself visible, so a shutdown that observes
                // zero in-flight creates knows none can still appear. Checking
                // first would let a create slip between the read and the count
                // and fork a child after the drain had already resolved.
                let _in_flight = CreateInFlight::enter(&context.shutdown);
                if context.shutdown.admissions_closed() {
                    bail!("service is shutting down");
                }
                if let Some(owner) = options.owner_id.as_deref()
                    && context.closed_owners.lock().await.contains(owner)
                {
                    bail!("session owner is already closed");
                }
                let registry_on_exit = Arc::clone(registry);
                let events_on_exit = event_tx.clone();
                let (session_exit_tx, mut control_exit) = watch::channel(false);
                let mut activity_exit = session_exit_tx.subscribe();
                let on_exit: ExitCallback = Arc::new(move |session_id, exit| {
                    session_exit_tx.send_replace(true);
                    {
                        // Read the class under the same lock the removal takes,
                        // and the same one `set-persistence` writes under: a set
                        // that returned success before this point is the value
                        // that decides retention, never one sampled earlier.
                        let mut registry = registry_on_exit.write().unwrap();
                        let retain = registry
                            .get(&session_id)
                            .and_then(|session| session.persistence())
                            .is_some_and(|persistence| {
                                persistence == Persistence::KeepUntilExplicitClose
                            });
                        if !retain {
                            registry.remove(&session_id);
                        }
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
                    let terminal_config = context.config.snapshot().terminal.clone();
                    let scrollback_bytes = usize::try_from(terminal_config.scrollback_bytes)
                        .context("configured scrollback-limit does not fit this platform")?;
                    tokio::task::spawn_blocking(move || {
                        let session = Session::spawn_configured(
                            options,
                            frames,
                            text_engine,
                            &private_env_prefixes,
                            scrollback_bytes,
                            on_exit,
                        )?;
                        session.set_colors(
                            terminal_config.foreground,
                            terminal_config.background,
                            terminal_config.cursor,
                        )?;
                        Ok::<_, anyhow::Error>(session)
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
                        // Never in the registry, but its ladder is running, so
                        // the invariant applies: track it or lose it.
                        let _ = context.shutdown.terminate_tracked(
                            &session,
                            TerminationSource::User,
                            None,
                        );
                        bail!("session owner is already closed");
                    }
                    // The shutdown re-check that matters: the entry check ran
                    // before `spawn_blocking`, and a shutdown could have begun
                    // during the fork. The barrier takes this same lock, so a
                    // create either inserts before the drain's snapshot or is
                    // refused here — the registry cannot grow behind the drain.
                    if context.shutdown.admissions_closed() {
                        let deadline = *context.shutdown.deadline.lock().unwrap();
                        drop(owner_lifecycle);
                        // Already forked: refusing the request does not unmake
                        // the child, so hand it to the drain rather than
                        // dropping it and leaking a PTY the snapshot never saw.
                        let _ = context.shutdown.terminate_tracked(
                            &session,
                            TerminationSource::ServiceShutdown,
                            deadline,
                        );
                        bail!("service is shutting down");
                    }
                    registry
                        .write()
                        .unwrap()
                        .insert(summary.id.clone(), Arc::clone(&session));
                }
                // A child that died during spawn leaves nothing to keep unless
                // its class says otherwise. Read that class under the same lock
                // as the removal, exactly as the exit path does.
                let retained = {
                    let mut registry = registry.write().unwrap();
                    let retain = !session.has_exited()
                        || session.persistence() == Some(Persistence::KeepUntilExplicitClose);
                    if !retain {
                        registry.remove(&summary.id);
                    }
                    retain
                };
                if retained {
                    announce_session_created(event_tx, &summary);
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
            Command::SetPersistence {
                session_id,
                persistence,
            } => {
                // Hold the registry write lock across the write so this cannot
                // interleave with the retention decision that reads it back:
                // either the set lands and decides retention, or the session
                // has already concluded and left, and this reports that
                // honestly rather than succeeding over a session that is gone.
                let summary = {
                    let registry = registry.write().unwrap();
                    let session = registry
                        .get(&session_id)
                        .context("unknown or remote session")?;
                    session.set_persistence(persistence);
                    session.summary()
                };
                Ok(ResponseBody::Session { session: summary })
            }
            Command::Terminate { session_id, source } => {
                let local_session = { registry.read().unwrap().get(&session_id).cloned() };
                if let Some(session) = local_session {
                    for (view_id, _) in remove_session_attachments(attached, &session_id) {
                        session.detach_view(&view_id, client_id);
                    }
                    // Tracked, because the removal below outruns the ladder:
                    // the entry disappears while the child is still dying.
                    context.shutdown.terminate_tracked(&session, source, None)?;
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
                    // remaining sessions in the registry. Tracked for the same
                    // reason as the wire terminate, and more urgently: this
                    // removes a whole cohort at once, and an owner closed just
                    // before a shutdown would otherwise leave every one of them
                    // dying where no snapshot can see them.
                    if let Err(error) = context.shutdown.terminate_tracked(
                        &session,
                        TerminationSource::User,
                        None,
                    ) {
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

    /// A running service plus the pieces a test needs to talk to it.
    ///
    /// Unix-only: the client below speaks to a socket directly rather than
    /// through the Node client, and a named-pipe dial needs the retry dance
    /// that `ipc`'s own tests carry.
    #[cfg(unix)]
    struct TestService {
        handle: ServiceHandle,
        serving: tokio::task::JoinHandle<Result<()>>,
        control: String,
        token: String,
        _control_endpoint: Endpoint,
        _frame_endpoint: Endpoint,
    }

    #[cfg(unix)]
    fn start_test_service(label: &str) -> TestService {
        let control_endpoint = unique_endpoint(&format!("{label}-control"));
        let frame_endpoint = unique_endpoint(&format!("{label}-frames"));
        let token = "shutdown-test-token".to_owned();
        let service = TerminalService::new(TerminalServiceConfig {
            control_socket: control_endpoint.name.clone(),
            frame_socket: frame_endpoint.name.clone(),
            auth_token: token.clone(),
        })
        .with_text_engine(TextEngine::discover().unwrap());
        let listeners = service.bind().unwrap();
        let (handle, serving) = service.serve_managed(listeners);
        TestService {
            handle,
            serving: tokio::spawn(serving),
            control: control_endpoint.name.clone(),
            token,
            _control_endpoint: control_endpoint,
            _frame_endpoint: frame_endpoint,
        }
    }

    #[cfg(unix)]
    async fn connect_control(service: &TestService) -> tokio::net::UnixStream {
        let mut stream = tokio::net::UnixStream::connect(&service.control)
            .await
            .expect("control endpoint should accept a client");
        write_packet(&mut stream, service.token.as_bytes())
            .await
            .unwrap();
        let acknowledgement = read_packet(&mut stream, 64).await.unwrap();
        assert_eq!(acknowledgement, b"ok");
        stream
    }

    /// Send a command and return its response, skipping pushed events.
    #[cfg(unix)]
    async fn request(stream: &mut tokio::net::UnixStream, command: Value) -> Value {
        write_packet(stream, &serde_json::to_vec(&command).unwrap())
            .await
            .unwrap();
        loop {
            let packet = read_packet(stream, MAX_CONTROL_BYTES).await.unwrap();
            let response: Value = serde_json::from_slice(&packet).unwrap();
            if response["requestId"] != 0 {
                return response;
            }
        }
    }

    /// Long enough for the shell below to install its traps.
    ///
    /// Until it has, the ladder's opening interrupt simply kills it — which
    /// makes a "stubborn" child conclude in microseconds and quietly turns
    /// these tests into assertions about nothing.
    #[cfg(unix)]
    const TRAP_SETTLE: Duration = Duration::from_millis(600);

    /// A child that ignores both the interrupt and SIGTERM, so terminating it
    /// has to walk the whole ladder to SIGKILL.
    #[cfg(unix)]
    fn stubborn_session(request_id: u64) -> Value {
        json!({
            "requestId": request_id,
            "type": "create-session",
            "options": {
                "executable": "/bin/sh",
                "args": ["-c", "trap '' INT TERM; sleep 30"],
                "env": {},
                "environment": { "mode": "clean", "variables": { "PATH": "/usr/bin:/bin" } },
                "cols": 40,
                "rows": 10,
                "persistence": "terminate-with-app",
                "programKind": "application",
            },
        })
    }

    /// The drain ends every live session and says so, and the service refuses
    /// new ones from the moment it starts — including creates carrying no
    /// owner, which the per-owner tombstone would never have caught.
    #[cfg(unix)]
    #[tokio::test]
    async fn shutdown_drains_live_sessions_and_refuses_new_ones() {
        let service = start_test_service("drain");
        let mut client = connect_control(&service).await;
        let created = request(&mut client, stubborn_session(1)).await;
        assert_eq!(created["type"], "session-created");
        tokio::time::sleep(TRAP_SETTLE).await;

        let handle = service.handle.clone();
        let draining = tokio::spawn(async move { handle.shutdown(Duration::from_secs(8)).await });

        // Mid-drain, on a second connection: the create must be refused, and
        // refused without an owner id, which is the case per-owner closure
        // structurally cannot cover.
        tokio::time::sleep(Duration::from_millis(300)).await;
        let mut latecomer = connect_control(&service).await;
        let refused = request(&mut latecomer, stubborn_session(2)).await;
        assert_eq!(
            refused["type"], "error",
            "a create during a drain must fail"
        );
        assert!(
            refused["message"]
                .as_str()
                .unwrap()
                .contains("shutting down"),
            "the refusal must say why: {refused}"
        );

        let report = draining.await.unwrap().unwrap();
        assert_eq!(
            report.unresponsive,
            Vec::<String>::new(),
            "a SIGKILL-able child must not be reported unresponsive"
        );
        assert_eq!(
            report.drained + report.killed,
            1,
            "the live session must be accounted for exactly once: {report:?}"
        );
        assert_eq!(report.pending_creates, 0);
        assert!(service.serving.await.unwrap().is_ok());
        assert!(
            service
                .handle
                .shutdown(Duration::from_secs(1))
                .await
                .is_err(),
            "a second shutdown has nothing left to stop"
        );
    }

    /// A budget smaller than the default ladder compresses it rather than
    /// expiring by construction: the ladder alone is 5s, so finishing inside
    /// a 3s budget can only happen if the phases scaled.
    #[cfg(unix)]
    #[tokio::test]
    async fn shutdown_compresses_the_ladder_to_fit_a_small_budget() {
        let service = start_test_service("budget");
        let mut client = connect_control(&service).await;
        assert_eq!(
            request(&mut client, stubborn_session(1)).await["type"],
            "session-created"
        );
        tokio::time::sleep(TRAP_SETTLE).await;

        let started = Instant::now();
        let report = service
            .handle
            .shutdown(Duration::from_secs(3))
            .await
            .unwrap();
        let spent = started.elapsed();

        assert!(
            spent < Duration::from_millis(4_500),
            "the drain outran its budget, so the ladder did not scale: {spent:?}"
        );
        // Guards the premise: a child that died to the opening interrupt would
        // finish in microseconds and make the bound above vacuous.
        assert!(
            spent > Duration::from_millis(700),
            "the child was not actually stubborn, so this proved nothing: {spent:?}"
        );
        assert_eq!(
            report.unresponsive,
            Vec::<String>::new(),
            "a healthy-but-stubborn child must not be booked unresponsive: {report:?}"
        );
        assert_eq!(report.drained + report.killed, 1);
    }

    /// The leak the dying set exists for: a wire `terminate` drops the registry
    /// entry immediately while the child can still take seconds to die, so a
    /// shutdown arriving in that window must still find and await it.
    #[cfg(unix)]
    #[tokio::test]
    async fn shutdown_awaits_sessions_already_dying_outside_the_registry() {
        let service = start_test_service("dying");
        let mut client = connect_control(&service).await;
        let created = request(&mut client, stubborn_session(1)).await;
        let session_id = created["session"]["id"].as_str().unwrap().to_owned();
        tokio::time::sleep(TRAP_SETTLE).await;

        // Removed from the registry here, but its ladder is still running.
        let terminated = request(
            &mut client,
            json!({ "requestId": 2, "type": "terminate", "sessionId": session_id }),
        )
        .await;
        assert_eq!(terminated["type"], "ok");
        let listed = request(
            &mut client,
            json!({ "requestId": 3, "type": "list-sessions" }),
        )
        .await;
        assert!(
            !listed["sessions"]
                .as_array()
                .unwrap()
                .iter()
                .any(|session| session["id"] == session_id.as_str()),
            "the wire terminate should already have unregistered it"
        );

        let report = service
            .handle
            .shutdown(Duration::from_secs(8))
            .await
            .unwrap();

        assert_eq!(
            report.drained + report.killed,
            1,
            "a session dying outside the registry was not drained: {report:?}"
        );
        assert_eq!(report.unresponsive, Vec::<String>::new());
    }

    /// Closing tabs must not accumulate terminals.
    ///
    /// Tracking a dying session is what lets a drain find it, but tracking it
    /// *strongly* and pruning only during a shutdown would pin every closed
    /// session's PTY master, writer, shutdown pipe and scrollback for the life
    /// of the host — a leak per closed tab, on the ordinary path, with no
    /// shutdown in sight. This drives the wire `terminate` path specifically,
    /// since that is the one that leaked.
    #[cfg(unix)]
    #[tokio::test]
    async fn terminating_sessions_does_not_accumulate_them() {
        let service = start_test_service("churn");
        let mut client = connect_control(&service).await;
        let mut ids = Vec::new();
        for round in 0..12 {
            let created = request(
                &mut client,
                json!({
                    "requestId": 100 + round,
                    "type": "create-session",
                    "options": {
                        "executable": "/bin/sh",
                        "args": ["-c", "exit 0"],
                        "env": {},
                        "environment": { "mode": "clean", "variables": { "PATH": "/usr/bin:/bin" } },
                        "cols": 20,
                        "rows": 4,
                        "persistence": "terminate-with-app",
                        "programKind": "application",
                    },
                }),
            )
            .await;
            let session_id = created["session"]["id"].as_str().unwrap().to_owned();
            let _ = request(
                &mut client,
                json!({
                    "requestId": 200 + round,
                    "type": "terminate",
                    "sessionId": session_id,
                }),
            )
            .await;
            ids.push(session_id);
        }

        // Every one of them has been terminated, so once they conclude the set
        // must let go of them without a shutdown having to sweep it.
        let settled = tokio::time::timeout(Duration::from_secs(20), async {
            loop {
                if service.handle.dying_count() <= 1 {
                    return;
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        })
        .await;
        let remaining = service.handle.dying_count();
        assert!(
            settled.is_ok(),
            "{remaining} of {} terminated sessions were still retained",
            ids.len()
        );
    }

    /// A session already on its way out keeps the source that asked for it,
    /// while one the drain ends is stamped `service-shutdown`. The honest
    /// report is who asked first, not who happened to be last.
    ///
    /// These are the crate's first assertions on `ExitOutcome::ServiceTerminated`,
    /// which until now existed only in its declaration and its mapping.
    #[cfg(unix)]
    #[tokio::test]
    async fn shutdown_stamps_only_the_sessions_it_actually_ended() {
        let service = start_test_service("stamps");
        let mut client = connect_control(&service).await;
        let user_closed = request(&mut client, stubborn_session(1)).await;
        let drained = request(&mut client, stubborn_session(2)).await;
        let user_closed_id = user_closed["session"]["id"].as_str().unwrap().to_owned();
        let drained_id = drained["session"]["id"].as_str().unwrap().to_owned();
        tokio::time::sleep(TRAP_SETTLE).await;

        // Starts a ladder under `user` before any shutdown exists.
        assert_eq!(
            request(
                &mut client,
                json!({
                    "requestId": 3,
                    "type": "terminate",
                    "sessionId": user_closed_id,
                    "source": "user",
                }),
            )
            .await["type"],
            "ok"
        );

        // Collect the exit events while the drain runs; they are broadcast, so
        // this connection sees both sessions conclude.
        let exits = Arc::new(Mutex::new(Vec::<Value>::new()));
        let collected = Arc::clone(&exits);
        let (mut reader, _writer) = tokio::io::split(client);
        let collecting = tokio::spawn(async move {
            while let Ok(packet) = read_packet(&mut reader, MAX_CONTROL_BYTES).await {
                let Ok(event) = serde_json::from_slice::<Value>(&packet) else {
                    break;
                };
                if event["type"] == "session-exited" {
                    collected.lock().unwrap().push(event);
                }
            }
        });

        let report = service
            .handle
            .shutdown(Duration::from_secs(8))
            .await
            .unwrap();
        assert_eq!(
            report.unresponsive,
            Vec::<String>::new(),
            "user-closed={user_closed_id} drained={drained_id} report={report:?}"
        );
        collecting.abort();

        let exits = exits.lock().unwrap();
        let stamp = |session_id: &str| {
            exits
                .iter()
                .find(|event| event["sessionId"] == session_id)
                .map(|event| {
                    (
                        event["requestedTermination"].clone(),
                        event["exitOutcome"].clone(),
                    )
                })
                .unwrap_or_else(|| panic!("no exit event for {session_id}: {exits:?}"))
        };

        assert_eq!(
            stamp(&user_closed_id),
            (json!("user"), json!("user-terminated")),
            "a session already terminating must keep the source that asked first"
        );
        assert_eq!(
            stamp(&drained_id),
            (json!("service-shutdown"), json!("service-terminated")),
            "a session the drain ended must say so"
        );
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
                config_revision: "test-revision".to_owned(),
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

    /// A client that negotiated an older minor never hears about a birth: the
    /// event did not exist when its expectations were fixed.
    #[test]
    fn creation_events_reach_only_clients_that_negotiated_them() {
        let created = json!({ "type": "session-created" });
        assert!(!client_accepts_event(
            &created,
            SESSION_CREATED_PROTOCOL_MINOR - 1
        ));
        assert!(client_accepts_event(
            &created,
            SESSION_CREATED_PROTOCOL_MINOR
        ));
    }

    #[test]
    fn config_events_reach_only_clients_that_negotiated_them() {
        let changed = json!({ "type": "config-changed" });
        assert!(!client_accepts_event(
            &changed,
            CONFIG_EVENT_PROTOCOL_MINOR - 1
        ));
        assert!(client_accepts_event(&changed, CONFIG_EVENT_PROTOCOL_MINOR));
    }

    /// The pushed birth reuses the create response's `session` key, so one
    /// event name keeps one shape; `requestId: 0` is what marks it as pushed.
    #[test]
    fn creation_events_carry_the_summary_under_the_response_key() {
        let (event_tx, mut events) = broadcast::channel(4);
        let summary = session::SessionSummary {
            id: "session".to_owned(),
            handle: "7".to_owned(),
            executable: "/bin/zsh".to_owned(),
            cols: 80,
            rows: 24,
            exited: false,
            read_write: true,
            title: None,
            cwd: None,
            bell_count: 0,
            pid: Some(1),
            created_at_ms: 1,
            exit_code: None,
            exit_signal: None,
            requested_termination: None,
            exit_outcome: None,
            owner_id: None,
            persistence: Some(session::Persistence::KeepUntilExit),
            activity: session::SessionActivity::default(),
        };

        announce_session_created(&event_tx, &summary);

        let event = events.try_recv().unwrap();
        assert_eq!(event["type"], "session-created");
        assert_eq!(event["requestId"], 0);
        assert_eq!(event["session"]["id"], "session");
        assert_eq!(event["session"]["persistence"], "keep-until-exit");
    }

    #[test]
    fn deserializes_session_reclassification() {
        let envelope: Envelope = serde_json::from_value(json!({
            "requestId": 23,
            "type": "set-persistence",
            "sessionId": "session",
            "persistence": "keep-until-explicit-close",
        }))
        .unwrap();
        match envelope.command {
            Command::SetPersistence {
                session_id,
                persistence,
            } => {
                assert_eq!(session_id, "session");
                assert_eq!(persistence, session::Persistence::KeepUntilExplicitClose);
            }
            _ => panic!("expected set-persistence command"),
        }
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
