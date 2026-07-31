use std::{
    collections::HashMap,
    net::IpAddr,
    sync::{
        Arc, Mutex as SyncMutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

#[cfg(test)]
use std::env;

use anyhow::{Context, Result, bail};
use async_trait::async_trait;
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::sync::broadcast;
use tokio::time::MissedTickBehavior;
use truffle_core as truffle;
use truffle_core::{
    Node, StoreEvent, network::tailscale::TailscaleProvider, session::PeerEvent,
    transport::quic::QuicStream,
};
use uuid::Uuid;

use ghosttea::{
    MeshReconnectConfig, RemoteActivityChanged, RemoteAttachment, RemoteControlChanged,
    RemoteControlClaim, RemoteEndedReason, RemoteHostSummary, RemoteLifecycleChanged,
    RemoteLifecycleState, RemoteReplica, RemoteResize, RemoteSelection, RemoteSessionLifecycle,
    RemoteSessionOpen, RemoteTerminalRuntime, RemoteViewRecord, RemoteViewState,
    RemoteViewStateChanged, Session, SessionRegistry as Registry, SessionSummary, TerminalMesh,
    TerminalPresentationConfig, ViewAccess,
    tunnel_protocol::{
        CompactChannel, ConnectionMessage, LogicalTerminalPatch, LogicalTerminalSnapshot,
        MAX_CONTROL_MESSAGE_BYTES, MAX_STATE_MESSAGE_BYTES, PROTOCOL_MAJOR, PROTOCOL_MINOR,
        RowReplacement, SESSION_ACTIVITY_PROTOCOL_MINOR, SessionControlMessage,
        SharedSessionSummary, StateCodec, StateMessage, StreamKind, StreamPreface,
        TERMINAL_PRESENTATION_PROTOCOL_MINOR, TerminalHostAdvertisement, TunnelInput,
        decode_compact_message, decode_message, decode_preface, decode_state_message,
        encode_compact_message, encode_message, encode_preface, encode_state_message,
    },
};

pub const DEFAULT_QUIC_PORT: u16 = 9420;
pub const DEFAULT_COMPACT_PORT: u16 = 9421;
const ADVERTISEMENT_INTERVAL: Duration = Duration::from_secs(5);
const ADVERTISEMENT_TTL: Duration = Duration::from_secs(15);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(20);
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);

type HostStore = truffle::synced_store::SyncedStore<TerminalHostAdvertisement>;
type HostConfigReceiver = tokio::sync::watch::Receiver<Arc<TerminalPresentationConfig>>;

#[derive(Clone)]
struct IncomingSessionContext {
    registry: Registry,
    config: TruffleTerminalConfig,
    client_id: String,
    state_codec: StateCodec,
    protocol_minor: u16,
    host_config: HostConfigReceiver,
}

/// Samples a delay from a backoff window. Injectable so scheduling tests can
/// assert exact delays instead of sampling a distribution.
type JitterSource = Arc<dyn Fn(Duration) -> Duration + Send + Sync>;

fn uniform_jitter() -> JitterSource {
    Arc::new(|window| Duration::from_millis(rand::random_range(0..=window.as_millis() as u64)))
}

type RemoteViews = Arc<tokio::sync::Mutex<HashMap<(String, String), Arc<RemoteView>>>>;
type RemoteConnections = Arc<tokio::sync::Mutex<HashMap<String, Arc<RemoteHostConnection>>>>;

/// Local view ids that still fit a rotated wire id under the host's 128-byte
/// cap once the namespace prefix and the widest generation suffix are added.
const MAX_INLINE_LOCAL_VIEW_ID_BYTES: usize = 98;

static NEXT_CONNECTION_INCARNATION: AtomicU64 = AtomicU64::new(1);

#[derive(Clone)]
pub struct MeshRuntime {
    ready: Arc<tokio::sync::RwLock<Option<MeshReady>>>,
    transport: Arc<tokio::sync::RwLock<Option<Arc<dyn HostTransport>>>>,
    replicas: Arc<tokio::sync::RwLock<HashMap<String, RemoteSession>>>,
    views: RemoteViews,
    connections: RemoteConnections,
    control_tx: broadcast::Sender<RemoteControlChanged>,
    activity_tx: broadcast::Sender<RemoteActivityChanged>,
    lifecycle_tx: broadcast::Sender<RemoteLifecycleChanged>,
    view_state_tx: broadcast::Sender<RemoteViewStateChanged>,
    config: Arc<SyncMutex<MeshReconnectConfig>>,
    jitter: Arc<SyncMutex<JitterSource>>,
    /// Fires when a device looks reachable again, so a session waiting out its
    /// backoff can dial immediately instead of sleeping through the recovery.
    wakeup_tx: broadcast::Sender<String>,
}

impl Default for MeshRuntime {
    fn default() -> Self {
        let (control_tx, _) = broadcast::channel(64);
        let (activity_tx, _) = broadcast::channel(64);
        let (lifecycle_tx, _) = broadcast::channel(64);
        let (view_state_tx, _) = broadcast::channel(64);
        Self {
            ready: Arc::default(),
            transport: Arc::default(),
            replicas: Arc::default(),
            views: Arc::default(),
            connections: Arc::default(),
            control_tx,
            activity_tx,
            lifecycle_tx,
            view_state_tx,
            config: Arc::new(SyncMutex::new(MeshReconnectConfig::default())),
            jitter: Arc::new(SyncMutex::new(uniform_jitter())),
            wakeup_tx: broadcast::channel(64).0,
        }
    }
}

#[derive(Clone)]
struct MeshReady {
    node: Arc<Node<TailscaleProvider>>,
    store: Arc<HostStore>,
    host_instance_id: String,
    capability: Option<String>,
}

/// How long a hello's device id may take to appear in discovery before the
/// host gives up on it. A peer that has just re-joined is briefly absent.
const PEER_RESOLVE_WAIT_MS: u64 = 3_000;

/// Resolves the device identity a client asserts in its hello into the
/// `client_id` that owns its view attachments.
#[async_trait]
trait ClientResolver: Send + Sync {
    async fn resolve(&self, device_id: &str, remote_ip: Option<IpAddr>) -> Result<String>;
}

struct NodeClientResolver {
    node: Arc<Node<TailscaleProvider>>,
}

#[async_trait]
impl ClientResolver for NodeClientResolver {
    /// Identity comes from the hello, corroborated by discovery.
    ///
    /// The source address cannot carry it: an inbound QUIC connection arrives
    /// from whatever path the tailnet chose, which stops matching the address
    /// discovery recorded as soon as a node re-joins or a path rotates — and a
    /// host that matched on the address then rejected every legitimate client
    /// (the observed failure).
    ///
    /// AUTHORIZATION CAVEAT: with the address no longer binding a connection to
    /// a device, one peer inside the tailnet can assert another's device id and
    /// inherit its `client_id`, which owns view attachments and epochs — and,
    /// under `allow_tailnet_write` or a shared capability, its input. The
    /// tailnet remains the outer gate (authenticated, same-app, ALPN-scoped),
    /// so this is impersonation within an already-trusted set rather than open
    /// access. Closing it properly needs a transport-level identity for QUIC
    /// connections, the way the compact path already gets one from WhoIs; that
    /// is tracked for the next protocol phase.
    async fn resolve(&self, device_id: &str, remote_ip: Option<IpAddr>) -> Result<String> {
        if device_id.trim().is_empty() {
            bail!("client hello carries no device id");
        }
        let peer = self
            .node
            .peer(device_id, Some(PEER_RESOLVE_WAIT_MS))
            .await
            .context("resolve the client's asserted device id")?
            .context("client hello asserts a device that is not a current Truffle peer")?;
        if peer.device_id.as_deref() != Some(device_id) {
            bail!("client hello device id did not resolve to itself");
        }
        if !peer.online {
            bail!("client hello asserts a device that discovery reports offline");
        }
        if let Some(remote_ip) = remote_ip
            && peer.ip != remote_ip
        {
            // Expected whenever discovery's address is stale; the identity
            // above is what the decision rests on.
            eprintln!(
                "[terminal-mesh][diag] client {device_id} connected from {remote_ip} but discovery records {} ({}); accepted on asserted identity",
                peer.ip, peer.connection_type
            );
        }
        Ok(format!("truffle:{}", peer.peer_ref))
    }
}

/// Everything the viewer needs from discovery to reach one host. Isolating it
/// from `Node` keeps the session state machine drivable without a tailnet.
#[async_trait]
trait HostTransport: Send + Sync {
    fn capability(&self) -> Option<String>;
    async fn device_name(&self, device_id: &str) -> Option<String>;
    /// Whether discovery currently sees the device. Only ever used to decline
    /// a dial, never to tear a working connection down.
    async fn peer_is_online(&self, device_id: &str) -> bool;
    /// The advertised host identity, revalidated for freshness. Doubles as the
    /// pre-dial host-restart fence.
    async fn host_instance_id(&self, device_id: &str) -> Result<String>;
    async fn dial(&self, device_id: &str) -> Result<Arc<RemoteHostConnection>>;
}

#[derive(Clone)]
struct RemoteSession {
    device_id: String,
    remote_session_id: String,
    access_token: Option<String>,
    replica: Arc<RemoteReplica>,
    lifecycle: Arc<SessionLifecycle>,
}

struct RemoteView {
    session_control: tokio::sync::Mutex<ProtocolStream>,
    control: tokio::sync::watch::Receiver<Option<RemoteControlClaim>>,
    state_cancel: tokio::sync::watch::Sender<bool>,
    attachment_epoch: u64,
    read_write: bool,
    /// The host only ever sees `wire_view_id`; every mesh API speaks the local
    /// id. Rotation depends on the two never being conflated.
    wire_view_id: String,
    state_generation: u64,
    incarnation: u64,
    /// Whether this view's stream feeds the shared replica. Secondary streams
    /// are drained and discarded: two feeds would interleave per-stream patch
    /// sequences into one replica.
    feed: bool,
}

struct RemoteHostConnection {
    connection: Arc<dyn MeshConnection>,
    control: tokio::sync::Mutex<ProtocolStream>,
    incoming: tokio::sync::Mutex<()>,
    host_instance_id: String,
    state_codec: StateCodec,
    healthy: AtomicBool,
    incarnation: u64,
}

fn connection_is_reusable(
    cached_host_instance_id: &str,
    healthy: bool,
    advertised_host_instance_id: &str,
) -> bool {
    healthy && cached_host_instance_id == advertised_host_instance_id
}

/// The wire identity for one attach attempt. The host caps view ids at 128
/// bytes, so long local ids are hashed rather than truncated. The `r:`/`h:`
/// prefixes keep the two namespaces disjoint: without them a short local id
/// equal to another id's hash would produce the same base.
fn wire_view_id(local_view_id: &str, generation: u64) -> String {
    if local_view_id.len() <= MAX_INLINE_LOCAL_VIEW_ID_BYTES {
        format!("r:{local_view_id}#g{generation}")
    } else {
        let digest = Sha256::digest(local_view_id.as_bytes());
        let mut hashed = String::with_capacity(32);
        for byte in &digest[..16] {
            hashed.push_str(&format!("{byte:02x}"));
        }
        format!("h:{hashed}#g{generation}")
    }
}

/// Best-effort inverse of [`wire_view_id`], used only for controller ids the
/// session does not own: a peer's rotated id carries no local meaning, and
/// leaving the rotation visible would make it compare unequal to itself.
fn local_view_id_from_wire(wire_view_id: &str) -> Option<String> {
    let base = wire_view_id.rsplit_once("#g")?.0;
    base.strip_prefix("r:").map(str::to_owned)
}

#[derive(Clone)]
struct ViewRecord {
    view_state_seq: u64,
    state: RemoteViewState,
    attachment_epoch: Option<u64>,
    read_write: Option<bool>,
    error: Option<String>,
    retryable: Option<bool>,
    /// Monotonic per wire-view lineage. Advanced by every `AttachView` this
    /// viewer actually writes, initial retries included, so the host never
    /// sees a reused identity and can never mint the same epoch twice.
    generation: u64,
    wire_view_id: Option<String>,
    /// The contiguous purge range is `[oldest_unpurged, written]`: generations
    /// are consecutive integers, so two of them describe every identity this
    /// lineage stranded, however long the outage ran.
    oldest_unpurged: u64,
    /// The newest generation whose `AttachView` actually reached the wire. An
    /// attempt that never got written stranded nothing to purge.
    written: u64,
}

impl ViewRecord {
    fn pending() -> Self {
        Self {
            view_state_seq: 0,
            state: RemoteViewState::Pending,
            attachment_epoch: None,
            read_write: None,
            error: None,
            retryable: None,
            generation: 0,
            wire_view_id: None,
            oldest_unpurged: 1,
            written: 0,
        }
    }

    fn record(&self, local_view_id: &str) -> RemoteViewRecord {
        RemoteViewRecord {
            local_view_id: local_view_id.to_owned(),
            view_state_seq: self.view_state_seq,
            view_state: self.state,
            attachment_epoch: self.attachment_epoch,
            read_write: self.read_write,
            error: self.error.clone(),
            retryable: self.retryable,
        }
    }
}

struct LifecycleState {
    state: RemoteLifecycleState,
    reason: Option<RemoteEndedReason>,
    lifecycle_seq: u64,
    attempt: u32,
    /// Current state generation. Every state-channel dispatch is dropped
    /// unless the publishing reader carries this value.
    generation: u64,
    /// The connection incarnation the current attachments belong to.
    incarnation: u64,
    last_contact: Option<Instant>,
    host_instance_id: Option<String>,
    session_epoch: Option<u64>,
    views: HashMap<String, ViewRecord>,
    /// The one view whose state stream feeds the shared replica. Every view
    /// publishing into it would interleave independent patch sequences.
    feed_view_id: Option<String>,
    /// How long until the engine's next dial, while one is scheduled.
    next_retry: Option<Duration>,
}

/// The serialized owner of one open remote session's lifecycle. Every
/// transition, including those driven by a dying reader, commits through here
/// so a superseded connection can never speak for the current one.
struct SessionLifecycle {
    session_id: String,
    device_id: String,
    device_name: String,
    state: SyncMutex<LifecycleState>,
    /// Serializes attach and resume work; one attempt per session at a time.
    attempts: tokio::sync::Mutex<()>,
    /// The auto-resume engine, if one is armed for this session.
    engine: SyncMutex<Option<tokio::task::JoinHandle<()>>>,
    lifecycle_tx: broadcast::Sender<RemoteLifecycleChanged>,
    view_state_tx: broadcast::Sender<RemoteViewStateChanged>,
}

impl SessionLifecycle {
    fn new(
        session_id: String,
        device_id: String,
        device_name: String,
        host_instance_id: Option<String>,
        lifecycle_tx: broadcast::Sender<RemoteLifecycleChanged>,
        view_state_tx: broadcast::Sender<RemoteViewStateChanged>,
    ) -> Arc<Self> {
        let owner = Arc::new(Self {
            session_id,
            device_id,
            device_name,
            state: SyncMutex::new(LifecycleState {
                state: RemoteLifecycleState::Opening,
                reason: None,
                lifecycle_seq: 1,
                attempt: 0,
                generation: 1,
                incarnation: 0,
                last_contact: None,
                host_instance_id,
                session_epoch: None,
                views: HashMap::new(),
                feed_view_id: None,
                next_retry: None,
            }),
            attempts: tokio::sync::Mutex::new(()),
            engine: SyncMutex::new(None),
            lifecycle_tx,
            view_state_tx,
        });
        owner.publish(&owner.state.lock().unwrap());
        owner
    }

    fn publish(&self, state: &LifecycleState) {
        let _ = self.lifecycle_tx.send(RemoteLifecycleChanged {
            session_id: self.session_id.clone(),
            lifecycle_seq: state.lifecycle_seq,
            device_id: self.device_id.clone(),
            device_name: self.device_name.clone(),
            state: state.state,
            reason: state.reason,
            // Phase 1 has no wire message carrying exit metadata.
            exit: None,
            attempt: state.attempt,
            next_retry_ms: state.next_retry.map(|delay| delay.as_millis() as u64),
            last_contact_ms: state
                .last_contact
                .map(|at| at.elapsed().as_millis().min(u128::from(u64::MAX)) as u64),
        });
    }

    fn advance(
        &self,
        state: &mut LifecycleState,
        next: RemoteLifecycleState,
        reason: Option<RemoteEndedReason>,
    ) {
        state.state = next;
        state.reason = reason;
        state.lifecycle_seq = state.lifecycle_seq.saturating_add(1);
        self.publish(state);
    }

    fn publish_view(&self, local_view_id: &str, record: &ViewRecord) {
        let _ = self.view_state_tx.send(RemoteViewStateChanged {
            session_id: self.session_id.clone(),
            local_view_id: local_view_id.to_owned(),
            view_state_seq: record.view_state_seq,
            view_state: record.state,
            attachment_epoch: record.attachment_epoch,
            read_write: record.read_write,
            error: record.error.clone(),
            retryable: record.retryable,
        });
    }

    fn set_view(
        &self,
        state: &mut LifecycleState,
        local_view_id: &str,
        mutate: impl FnOnce(&mut ViewRecord),
    ) {
        let record = state
            .views
            .entry(local_view_id.to_owned())
            .or_insert_with(ViewRecord::pending);
        mutate(record);
        record.view_state_seq = record.view_state_seq.saturating_add(1);
        let published = record.clone();
        self.publish_view(local_view_id, &published);
    }

    /// Gate one state-channel dispatch and refresh contact in the same
    /// critical section. Checking currency and then refreshing separately
    /// would let a superseded connection vouch for the current one.
    fn admit_state(&self, generation: u64) -> bool {
        let mut state = self.state.lock().unwrap();
        if state.generation != generation {
            return false;
        }
        state.last_contact = Some(Instant::now());
        true
    }

    fn snapshot(&self) -> RemoteSessionLifecycle {
        let state = self.state.lock().unwrap();
        let mut views = state
            .views
            .iter()
            .map(|(local_view_id, record)| record.record(local_view_id))
            .collect::<Vec<_>>();
        views.sort_by(|left, right| left.local_view_id.cmp(&right.local_view_id));
        RemoteSessionLifecycle {
            session_id: self.session_id.clone(),
            lifecycle_seq: state.lifecycle_seq,
            device_id: self.device_id.clone(),
            device_name: self.device_name.clone(),
            state: state.state,
            reason: state.reason,
            exit: None,
            attempt: state.attempt,
            next_retry_ms: state.next_retry.map(|delay| delay.as_millis() as u64),
            last_contact_ms: state
                .last_contact
                .map(|at| at.elapsed().as_millis().min(u128::from(u64::MAX)) as u64),
            views,
        }
    }

    fn current_attachment(&self, local_view_id: &str) -> Option<(u64, bool)> {
        let state = self.state.lock().unwrap();
        let record = state.views.get(local_view_id)?;
        if record.state != RemoteViewState::Attached {
            return None;
        }
        Some((record.attachment_epoch?, record.read_write?))
    }

    fn is_ended(&self) -> bool {
        self.state.lock().unwrap().state == RemoteLifecycleState::Ended
    }

    fn state_kind(&self) -> RemoteLifecycleState {
        self.state.lock().unwrap().state
    }

    fn generation(&self) -> u64 {
        self.state.lock().unwrap().generation
    }

    fn recorded_host_instance_id(&self) -> Option<String> {
        self.state.lock().unwrap().host_instance_id.clone()
    }

    /// Translate a controller identity from the wire back to a local view id.
    /// Identities this session does not own carry no local meaning; their
    /// rotation is stripped so they at least compare stably with themselves.
    fn local_view_id_for(&self, wire_view_id: &str) -> String {
        let owned = {
            let state = self.state.lock().unwrap();
            state
                .views
                .iter()
                .find(|(_, record)| record.wire_view_id.as_deref() == Some(wire_view_id))
                .map(|(local_view_id, _)| local_view_id.clone())
        };
        owned
            .or_else(|| local_view_id_from_wire(wire_view_id))
            .unwrap_or_else(|| wire_view_id.to_owned())
    }

    fn local_view_ids(&self) -> Vec<String> {
        let mut ids = self
            .state
            .lock()
            .unwrap()
            .views
            .keys()
            .cloned()
            .collect::<Vec<_>>();
        ids.sort();
        ids
    }

    /// Arm the auto-resume engine, replacing any engine already running. A
    /// session has at most one: overlapping engines would each burn dials on
    /// their own schedule and race each other's attempts.
    fn arm_engine(&self, engine: tokio::task::JoinHandle<()>) {
        if let Some(previous) = self.engine.lock().unwrap().replace(engine) {
            previous.abort();
        }
    }

    /// Stop dialing. Local close, a manual retry taking over, and any terminal
    /// state all end the engine; aborting drops whatever dial is in flight.
    fn cancel_engine(&self) {
        if let Some(engine) = self.engine.lock().unwrap().take() {
            engine.abort();
        }
    }

    fn has_engine(&self) -> bool {
        self.engine.lock().unwrap().is_some()
    }

    fn set_next_retry(&self, delay: Option<Duration>) {
        self.state.lock().unwrap().next_retry = delay;
    }

    /// The identities this session stranded, per view lineage: every written
    /// generation below the one currently attached.
    fn purgeable_generations(&self) -> Vec<(String, u64, u64)> {
        self.state
            .lock()
            .unwrap()
            .views
            .iter()
            .filter_map(|(local_view_id, record)| {
                let last = record.written.min(record.generation.saturating_sub(1));
                (record.oldest_unpurged <= last)
                    .then(|| (local_view_id.clone(), record.oldest_unpurged, last))
            })
            .collect()
    }

    fn note_view_written(&self, local_view_id: &str, generation: u64) {
        if let Some(record) = self.state.lock().unwrap().views.get_mut(local_view_id) {
            record.written = record.written.max(generation);
        }
    }

    fn note_purged(&self, local_view_id: &str, generation: u64) {
        if let Some(record) = self.state.lock().unwrap().views.get_mut(local_view_id) {
            record.oldest_unpurged = record.oldest_unpurged.max(generation.saturating_add(1));
        }
    }

    fn feed_view_id(&self) -> Option<String> {
        self.state.lock().unwrap().feed_view_id.clone()
    }

    /// Elect the replica's feed. Election happens only at generation
    /// activation and picks the lexicographically smallest recorded view, so
    /// both ends of a resume agree on which stream owns session state without
    /// coordinating. It is sticky: a smaller id mounted later never re-elects.
    fn elect_feed(&self) -> Option<String> {
        let mut state = self.state.lock().unwrap();
        let elected = state.views.keys().min().cloned();
        state.feed_view_id.clone_from(&elected);
        elected
    }

    /// Give up the feed designation if `local_view_id` held it, reporting
    /// whether a promotion is now owed.
    fn release_feed(&self, local_view_id: &str) -> bool {
        let mut state = self.state.lock().unwrap();
        if state.feed_view_id.as_deref() != Some(local_view_id) {
            return false;
        }
        state.feed_view_id = None;
        !state.views.is_empty()
    }

    fn mark_views_pending(&self) {
        let mut state = self.state.lock().unwrap();
        let view_ids = state.views.keys().cloned().collect::<Vec<_>>();
        for local_view_id in view_ids {
            self.set_view(&mut state, &local_view_id, |record| {
                record.state = RemoteViewState::Pending;
                record.attachment_epoch = None;
                record.read_write = None;
            });
        }
    }

    /// Retire the current generation. Activation is early and Live is late
    /// (§4.2.2): once this returns, every in-flight reader is stale and its
    /// late publishes drop, before any replacement reads a byte.
    fn advance_generation(&self) -> u64 {
        let mut state = self.state.lock().unwrap();
        state.generation = state.generation.saturating_add(1);
        state.generation
    }

    fn bind_connection(&self, incarnation: u64) {
        self.state.lock().unwrap().incarnation = incarnation;
    }

    /// Register a view so it is visible to feed election and to resume,
    /// without yet claiming an attach attempt.
    fn record_view(&self, local_view_id: &str) {
        self.state
            .lock()
            .unwrap()
            .views
            .entry(local_view_id.to_owned())
            .or_insert_with(ViewRecord::pending);
    }

    /// Rotate one view's wire identity for an attach attempt that is about to
    /// be written.
    fn begin_view_attempt(&self, local_view_id: &str) -> (String, u64) {
        let mut state = self.state.lock().unwrap();
        let mut wire = String::new();
        let mut generation = 0;
        self.set_view(&mut state, local_view_id, |record| {
            record.generation = record.generation.saturating_add(1);
            generation = record.generation;
            wire = wire_view_id(local_view_id, record.generation);
            record.wire_view_id = Some(wire.clone());
            record.state = RemoteViewState::Pending;
            record.attachment_epoch = None;
            record.read_write = None;
            record.error = None;
            record.retryable = None;
        });
        (wire, generation)
    }

    fn commit_view_attached(&self, local_view_id: &str, attachment_epoch: u64, read_write: bool) {
        let mut state = self.state.lock().unwrap();
        self.set_view(&mut state, local_view_id, |record| {
            record.state = RemoteViewState::Attached;
            record.attachment_epoch = Some(attachment_epoch);
            record.read_write = Some(read_write);
            record.error = None;
            record.retryable = None;
        });
    }

    fn commit_view_failed(&self, local_view_id: &str, error: String, retryable: bool) {
        let mut state = self.state.lock().unwrap();
        self.set_view(&mut state, local_view_id, |record| {
            record.state = RemoteViewState::Failed;
            record.attachment_epoch = None;
            record.read_write = None;
            record.error = Some(error);
            record.retryable = Some(retryable);
        });
    }

    fn commit_view_pending(&self, local_view_id: &str) {
        let mut state = self.state.lock().unwrap();
        if state
            .views
            .get(local_view_id)
            .is_some_and(|record| record.state == RemoteViewState::Pending)
        {
            return;
        }
        self.set_view(&mut state, local_view_id, |record| {
            record.state = RemoteViewState::Pending;
            record.attachment_epoch = None;
            record.read_write = None;
        });
    }

    fn forget_view(&self, local_view_id: &str) {
        self.state.lock().unwrap().views.remove(local_view_id);
    }

    fn record_identity(&self, host_instance_id: &str, session_epoch: u64) {
        let mut state = self.state.lock().unwrap();
        if state.host_instance_id.is_none() {
            state.host_instance_id = Some(host_instance_id.to_owned());
        }
        if state.session_epoch.is_none() {
            state.session_epoch = Some(session_epoch);
        }
    }

    /// Whether a resumed attach landed on the same host world we first
    /// attached to. A mismatch is definitive evidence of a host restart.
    fn identity_matches(&self, host_instance_id: &str, session_epoch: u64) -> bool {
        let state = self.state.lock().unwrap();
        state
            .host_instance_id
            .as_ref()
            .is_none_or(|recorded| recorded == host_instance_id)
            && state
                .session_epoch
                .is_none_or(|recorded| recorded == session_epoch)
    }

    fn commit_synchronizing(&self) {
        let mut state = self.state.lock().unwrap();
        if state.state == RemoteLifecycleState::Ended {
            return;
        }
        self.advance(&mut state, RemoteLifecycleState::Synchronizing, None);
    }

    fn commit_live(&self) {
        let mut state = self.state.lock().unwrap();
        if state.state == RemoteLifecycleState::Ended {
            return;
        }
        state.last_contact = Some(Instant::now());
        state.attempt = 0;
        state.next_retry = None;
        self.advance(&mut state, RemoteLifecycleState::Live, None);
    }

    fn commit_reconnecting(&self) {
        let mut state = self.state.lock().unwrap();
        state.attempt = state.attempt.saturating_add(1);
        self.advance(&mut state, RemoteLifecycleState::Reconnecting, None);
    }

    /// Announce the next scheduled dial, so a client can show an honest
    /// countdown instead of an indefinite spinner.
    fn commit_scheduled_retry(&self, attempt: u32, delay: Duration) {
        let mut state = self.state.lock().unwrap();
        if state.state == RemoteLifecycleState::Ended {
            return;
        }
        state.attempt = attempt;
        state.next_retry = Some(delay);
        self.advance(&mut state, RemoteLifecycleState::Reconnecting, None);
    }

    fn commit_suspended(&self) {
        let mut state = self.state.lock().unwrap();
        if matches!(
            state.state,
            RemoteLifecycleState::Ended | RemoteLifecycleState::Suspended
        ) {
            return;
        }
        state.next_retry = None;
        self.advance(&mut state, RemoteLifecycleState::Suspended, None);
    }

    fn commit_ended(&self, reason: RemoteEndedReason) {
        self.cancel_engine();
        let mut state = self.state.lock().unwrap();
        if state.state == RemoteLifecycleState::Ended {
            return;
        }
        state.next_retry = None;
        let view_ids = state.views.keys().cloned().collect::<Vec<_>>();
        for local_view_id in view_ids {
            self.set_view(&mut state, &local_view_id, |record| {
                record.state = RemoteViewState::Pending;
                record.attachment_epoch = None;
                record.read_write = None;
            });
        }
        self.advance(&mut state, RemoteLifecycleState::Ended, Some(reason));
    }

    /// Commit a liveness-driven teardown for one connection incarnation. The
    /// currency comparison happens here, under this lock, rather than at the
    /// caller: a task can verify currency, be descheduled while the connection
    /// is replaced, and resume holding a verdict for a connection that no
    /// longer exists.
    fn commit_disconnect(&self, generation: u64, incarnation: u64) -> bool {
        let mut state = self.state.lock().unwrap();
        if state.generation != generation || state.incarnation != incarnation {
            return false;
        }
        if matches!(
            state.state,
            RemoteLifecycleState::Ended | RemoteLifecycleState::Suspended
        ) {
            return false;
        }
        let view_ids = state.views.keys().cloned().collect::<Vec<_>>();
        for local_view_id in view_ids {
            self.set_view(&mut state, &local_view_id, |record| {
                record.state = RemoteViewState::Pending;
                record.attachment_epoch = None;
                record.read_write = None;
            });
        }
        // Hand off to the engine: Suspended is where a session comes to rest
        // after `suspend_after` of failed dials, not where it lands the moment
        // a connection drops.
        state.attempt = 0;
        state.next_retry = None;
        self.advance(&mut state, RemoteLifecycleState::Reconnecting, None);
        true
    }
}

struct AttachOutcome {
    attachment_epoch: u64,
    read_write: bool,
    /// Fires once the reader has applied a snapshot through the current
    /// generation. Resume reports Live only after this.
    synchronized: tokio::sync::watch::Receiver<bool>,
}

/// Separates "this attempt failed, try again" from "this session is over", so
/// a terminal verdict is never retried and a retryable error never ends a
/// session.
enum AttachFailure {
    Ended(RemoteEndedReason),
    Failed(anyhow::Error),
}

impl From<anyhow::Error> for AttachFailure {
    fn from(error: anyhow::Error) -> Self {
        Self::Failed(error)
    }
}

impl From<AttachFailure> for anyhow::Error {
    fn from(failure: AttachFailure) -> Self {
        match failure {
            AttachFailure::Ended(reason) => {
                anyhow::anyhow!("remote terminal session ended: {}", reason.as_str())
            }
            AttachFailure::Failed(error) => error,
        }
    }
}

/// The host sends `ViewAttached` before it opens the state stream, so attach
/// completion is not recovery. Resume waits here, bounded, for the snapshot.
async fn await_first_snapshot(
    mut synchronized: tokio::sync::watch::Receiver<bool>,
    bound: Duration,
) -> Result<()> {
    if *synchronized.borrow_and_update() {
        return Ok(());
    }
    tokio::time::timeout(bound, async {
        loop {
            synchronized
                .changed()
                .await
                .context("remote terminal state stream closed before its snapshot")?;
            if *synchronized.borrow_and_update() {
                return Ok(());
            }
        }
    })
    .await
    .context("timed out waiting for the remote terminal recovery snapshot")?
}

async fn list_sessions_on(host: &RemoteHostConnection) -> Result<Vec<SharedSessionSummary>> {
    let mut control = host.control.lock().await;
    let request_id = Uuid::new_v4().to_string();
    control
        .write_message(
            &ConnectionMessage::ListSessions {
                request_id: request_id.clone(),
            },
            MAX_CONTROL_MESSAGE_BYTES,
        )
        .await?;
    match tokio::time::timeout(
        HANDSHAKE_TIMEOUT,
        control.read_message::<ConnectionMessage>(MAX_CONTROL_MESSAGE_BYTES),
    )
    .await
    .context("timed out waiting for remote terminal sessions")??
    .context("remote host closed before listing sessions")?
    {
        ConnectionMessage::Sessions {
            request_id: response_id,
            sessions,
        } if response_id == request_id => Ok(sessions),
        ConnectionMessage::Error { message, .. } => {
            bail!("remote host rejected request: {message}")
        }
        _ => bail!("remote host returned an invalid session list"),
    }
}

/// Full jitter, AWS definition: the window doubles per attempt up to the cap
/// and the delay is sampled uniformly inside it, so viewers that lost the same
/// host do not come back in lockstep and re-flood it.
fn backoff_delay(config: &MeshReconnectConfig, attempt: u32, jitter: &JitterSource) -> Duration {
    let window = config
        .backoff_base
        .saturating_mul(2_u32.saturating_pow(attempt.min(31)))
        .min(config.backoff_cap);
    jitter(window).min(window).max(config.backoff_floor)
}

/// Wait out a scheduled backoff, cut short if the device reappears.
async fn wait_for_retry(
    wakeups: &mut broadcast::Receiver<String>,
    device_id: &str,
    delay: Duration,
    fast_path: bool,
) {
    let deadline = tokio::time::sleep(delay);
    tokio::pin!(deadline);
    if !fast_path {
        deadline.await;
        return;
    }
    loop {
        tokio::select! {
            _ = &mut deadline => return,
            event = wakeups.recv() => match event {
                Ok(woken) if woken == device_id => return,
                Ok(_) => continue,
                Err(broadcast::error::RecvError::Lagged(_)) => continue,
                Err(broadcast::error::RecvError::Closed) => {
                    deadline.await;
                    return;
                }
            },
        }
    }
}

/// Park until the device looks reachable again. Suspended costs no network:
/// the engine holds here rather than dialing on a timer.
async fn wait_for_device(wakeups: &mut broadcast::Receiver<String>, device_id: &str) -> bool {
    loop {
        match wakeups.recv().await {
            Ok(woken) if woken == device_id => return true,
            Ok(_) => continue,
            Err(broadcast::error::RecvError::Lagged(_)) => continue,
            Err(broadcast::error::RecvError::Closed) => return false,
        }
    }
}

/// One auto-resume engine per open session: dial on a full-jitter schedule,
/// wake early when the device re-advertises, and come to rest in Suspended
/// once the host has been absent longer than `suspend_after` — still watching,
/// but no longer burning connects.
/// Boxed at the definition rather than the call site: the engine reaches
/// attach, and attach's reader task reaches back here to arm the engine — a
/// cycle the compiler cannot resolve through two opaque future types.
fn reconnect_engine(
    runtime: MeshRuntime,
    session_id: String,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>> {
    Box::pin(reconnect_engine_inner(runtime, session_id))
}

async fn reconnect_engine_inner(runtime: MeshRuntime, session_id: String) {
    let Ok(remote) = runtime.remote_session(&session_id).await else {
        return;
    };
    let lifecycle = Arc::clone(&remote.lifecycle);
    let config = runtime.config();
    let jitter = runtime.jitter();
    let mut wakeups = runtime.wakeup_tx.subscribe();
    let mut attempt = 0_u32;
    let mut absent_since = Instant::now();

    loop {
        match lifecycle.state_kind() {
            RemoteLifecycleState::Ended | RemoteLifecycleState::Live => return,
            _ => {}
        }
        if absent_since.elapsed() >= config.suspend_after {
            lifecycle.commit_suspended();
            if !wait_for_device(&mut wakeups, &remote.device_id).await {
                return;
            }
            attempt = 0;
            absent_since = Instant::now();
            continue;
        }

        attempt = attempt.saturating_add(1);
        let delay = backoff_delay(&config, attempt.saturating_sub(1), &jitter);
        lifecycle.commit_scheduled_retry(attempt, delay);
        wait_for_retry(
            &mut wakeups,
            &remote.device_id,
            delay,
            config.advertisement_fast_path,
        )
        .await;
        lifecycle.set_next_retry(None);
        if lifecycle.is_ended() {
            return;
        }
        if runtime.dial_is_pointless(&remote.device_id).await {
            continue;
        }
        match runtime.resume_attempt(&remote).await {
            Ok(()) => {
                if lifecycle.state_kind() == RemoteLifecycleState::Live {
                    return;
                }
            }
            Err(AttachFailure::Ended(reason)) => {
                lifecycle.commit_ended(reason);
                return;
            }
            Err(AttachFailure::Failed(error)) => {
                eprintln!("[terminal-mesh] resume attempt {attempt} failed: {error:#}");
            }
        }
    }
}

/// Best-effort acceleration, never correctness: each stranded attachment sits
/// on a connection this viewer abandoned, and the host reaps it once it
/// observes that connection died. Purging only returns the view slot, and any
/// controller it held, sooner than the transport's idle timeout would.
async fn purge_stranded_attachments(runtime: MeshRuntime, remote: RemoteSession) {
    let Some(host) = runtime.cached_connection(&remote.device_id).await else {
        return;
    };
    let summary = remote.replica.summary();
    for (local_view_id, from, to) in remote.lifecycle.purgeable_generations() {
        for generation in from..=to {
            let wire = wire_view_id(&local_view_id, generation);
            if purge_attachment(&host, &remote, &wire, summary.cols, summary.rows)
                .await
                .is_err()
            {
                // The connection is unusable for cleanup; the host's own
                // connection-death detach collects whatever is left.
                return;
            }
            remote.lifecycle.note_purged(&local_view_id, generation);
        }
    }
}

async fn purge_attachment(
    host: &RemoteHostConnection,
    remote: &RemoteSession,
    wire_view_id: &str,
    cols: u16,
    rows: u16,
) -> Result<()> {
    // The transient state stream the host opens on attach must be consumed
    // here: left in the connection-wide accept queue it would be handed to the
    // next real attach as a misrouted stream.
    let _incoming = host.incoming.lock().await;
    let mut control = ProtocolStream::new(host.connection.open_stream().await?);
    control
        .write_preface(&StreamPreface {
            stream_kind: StreamKind::SessionControl,
            session_id: Some(remote.remote_session_id.clone()),
            view_id: Some(wire_view_id.to_owned()),
        })
        .await?;
    let request_id = Uuid::new_v4().to_string();
    control
        .write_message(
            &SessionControlMessage::AttachView {
                request_id: request_id.clone(),
                session_id: remote.remote_session_id.clone(),
                view_id: wire_view_id.to_owned(),
                access_token: remote.access_token.clone(),
                cols,
                rows,
            },
            MAX_CONTROL_MESSAGE_BYTES,
        )
        .await?;
    let attachment_epoch = match tokio::time::timeout(
        HANDSHAKE_TIMEOUT,
        control.read_message::<SessionControlMessage>(MAX_CONTROL_MESSAGE_BYTES),
    )
    .await
    .context("timed out purging a stranded remote attachment")??
    .context("remote terminal closed before the purge attach")?
    {
        SessionControlMessage::ViewAttached {
            request_id: response_id,
            attachment_epoch,
            ..
        } if response_id == request_id => attachment_epoch,
        _ => bail!("remote terminal returned an invalid purge attach response"),
    };
    let state = tokio::time::timeout(HANDSHAKE_TIMEOUT, host.connection.accept_stream())
        .await
        .context("timed out draining a purged state stream")??
        .context("remote terminal closed before the purge state stream")?;
    drop(ProtocolStream::new(state));
    control
        .write_message(
            &SessionControlMessage::Detach {
                view_id: wire_view_id.to_owned(),
                attachment_epoch,
            },
            MAX_CONTROL_MESSAGE_BYTES,
        )
        .await
}

/// The Phase-1 end-reason evidence rules. A listing is the only evidence a 1.4
/// host can offer, and absence proves nothing beyond unavailability — so the
/// honest fallback is `session-unavailable`, never a guessed close or exit.
fn ended_reason_from_listing(entry: Option<&SharedSessionSummary>) -> Option<RemoteEndedReason> {
    match entry {
        None => Some(RemoteEndedReason::SessionUnavailable),
        Some(summary) if summary.attachable => None,
        Some(summary) if !summary.running => Some(RemoteEndedReason::SessionExited),
        Some(_) => Some(RemoteEndedReason::SessionClosed),
    }
}

/// Devices whose liveness a discovery signal calls into question. These are
/// probe triggers only: discovery is a hint, and tearing a working connection
/// down on an expired advertisement would be the bug this guards against.
fn peer_wakeup_candidate(event: &PeerEvent) -> Option<String> {
    match event {
        PeerEvent::Joined(peer) | PeerEvent::Identity(peer) => {
            peer.identity.as_ref().map(|id| id.device_id.clone())
        }
        PeerEvent::Updated(peer) if peer.online => {
            peer.identity.as_ref().map(|id| id.device_id.clone())
        }
        _ => None,
    }
}

fn peer_probe_candidate(event: &PeerEvent) -> Option<String> {
    match event {
        PeerEvent::Left(peer) => peer.identity.as_ref().map(|id| id.device_id.clone()),
        PeerEvent::Updated(peer) if !peer.online => {
            peer.identity.as_ref().map(|id| id.device_id.clone())
        }
        _ => None,
    }
}

/// A device that just republished is worth dialing immediately. Advertisements
/// refresh every 5 s, so this is what lands a resume within seconds of the
/// host returning rather than at the end of a backoff.
fn advertisement_wakeup_candidate(
    event: &StoreEvent<TerminalHostAdvertisement>,
    now: u64,
) -> Option<String> {
    match event {
        StoreEvent::PeerUpdated {
            device_id, data, ..
        } if data.expires_at_ms >= now => Some(device_id.clone()),
        _ => None,
    }
}

fn advertisement_probe_candidate(
    event: &StoreEvent<TerminalHostAdvertisement>,
    now: u64,
) -> Option<String> {
    match event {
        StoreEvent::PeerRemoved { device_id } => Some(device_id.clone()),
        StoreEvent::PeerUpdated {
            device_id, data, ..
        } if data.expires_at_ms < now => Some(device_id.clone()),
        _ => None,
    }
}

fn negotiate_state_codec(offered: Option<Vec<StateCodec>>) -> StateCodec {
    offered
        .unwrap_or_default()
        .into_iter()
        .find(|codec| *codec == StateCodec::CompactJsonV1)
        .unwrap_or(StateCodec::Json)
}

impl MeshRuntime {
    pub fn new() -> Self {
        Self::default()
    }

    pub async fn hosts(&self) -> Result<Vec<RemoteHostSummary>> {
        let ready = self.ready().await?;
        let local_device_id = ready.node.local_info().device_id;
        let peers = ready.node.peers().await;
        let peer_by_device: std::collections::HashMap<_, _> = peers
            .into_iter()
            .filter_map(|peer| peer.device_id.clone().map(|device_id| (device_id, peer)))
            .collect();
        let now = now_ms();
        let mut hosts = ready
            .store
            .all()
            .await
            .into_iter()
            .filter(|(device_id, slice)| {
                device_id != &local_device_id
                    && slice.data.expires_at_ms >= now
                    && slice.data.protocol_major == PROTOCOL_MAJOR
            })
            .map(|(device_id, slice)| {
                let peer = peer_by_device.get(&device_id);
                RemoteHostSummary {
                    device_name: peer
                        .map(|peer| peer.display_name.clone())
                        .unwrap_or_else(|| device_id.clone()),
                    online: peer.is_some_and(|peer| peer.online),
                    device_id,
                    protocol_major: slice.data.protocol_major,
                    protocol_minor: slice.data.protocol_minor,
                    host_instance_id: slice.data.host_instance_id,
                    sessions: slice.data.sessions,
                }
            })
            .collect::<Vec<_>>();
        hosts.sort_by(|left, right| {
            left.device_name
                .cmp(&right.device_name)
                .then(left.device_id.cmp(&right.device_id))
        });
        Ok(hosts)
    }

    pub async fn list_sessions(&self, device_id: &str) -> Result<Vec<SharedSessionSummary>> {
        let sessions = match self.list_sessions_once(device_id).await {
            Ok(sessions) => sessions,
            Err(first_error) => {
                self.invalidate_connection(device_id, None).await;
                self.list_sessions_once(device_id).await.with_context(|| {
                    format!("remote session listing failed after reconnect: {first_error:#}")
                })?
            }
        };
        self.reconcile_evidence(device_id, &sessions).await;
        Ok(sessions)
    }

    async fn list_sessions_once(&self, device_id: &str) -> Result<Vec<SharedSessionSummary>> {
        let remote = self.remote_connection(device_id).await?;
        match list_sessions_on(&remote).await {
            Ok(sessions) => Ok(sessions),
            Err(error) => {
                self.note_connection_failure(device_id, &remote).await;
                Err(error)
            }
        }
    }

    /// Apply §6.4 listing evidence to sessions that are already off the air.
    /// A live session is never ended from a listing: the host lists what it
    /// serves, and our own attachment is the better evidence.
    async fn reconcile_evidence(&self, device_id: &str, sessions: &[SharedSessionSummary]) {
        let candidates = self
            .replicas
            .read()
            .await
            .values()
            .filter(|remote| {
                remote.device_id == device_id
                    && remote.lifecycle.state_kind() == RemoteLifecycleState::Suspended
            })
            .map(|remote| {
                (
                    remote.remote_session_id.clone(),
                    Arc::clone(&remote.lifecycle),
                )
            })
            .collect::<Vec<_>>();
        for (remote_session_id, lifecycle) in candidates {
            let entry = sessions
                .iter()
                .find(|summary| summary.session_id == remote_session_id);
            if let Some(reason) = ended_reason_from_listing(entry) {
                lifecycle.commit_ended(reason);
            }
        }
    }

    pub async fn open_session(&self, request: RemoteSessionOpen) -> Result<SessionSummary> {
        let RemoteSessionOpen {
            device_id,
            remote_session_id,
            cols,
            rows,
            owner_id,
            frames,
            text_engine,
        } = request;
        let transport = self.transport().await?;
        // Advertised sessions are discovery hints and may lag registry
        // changes. Resolve the selected session against the host's live
        // registry before creating a local replica.
        let sessions = self.list_sessions(&device_id).await?;
        let remote = sessions
            .iter()
            .find(|session| session.session_id == remote_session_id && session.attachable)
            .context("remote terminal session is no longer attachable")?;
        let replica = RemoteReplica::new(
            remote.title.clone(),
            remote.cwd_label.clone(),
            cols,
            rows,
            owner_id,
            frames,
            text_engine,
        );
        replica.set_activity(remote.activity.clone());
        let summary = replica.summary();
        // The device name is captured here because lifecycle events must name
        // the host even once it is unreachable and absent from the peer list.
        let device_name = transport
            .device_name(&device_id)
            .await
            .unwrap_or_else(|| device_id.clone());
        let host_instance_id = self
            .connections
            .lock()
            .await
            .get(&device_id)
            .map(|connection| connection.host_instance_id.clone());
        let lifecycle = SessionLifecycle::new(
            summary.id.clone(),
            device_id.clone(),
            device_name,
            host_instance_id,
            self.lifecycle_tx.clone(),
            self.view_state_tx.clone(),
        );
        self.replicas.write().await.insert(
            summary.id.clone(),
            RemoteSession {
                device_id,
                remote_session_id,
                access_token: transport.capability(),
                replica,
                lifecycle,
            },
        );
        Ok(summary)
    }

    pub async fn summaries(&self) -> Vec<SessionSummary> {
        self.replicas
            .read()
            .await
            .values()
            .map(|session| session.replica.summary())
            .collect()
    }

    pub async fn summary(&self, session_id: &str) -> Option<SessionSummary> {
        self.replicas
            .read()
            .await
            .get(session_id)
            .map(|session| session.replica.summary())
    }

    pub async fn attach_view(&self, session_id: &str, view_id: &str) -> Result<RemoteAttachment> {
        let remote = self.remote_session(session_id).await?;
        let lifecycle = Arc::clone(&remote.lifecycle);
        let _attempt = lifecycle.attempts.lock().await;
        if lifecycle.is_ended() {
            bail!("remote terminal session has ended");
        }
        // A view that is not currently Live has to be re-established rather
        // than answered from cache: returning the cached attachment is what
        // let a dead epoch outlive the connection that minted it.
        let resuming = lifecycle.state_kind() != RemoteLifecycleState::Live;
        self.retire_view(session_id, view_id).await;
        if resuming && lifecycle.state_kind() != RemoteLifecycleState::Opening {
            lifecycle.advance_generation();
            lifecycle.commit_reconnecting();
        }
        // The first view to arrive owns the replica feed; later panes are
        // secondaries whose streams are drained.
        lifecycle.record_view(view_id);
        let feed = lifecycle.feed_view_id().unwrap_or_else(|| {
            lifecycle.elect_feed();
            lifecycle
                .feed_view_id()
                .unwrap_or_else(|| view_id.to_owned())
        });
        let is_feed = feed == view_id;

        let outcome = match self.attach_view_attempt(&remote, view_id, is_feed).await {
            Ok(outcome) => Ok(outcome),
            Err(AttachFailure::Ended(reason)) => {
                lifecycle.commit_ended(reason);
                bail!("remote terminal session ended: {}", reason.as_str());
            }
            // The initial dial can land on a connection the host has already
            // forgotten. Retrying is safe now only because the second attempt
            // rotates to a fresh wire identity.
            Err(AttachFailure::Failed(first_error)) => {
                self.invalidate_connection(&remote.device_id, None).await;
                match self.attach_view_attempt(&remote, view_id, is_feed).await {
                    Ok(outcome) => Ok(outcome),
                    Err(AttachFailure::Ended(reason)) => {
                        lifecycle.commit_ended(reason);
                        bail!("remote terminal session ended: {}", reason.as_str());
                    }
                    Err(AttachFailure::Failed(error)) => Err(anyhow::anyhow!(
                        "remote view attach failed after reconnect: {first_error:#}: {error:#}"
                    )),
                }
            }
        };

        let outcome = match outcome {
            Ok(outcome) => outcome,
            Err(error) => {
                lifecycle.commit_view_failed(view_id, format!("{error:#}"), true);
                if lifecycle.state_kind() == RemoteLifecycleState::Reconnecting {
                    lifecycle.commit_suspended();
                }
                return Err(error);
            }
        };

        lifecycle.commit_view_attached(view_id, outcome.attachment_epoch, outcome.read_write);
        // Live means the feed is attached *and* its snapshot has been applied
        // — an initial open included. Reporting live at ViewAttached would
        // hand the renderer an epoch, and the user an input-ready pane, before
        // the authoritative screen exists.
        if is_feed && resuming {
            lifecycle.commit_synchronizing();
            if let Err(error) =
                await_first_snapshot(outcome.synchronized, self.synchronize_bound()).await
            {
                return Err(self.abandon_attempt(&remote, error).await);
            }
        }
        if is_feed && lifecycle.state_kind() != RemoteLifecycleState::Live {
            lifecycle.commit_live();
        }
        remote.replica.set_read_write(outcome.read_write);
        Ok(RemoteAttachment {
            attachment_epoch: outcome.attachment_epoch,
            read_write: outcome.read_write,
        })
    }

    /// Abandon an attempt that never synchronized. Leaving its readers alive
    /// under the current generation would let them mutate a replica the user
    /// has already been told is frozen.
    async fn abandon_attempt(&self, remote: &RemoteSession, error: anyhow::Error) -> anyhow::Error {
        let session_id = remote.replica.summary().id;
        self.retire_session_views(&session_id).await;
        remote.lifecycle.advance_generation();
        remote.lifecycle.mark_views_pending();
        remote.lifecycle.commit_suspended();
        error
    }

    /// One `AttachView` write, its response, and the state stream it opens.
    /// Every attempt rotates the wire identity, so the host treats it as a
    /// brand-new view: fresh epoch, and no zombie cleanup can collide with it.
    async fn attach_view_attempt(
        &self,
        remote: &RemoteSession,
        local_view_id: &str,
        feed: bool,
    ) -> Result<AttachOutcome, AttachFailure> {
        let summary = remote.replica.summary();
        let host = self.remote_connection(&remote.device_id).await?;
        if !remote
            .lifecycle
            .recorded_host_instance_id()
            .is_none_or(|recorded| recorded == host.host_instance_id)
        {
            return Err(AttachFailure::Ended(RemoteEndedReason::HostRestarted));
        }
        // A connection carries multiple view streams, but their LiveState
        // streams arrive on one connection-wide accept queue. Serialize the
        // attach handshake so concurrent panes cannot consume each other's
        // state stream.
        let _incoming = host.incoming.lock().await;
        // Rotate immediately before the write, never earlier: a stalled
        // attempt must not carry an old generation onto a newer connection.
        let (wire_view_id, view_generation) = remote.lifecycle.begin_view_attempt(local_view_id);
        let state_generation = remote.lifecycle.generation();
        let connection = Arc::clone(&host.connection);
        let mut session_control = ProtocolStream::new(connection.open_stream().await?);
        session_control
            .write_preface(&StreamPreface {
                stream_kind: StreamKind::SessionControl,
                session_id: Some(remote.remote_session_id.clone()),
                view_id: Some(wire_view_id.clone()),
            })
            .await?;
        let request_id = Uuid::new_v4().to_string();
        session_control
            .write_message(
                &SessionControlMessage::AttachView {
                    request_id: request_id.clone(),
                    session_id: remote.remote_session_id.clone(),
                    view_id: wire_view_id.clone(),
                    access_token: remote.access_token.clone(),
                    cols: summary.cols,
                    rows: summary.rows,
                },
                MAX_CONTROL_MESSAGE_BYTES,
            )
            .await?;
        // Only a written attempt strands an identity worth purging later.
        remote
            .lifecycle
            .note_view_written(local_view_id, view_generation);
        let attach_response = tokio::time::timeout(
            HANDSHAKE_TIMEOUT,
            session_control.read_message::<SessionControlMessage>(MAX_CONTROL_MESSAGE_BYTES),
        )
        .await
        .context("timed out attaching remote terminal view")?
        .context("read remote terminal attach response")?
        .context("remote terminal closed before attaching view")?;
        let (attachment_epoch, read_write, session_epoch) = match attach_response {
            SessionControlMessage::ViewAttached {
                request_id: response_id,
                attachment_epoch,
                read_write,
                session_epoch,
                ..
            } if response_id == request_id => (attachment_epoch, read_write, session_epoch),
            _ => {
                return Err(AttachFailure::Failed(anyhow::anyhow!(
                    "remote terminal returned an invalid attach response"
                )));
            }
        };
        if !remote
            .lifecycle
            .identity_matches(&host.host_instance_id, session_epoch)
        {
            return Err(AttachFailure::Ended(RemoteEndedReason::HostRestarted));
        }
        remote
            .lifecycle
            .record_identity(&host.host_instance_id, session_epoch);
        // Bind before the reader exists, so the reader's eventual verdict has
        // an incarnation to be compared against.
        remote.lifecycle.bind_connection(host.incarnation);
        let state_stream = tokio::time::timeout(HANDSHAKE_TIMEOUT, connection.accept_stream())
            .await
            .context("timed out waiting for remote terminal state")??
            .context("remote terminal closed before opening state stream")?;
        let mut state = ProtocolStream::new(state_stream);
        let preface = tokio::time::timeout(HANDSHAKE_TIMEOUT, state.read_preface())
            .await
            .context("timed out reading remote state preface")?
            .context("read remote terminal state preface")?;
        if preface.stream_kind != StreamKind::LiveState
            || preface.session_id.as_deref() != Some(remote.remote_session_id.as_str())
            || preface.view_id.as_deref() != Some(wire_view_id.as_str())
        {
            return Err(AttachFailure::Failed(anyhow::anyhow!(
                "remote terminal returned a misrouted state stream"
            )));
        }
        let (control_sender, control) = tokio::sync::watch::channel(None);
        let (state_cancel, mut state_cancelled) = tokio::sync::watch::channel(false);
        let (synchronized_tx, synchronized) = tokio::sync::watch::channel(false);
        let view = Arc::new(RemoteView {
            session_control: tokio::sync::Mutex::new(session_control),
            control,
            state_cancel,
            attachment_epoch,
            read_write,
            wire_view_id,
            state_generation,
            incarnation: host.incarnation,
            feed,
        });
        let key = (remote.replica.summary().id, local_view_id.to_owned());
        let local_view_key = key.clone();
        self.views.lock().await.insert(key, Arc::clone(&view));
        let replica = Arc::clone(&remote.replica);
        let local_session_id = remote.replica.summary().id;
        let remote_device_id = remote.device_id.clone();
        let remote_view = Arc::clone(&view);
        let remote_host = Arc::clone(&host);
        let lifecycle = Arc::clone(&remote.lifecycle);
        let views = Arc::clone(&self.views);
        let connections = Arc::clone(&self.connections);
        let remote_control_tx = self.control_tx.clone();
        let remote_activity_tx = self.activity_tx.clone();
        let engine_runtime = self.clone();
        let incarnation = host.incarnation;
        tokio::spawn(async move {
            let mut connection_failed = true;
            loop {
                let message = tokio::select! {
                    changed = state_cancelled.changed() => {
                        if changed.is_err() || *state_cancelled.borrow() {
                            connection_failed = false;
                            break;
                        }
                        continue;
                    }
                    message = state.read_state_message(remote_host.state_codec) => message,
                };
                let message = match message {
                    Ok(Some(message)) => message,
                    Ok(None) => break,
                    Err(error) => {
                        eprintln!("[terminal-mesh] remote state stream closed: {error:#}");
                        break;
                    }
                };
                // The gate covers every state-channel dispatch, not just
                // replica publication: a superseded reader that only had its
                // frames gated could still move controller or activity state
                // after recovery, or refresh the current connection's contact
                // clock on its behalf.
                if !lifecycle.admit_state(state_generation) {
                    continue;
                }
                // Contact is refreshed above for any traffic on the current
                // incarnation, but only the feed publishes: a secondary's
                // stream is drained so its independent patch sequence can
                // never interleave with the feed's in the shared replica.
                if !remote_view.feed {
                    continue;
                }
                match message {
                    StateMessage::Snapshot(snapshot) => {
                        if let Err(error) = replica.publish(snapshot) {
                            eprintln!("[terminal-mesh] failed to render remote state: {error:#}");
                            break;
                        }
                        synchronized_tx.send_replace(true);
                    }
                    StateMessage::Patch(patch) => {
                        if let Err(error) = replica.publish_patch(patch) {
                            eprintln!(
                                "[terminal-mesh] failed to apply remote state patch: {error:#}"
                            );
                            break;
                        }
                    }
                    StateMessage::ControlChanged {
                        controller_view_id,
                        control_epoch,
                        cols,
                        rows,
                        layout_epoch,
                    } => {
                        // Controller identities arrive as wire ids; every mesh
                        // consumer above this point speaks local ids.
                        let controller_view_id = lifecycle.local_view_id_for(&controller_view_id);
                        let claim = RemoteControlClaim {
                            controller_view_id: controller_view_id.clone(),
                            control_epoch,
                            cols,
                            rows,
                            layout_epoch,
                        };
                        control_sender.send_replace(Some(claim));
                        let _ = remote_control_tx.send(RemoteControlChanged {
                            session_id: local_session_id.clone(),
                            controller_view_id,
                            control_epoch,
                            cols,
                            rows,
                            layout_epoch,
                        });
                    }
                    StateMessage::ActivityChanged { activity } => {
                        replica.set_activity(activity.clone());
                        let _ = remote_activity_tx.send(RemoteActivityChanged {
                            session_id: local_session_id.clone(),
                            activity,
                        });
                    }
                    // The daemon-to-daemon replica currently keeps desktop
                    // presentation view-local. Compact Apple clients consume
                    // this projection directly; desktop per-pane presentation
                    // is a separate UI boundary.
                    StateMessage::ConfigurationChanged { .. } => {}
                }
            }
            // A stream that ended because we asked to be detached is not a
            // failure. The host closes its side in answer to our Detach, so
            // that EOF races the cancellation flag and can win.
            if *state_cancelled.borrow() {
                connection_failed = false;
            }
            let mut current_views = views.lock().await;
            if current_views
                .get(&local_view_key)
                .is_some_and(|current| Arc::ptr_eq(current, &remote_view))
            {
                current_views.remove(&local_view_key);
            }
            drop(current_views);

            if connection_failed {
                remote_host.healthy.store(false, Ordering::Release);
                remote_host.connection.close();
                let mut current_connections = connections.lock().await;
                if current_connections
                    .get(&remote_device_id)
                    .is_some_and(|current| Arc::ptr_eq(current, &remote_host))
                {
                    current_connections.remove(&remote_device_id);
                }
                drop(current_connections);
                // Only a genuine transport failure is a disconnect. A
                // deliberate cancellation — a detach, an unmount, a retirement
                // ahead of a resume — is the caller's intent, and suspending a
                // healthy session on it would also strand its sibling views.
                //
                // Carries the incarnation and generation it acted for; the
                // owner compares both at commit and drops a verdict from a
                // connection that has already been replaced.
                if lifecycle.commit_disconnect(state_generation, incarnation) {
                    engine_runtime.arm_reconnect_for(&local_session_id).await;
                }
            }
        });
        Ok(AttachOutcome {
            attachment_epoch,
            read_write,
            synchronized,
        })
    }

    /// Remove a view's attachment and cancel its reader before anything
    /// re-dials, so a dying reader can never delete the replacement's entry.
    async fn retire_view(&self, session_id: &str, local_view_id: &str) {
        let key = (session_id.to_owned(), local_view_id.to_owned());
        let view = self.views.lock().await.remove(&key);
        if let Some(view) = view {
            view.state_cancel.send_replace(true);
        }
    }

    async fn retire_session_views(&self, session_id: &str) {
        let mut views = self.views.lock().await;
        let retired = views
            .keys()
            .filter(|(candidate, _)| candidate == session_id)
            .cloned()
            .collect::<Vec<_>>();
        let retired = retired
            .into_iter()
            .filter_map(|key| views.remove(&key))
            .collect::<Vec<_>>();
        drop(views);
        for view in retired {
            view.state_cancel.send_replace(true);
        }
    }

    async fn remote_session(&self, session_id: &str) -> Result<RemoteSession> {
        self.replicas
            .read()
            .await
            .get(session_id)
            .cloned()
            .context("unknown remote session")
    }

    /// Liveness round-trip on a device's cached connection. Advertisement
    /// validation is deliberately skipped: the probe matters exactly when the
    /// advertisement has expired, and `remote_connection` bails on that before
    /// it ever reaches the cache.
    pub async fn probe_connection(&self, device_id: &str) -> Result<()> {
        let host = self
            .connections
            .lock()
            .await
            .get(device_id)
            .cloned()
            .context("no cached connection to probe")?;
        match list_sessions_on(&host).await {
            Ok(_) => Ok(()),
            Err(error) => {
                self.fail_connection(device_id, &host).await;
                Err(error).context("remote terminal host failed its liveness probe")
            }
        }
    }

    /// One-shot resume. Phase 1 ships manual retry only: exactly one dial, no
    /// backoff loop and no discovery fast path.
    pub async fn reconnect_session(&self, session_id: &str) -> Result<RemoteSessionLifecycle> {
        let remote = self.remote_session(session_id).await?;
        let lifecycle = Arc::clone(&remote.lifecycle);
        if lifecycle.is_ended() {
            return Ok(lifecycle.snapshot());
        }
        // Cut the engine's pending wait short rather than cancelling it, then
        // take the same single-flight lock it uses: a manual retry and an
        // automatic one can never dial at once, and a failed manual retry
        // leaves the schedule intact behind it.
        if !lifecycle.has_engine() {
            self.arm_reconnect(&remote).await;
        }
        self.note_device_available(&remote.device_id);
        let previous = lifecycle.state_kind();
        lifecycle.commit_reconnecting();
        match self.resume_attempt(&remote).await {
            Ok(()) => Ok(lifecycle.snapshot()),
            Err(AttachFailure::Ended(reason)) => {
                lifecycle.commit_ended(reason);
                Ok(lifecycle.snapshot())
            }
            Err(AttachFailure::Failed(error)) => {
                if previous == RemoteLifecycleState::Ended {
                    return Ok(lifecycle.snapshot());
                }
                Err(error)
            }
        }
    }

    async fn resume_attempt(&self, remote: &RemoteSession) -> Result<(), AttachFailure> {
        let _attempt = remote.lifecycle.attempts.lock().await;
        self.resume_once(remote).await
    }

    /// Arm auto-resume for a session that has lost its host.
    async fn arm_reconnect(&self, remote: &RemoteSession) {
        if remote.lifecycle.is_ended() {
            return;
        }
        let runtime = self.clone();
        let session_id = remote.replica.summary().id;
        remote
            .lifecycle
            .arm_engine(tokio::spawn(reconnect_engine(runtime, session_id)));
    }

    async fn arm_reconnect_for(&self, session_id: &str) {
        if let Ok(remote) = self.remote_session(session_id).await {
            self.arm_reconnect(&remote).await;
        }
    }

    /// Skip a scheduled dial when discovery says the device is both offline
    /// and unadvertised. The fast path covers the wake-up, so this only avoids
    /// burning connects at a host that is provably not there.
    async fn dial_is_pointless(&self, device_id: &str) -> bool {
        let Ok(transport) = self.transport().await else {
            return true;
        };
        !transport.peer_is_online(device_id).await
            && transport.host_instance_id(device_id).await.is_err()
    }

    async fn cached_connection(&self, device_id: &str) -> Option<Arc<RemoteHostConnection>> {
        self.connections.lock().await.get(device_id).cloned()
    }

    /// A generation-advanced re-attach of the feed. This is the promotion
    /// machinery: attach semantics are what guarantee a fresh stream, a full
    /// snapshot, and reset sequencing.
    async fn reestablish_feed(&self, remote: &RemoteSession) -> Result<(), AttachFailure> {
        let _attempt = remote.lifecycle.attempts.lock().await;
        let session_id = remote.replica.summary().id;
        self.retire_session_views(&session_id).await;
        remote.lifecycle.advance_generation();
        self.establish_feed(remote).await
    }

    async fn resume_once(&self, remote: &RemoteSession) -> Result<(), AttachFailure> {
        let lifecycle = &remote.lifecycle;
        let transport = self.transport().await?;
        // Step 2 of the resume handshake: a different host instance is a new
        // world, and it is answerable from discovery alone. Do not dial.
        if let (Ok(advertised), Some(recorded)) = (
            transport.host_instance_id(&remote.device_id).await,
            lifecycle.recorded_host_instance_id(),
        ) && advertised != recorded
        {
            return Err(AttachFailure::Ended(RemoteEndedReason::HostRestarted));
        }

        let session_id = remote.replica.summary().id;
        self.retire_session_views(&session_id).await;
        // Activate before publishing: the moment this returns, every in-flight
        // reader is stale, well before any replacement reads a byte.
        lifecycle.advance_generation();

        let host = self.remote_connection(&remote.device_id).await?;
        if !lifecycle
            .recorded_host_instance_id()
            .is_none_or(|recorded| recorded == host.host_instance_id)
        {
            return Err(AttachFailure::Ended(RemoteEndedReason::HostRestarted));
        }
        lifecycle.bind_connection(host.incarnation);

        // Step 4: resolve the session against the host's live registry and let
        // the listing be the evidence for any terminal verdict.
        let sessions = match list_sessions_on(&host).await {
            Ok(sessions) => sessions,
            Err(error) => {
                self.note_connection_failure(&remote.device_id, &host).await;
                return Err(AttachFailure::Failed(error));
            }
        };
        let entry = sessions
            .iter()
            .find(|summary| summary.session_id == remote.remote_session_id);
        if let Some(reason) = ended_reason_from_listing(entry) {
            return Err(AttachFailure::Ended(reason));
        }

        self.establish_feed(remote).await
    }

    /// Bring a session back to Live around exactly one publishing stream: the
    /// elected feed attaches and synchronizes alone, and only once Live do the
    /// remaining views attach, in the background, so a stalled pane can never
    /// hold up recovery.
    async fn establish_feed(&self, remote: &RemoteSession) -> Result<(), AttachFailure> {
        let lifecycle = &remote.lifecycle;
        let Some(feed_view_id) = lifecycle.elect_feed() else {
            lifecycle.commit_suspended();
            return Ok(());
        };
        let outcome = match self.attach_view_attempt(remote, &feed_view_id, true).await {
            Ok(outcome) => outcome,
            Err(AttachFailure::Ended(reason)) => return Err(AttachFailure::Ended(reason)),
            Err(AttachFailure::Failed(error)) => {
                lifecycle.commit_view_failed(&feed_view_id, format!("{error:#}"), true);
                // The feed could not attach, which is strong evidence this
                // connection is not usable; retire it so the next attempt
                // dials rather than reusing it.
                self.invalidate_connection(&remote.device_id, None).await;
                return Err(AttachFailure::Failed(error));
            }
        };
        lifecycle.commit_view_attached(&feed_view_id, outcome.attachment_epoch, outcome.read_write);
        remote.replica.set_read_write(outcome.read_write);

        lifecycle.commit_synchronizing();
        if let Err(error) =
            await_first_snapshot(outcome.synchronized, self.synchronize_bound()).await
        {
            return Err(AttachFailure::Failed(
                self.abandon_attempt(remote, error).await,
            ));
        }
        lifecycle.commit_live();
        if self.config().zombie_purge {
            let runtime = self.clone();
            let purged = remote.clone();
            tokio::spawn(async move {
                purge_stranded_attachments(runtime, purged).await;
            });
        }

        let secondaries = lifecycle
            .local_view_ids()
            .into_iter()
            .filter(|local_view_id| local_view_id != &feed_view_id)
            .collect::<Vec<_>>();
        if !secondaries.is_empty() {
            let runtime = self.clone();
            let remote = remote.clone();
            tokio::spawn(async move {
                runtime.attach_secondaries(&remote, secondaries).await;
            });
        }
        Ok(())
    }

    /// Attach non-feed views. Each is independent: one failing marks only its
    /// own pane, leaving the rest of the session Live.
    async fn attach_secondaries(&self, remote: &RemoteSession, local_view_ids: Vec<String>) {
        let _attempt = remote.lifecycle.attempts.lock().await;
        for local_view_id in local_view_ids {
            if remote.lifecycle.state_kind() != RemoteLifecycleState::Live {
                return;
            }
            match self
                .attach_view_attempt(remote, &local_view_id, false)
                .await
            {
                Ok(outcome) => remote.lifecycle.commit_view_attached(
                    &local_view_id,
                    outcome.attachment_epoch,
                    outcome.read_write,
                ),
                Err(AttachFailure::Ended(reason)) => {
                    remote.lifecycle.commit_ended(reason);
                    return;
                }
                Err(AttachFailure::Failed(error)) => {
                    remote
                        .lifecycle
                        .commit_view_failed(&local_view_id, format!("{error:#}"), true)
                }
            }
        }
    }

    /// Tear down one connection and every view riding it, then tell each
    /// affected session the truth.
    async fn fail_connection(&self, device_id: &str, host: &Arc<RemoteHostConnection>) {
        self.invalidate_connection(device_id, Some(host)).await;
        let mut views = self.views.lock().await;
        let doomed = views
            .iter()
            .filter(|(_, view)| view.incarnation == host.incarnation)
            .map(|(key, _)| key.clone())
            .collect::<Vec<_>>();
        let doomed = doomed
            .into_iter()
            .filter_map(|key| views.remove(&key).map(|view| (key.0, view)))
            .collect::<Vec<_>>();
        drop(views);
        let mut affected = Vec::new();
        for (session_id, view) in doomed {
            view.state_cancel.send_replace(true);
            affected.push((session_id, view.state_generation, view.incarnation));
        }
        let disconnected = {
            let replicas = self.replicas.read().await;
            affected
                .into_iter()
                .filter(|(session_id, generation, incarnation)| {
                    replicas.get(session_id).is_some_and(|remote| {
                        remote
                            .lifecycle
                            .commit_disconnect(*generation, *incarnation)
                    })
                })
                .map(|(session_id, _, _)| session_id)
                .collect::<Vec<_>>()
        };
        for session_id in disconnected {
            self.arm_reconnect_for(&session_id).await;
        }
    }

    pub async fn send_input(
        &self,
        session_id: &str,
        view_id: &str,
        attachment_epoch: u64,
        input_sequence: u64,
        operation: TunnelInput,
    ) -> Result<()> {
        let view = self
            .remote_view(session_id, view_id, attachment_epoch)
            .await?;
        if !view.read_write {
            bail!("remote terminal view is read-only");
        }
        let wire_view_id = view.wire_view_id.clone();
        view.session_control
            .lock()
            .await
            .write_message(
                &SessionControlMessage::Input {
                    view_id: wire_view_id,
                    attachment_epoch,
                    input_sequence,
                    operation,
                },
                MAX_CONTROL_MESSAGE_BYTES,
            )
            .await
    }

    pub async fn claim_control(
        &self,
        session_id: &str,
        view_id: &str,
        attachment_epoch: u64,
        cols: u16,
        rows: u16,
    ) -> Result<RemoteControlClaim> {
        let view = self
            .remote_view(session_id, view_id, attachment_epoch)
            .await?;
        if !view.read_write {
            bail!("remote terminal view is read-only");
        }
        let mut state = view.control.clone();
        let previous_epoch = state
            .borrow()
            .as_ref()
            .map_or(0, |current| current.control_epoch);
        let wire_view_id = view.wire_view_id.clone();
        view.session_control
            .lock()
            .await
            .write_message(
                &SessionControlMessage::FocusAndResize {
                    view_id: wire_view_id,
                    attachment_epoch,
                    cols,
                    rows,
                    client_sequence: 0,
                },
                MAX_CONTROL_MESSAGE_BYTES,
            )
            .await?;
        tokio::time::timeout(HANDSHAKE_TIMEOUT, async {
            loop {
                state
                    .changed()
                    .await
                    .context("remote terminal control stream closed")?;
                let current = state.borrow_and_update().clone();
                if let Some(current) = current
                    && current.controller_view_id == view_id
                    && current.control_epoch > previous_epoch
                {
                    return Ok(current);
                }
            }
        })
        .await
        .context("timed out claiming remote terminal control")?
    }

    pub async fn resize(
        &self,
        session_id: &str,
        view_id: &str,
        request: RemoteResize,
    ) -> Result<()> {
        let RemoteResize {
            attachment_epoch,
            control_epoch,
            resize_sequence,
            cols,
            rows,
        } = request;
        let view = self
            .remote_view(session_id, view_id, attachment_epoch)
            .await?;
        if !view.read_write {
            bail!("remote terminal view is read-only");
        }
        let wire_view_id = view.wire_view_id.clone();
        view.session_control
            .lock()
            .await
            .write_message(
                &SessionControlMessage::Resize {
                    view_id: wire_view_id,
                    attachment_epoch,
                    control_epoch,
                    resize_sequence,
                    cols,
                    rows,
                },
                MAX_CONTROL_MESSAGE_BYTES,
            )
            .await
    }

    pub async fn selection_text(
        &self,
        session_id: &str,
        view_id: &str,
        request: RemoteSelection,
    ) -> Result<String> {
        let view = self
            .remote_view(session_id, view_id, request.attachment_epoch)
            .await?;
        let request_id = Uuid::new_v4().to_string();
        let wire_view_id = view.wire_view_id.clone();
        let mut control = view.session_control.lock().await;
        control
            .write_message(
                &SessionControlMessage::SelectionText {
                    request_id: request_id.clone(),
                    view_id: wire_view_id,
                    attachment_epoch: request.attachment_epoch,
                    start_column: request.start_column,
                    start_row: request.start_row,
                    end_column: request.end_column,
                    end_row: request.end_row,
                    select_all: request.select_all,
                },
                MAX_CONTROL_MESSAGE_BYTES,
            )
            .await?;
        match control
            .read_message::<SessionControlMessage>(MAX_CONTROL_MESSAGE_BYTES)
            .await?
            .context("remote terminal closed before returning selection text")?
        {
            SessionControlMessage::SelectionTextResult {
                request_id: response_id,
                text,
            } if response_id == request_id => Ok(text),
            _ => bail!("remote terminal returned an invalid selection response"),
        }
    }

    pub async fn refresh(&self, session_id: &str) -> Result<()> {
        let replica = self
            .replicas
            .read()
            .await
            .get(session_id)
            .map(|session| Arc::clone(&session.replica))
            .context("unknown remote session")?;
        replica.refresh()
    }

    /// A true remote refresh: a generation-advanced re-attach of the feed,
    /// which is what guarantees a fresh stream, a full snapshot, and reset
    /// sequencing. `RequestSnapshot` would instead spawn a *second* persistent
    /// state stream on QUIC, leaving two feeds racing independent patch
    /// sequences into the one replica.
    pub async fn refresh_remote(&self, session_id: &str) -> Result<()> {
        let remote = self.remote_session(session_id).await?;
        if remote.lifecycle.state_kind() != RemoteLifecycleState::Live {
            bail!("remote terminal session is not live");
        }
        self.reestablish_feed(&remote)
            .await
            .map_err(anyhow::Error::from)
    }

    pub async fn detach_view(&self, session_id: &str, view_id: &str, attachment_epoch: u64) {
        let key = (session_id.to_owned(), view_id.to_owned());
        // A view whose connection already died is gone from the map but still
        // recorded on the lifecycle. The bookkeeping below has to run either
        // way, or detaching a dead pane would leave the session dialing for it
        // forever.
        if let Some(view) = self.views.lock().await.remove(&key) {
            // Retire before telling the host: it closes this view's state
            // stream in response, and that EOF must already read as deliberate.
            view.state_cancel.send_replace(true);
            if view.attachment_epoch == attachment_epoch {
                let wire_view_id = view.wire_view_id.clone();
                let _ = view
                    .session_control
                    .lock()
                    .await
                    .write_message(
                        &SessionControlMessage::Detach {
                            view_id: wire_view_id,
                            attachment_epoch,
                        },
                        MAX_CONTROL_MESSAGE_BYTES,
                    )
                    .await;
            }
        }
        let remote = self.replicas.read().await.get(session_id).cloned();
        let Some(remote) = remote else {
            return;
        };
        // An explicit detach retires the view for good: leaving a record
        // behind would have a later resume re-attach a pane the user closed.
        remote.lifecycle.commit_view_pending(view_id);
        remote.lifecycle.forget_view(view_id);
        let promote = remote.lifecycle.release_feed(view_id);
        if remote.lifecycle.local_view_ids().is_empty() {
            // Nothing is left to resume, so stop dialing for it.
            remote.lifecycle.cancel_engine();
            return;
        }
        if !promote || remote.lifecycle.is_ended() {
            return;
        }
        // The replica just lost its feed while other panes are still showing
        // this session. Promotion is a generation-advanced re-attach, not an
        // in-place stream switch: attach semantics are what guarantee the
        // survivor a fresh stream, a full snapshot, and reset sequencing.
        if let Err(failure) = self.reestablish_feed(&remote).await {
            match failure {
                AttachFailure::Ended(reason) => remote.lifecycle.commit_ended(reason),
                AttachFailure::Failed(error) => {
                    eprintln!("[terminal-mesh] feed promotion failed: {error:#}");
                    remote.lifecycle.commit_suspended();
                }
            }
        }
    }

    pub async fn close_session(&self, session_id: &str) -> bool {
        let lifecycle = self
            .replicas
            .read()
            .await
            .get(session_id)
            .map(|remote| Arc::clone(&remote.lifecycle));
        // End the session before detaching: these detaches are teardown, not
        // pane closures, and must not each promote a new feed on the way out.
        if let Some(lifecycle) = lifecycle {
            lifecycle.cancel_engine();
            lifecycle.commit_ended(RemoteEndedReason::ClosedLocally);
        }
        let views = self
            .views
            .lock()
            .await
            .iter()
            .filter(|((candidate, _), _)| candidate == session_id)
            .map(|((_, view_id), view)| (view_id.clone(), view.attachment_epoch))
            .collect::<Vec<_>>();
        for (view_id, epoch) in views {
            self.detach_view(session_id, &view_id, epoch).await;
        }
        self.replicas.write().await.remove(session_id).is_some()
    }

    pub async fn session_lifecycle(&self, session_id: &str) -> Option<RemoteSessionLifecycle> {
        self.replicas
            .read()
            .await
            .get(session_id)
            .map(|remote| remote.lifecycle.snapshot())
    }

    /// The authoritative attachment lookup. Callers consult this at use time
    /// rather than caching an epoch, so a dead view re-dials instead of
    /// answering with an epoch its connection no longer honours.
    pub async fn current_attachment(&self, session_id: &str, view_id: &str) -> Option<(u64, bool)> {
        self.replicas
            .read()
            .await
            .get(session_id)?
            .lifecycle
            .current_attachment(view_id)
    }

    /// Answer a selection from the retained replica viewport, for use while
    /// the session is not live. Authorization is the caller's ownership
    /// record, not a live attachment epoch, so the field is ignored here.
    pub async fn offline_selection_text(
        &self,
        session_id: &str,
        request: RemoteSelection,
    ) -> Result<String> {
        let remote = self.remote_session(session_id).await?;
        remote.replica.viewport_selection_text(
            request.start_column,
            request.start_row,
            request.end_column,
            request.end_row,
            request.select_all,
        )
    }

    async fn remote_view(
        &self,
        session_id: &str,
        view_id: &str,
        attachment_epoch: u64,
    ) -> Result<Arc<RemoteView>> {
        let view = self
            .views
            .lock()
            .await
            .get(&(session_id.to_owned(), view_id.to_owned()))
            .cloned()
            .context("remote view is not attached")?;
        if view.attachment_epoch != attachment_epoch {
            bail!("stale remote view attachment");
        }
        // A view can be attached while the session is still synchronizing.
        // Rejecting here — rather than queueing — is the whole point: a
        // keystroke delivered after recovery would act on a screen the user
        // never saw.
        if let Some(remote) = self.replicas.read().await.get(session_id)
            && remote.lifecycle.state_kind() != RemoteLifecycleState::Live
        {
            bail!("remote terminal session is not live");
        }
        Ok(view)
    }

    async fn remote_connection(&self, device_id: &str) -> Result<Arc<RemoteHostConnection>> {
        let transport = self.transport().await?;
        let advertised = transport.host_instance_id(device_id).await?;
        if let Some(reusable) = self.reusable_connection(device_id, &advertised).await {
            return Ok(reusable);
        }
        // Dial off the lock. A connect can take the full CONNECT_TIMEOUT, and
        // holding the cache across it stalls every other caller — including
        // the ones that would have been served from cache.
        let remote = transport.dial(device_id).await?;
        let mut connections = self.connections.lock().await;
        // Someone may have dialed while we were: prefer whichever connection
        // is already published so callers converge on one, and close ours.
        if let Some(existing) = connections.get(device_id)
            && connection_is_reusable(
                &existing.host_instance_id,
                existing.healthy.load(Ordering::Acquire),
                &advertised,
            )
        {
            let existing = Arc::clone(existing);
            drop(connections);
            remote.connection.close();
            return Ok(existing);
        }
        if let Some(stale) = connections.insert(device_id.to_owned(), Arc::clone(&remote)) {
            stale.healthy.store(false, Ordering::Release);
            stale.connection.close();
        }
        Ok(remote)
    }

    async fn reusable_connection(
        &self,
        device_id: &str,
        advertised: &str,
    ) -> Option<Arc<RemoteHostConnection>> {
        let mut connections = self.connections.lock().await;
        let connection = connections.get(device_id)?;
        if connection_is_reusable(
            &connection.host_instance_id,
            connection.healthy.load(Ordering::Acquire),
            advertised,
        ) {
            return Some(Arc::clone(connection));
        }
        let stale = connections.remove(device_id)?;
        stale.connection.close();
        None
    }

    /// Retire a connection the moment an operation on it fails. Without this a
    /// dial that succeeds and then breaks stays cached and healthy forever,
    /// and every later caller — including ones that should have dialed fresh —
    /// is handed the corpse.
    async fn note_connection_failure(&self, device_id: &str, host: &Arc<RemoteHostConnection>) {
        host.healthy.store(false, Ordering::Release);
        self.invalidate_connection(device_id, Some(host)).await;
    }

    async fn has_sessions_on(&self, device_id: &str) -> bool {
        self.replicas.read().await.values().any(|remote| {
            remote.device_id == device_id
                && !matches!(
                    remote.lifecycle.state_kind(),
                    RemoteLifecycleState::Ended | RemoteLifecycleState::Suspended
                )
        })
    }

    async fn devices_with_live_sessions(&self) -> Vec<String> {
        let mut devices = self
            .replicas
            .read()
            .await
            .values()
            .filter(|remote| {
                !matches!(
                    remote.lifecycle.state_kind(),
                    RemoteLifecycleState::Ended | RemoteLifecycleState::Suspended
                )
            })
            .map(|remote| remote.device_id.clone())
            .collect::<Vec<_>>();
        devices.sort();
        devices.dedup();
        devices
    }

    /// Devices carrying live sessions whose advertisement has lapsed. No
    /// discovery event reports this: a host process can stall while its device
    /// stays online, so nothing is republished and nothing is removed — the
    /// advertisement simply ages out against the wall clock.
    async fn lapsed_advertisement_devices(&self) -> Vec<String> {
        let Ok(transport) = self.transport().await else {
            return Vec::new();
        };
        let mut lapsed = Vec::new();
        for device_id in self.devices_with_live_sessions().await {
            if transport.host_instance_id(&device_id).await.is_err() {
                lapsed.push(device_id);
            }
        }
        lapsed
    }

    async fn probe_lapsed_advertisements(&self) {
        for device_id in self.lapsed_advertisement_devices().await {
            if let Err(error) = self.probe_connection(&device_id).await {
                eprintln!("[terminal-mesh] liveness probe of {device_id} failed: {error:#}");
            }
        }
    }

    async fn transport(&self) -> Result<Arc<dyn HostTransport>> {
        self.transport
            .read()
            .await
            .clone()
            .context("Truffle terminal networking is disabled or still starting")
    }

    pub fn set_reconnect_config(&self, config: MeshReconnectConfig) {
        *self.config.lock().unwrap() = config;
    }

    fn config(&self) -> MeshReconnectConfig {
        *self.config.lock().unwrap()
    }

    fn jitter(&self) -> JitterSource {
        Arc::clone(&self.jitter.lock().unwrap())
    }

    #[cfg(test)]
    fn set_jitter(&self, jitter: JitterSource) {
        *self.jitter.lock().unwrap() = jitter;
    }

    fn synchronize_bound(&self) -> Duration {
        self.config().synchronize_timeout
    }

    /// Tell any session waiting out a backoff on this device that it is worth
    /// dialing now. Discovery is a hint, so this only ever shortens a wait.
    pub fn note_device_available(&self, device_id: &str) {
        let _ = self.wakeup_tx.send(device_id.to_owned());
    }

    #[cfg(test)]
    async fn install_transport(&self, transport: Arc<dyn HostTransport>) {
        *self.transport.write().await = Some(transport);
    }

    #[cfg(test)]
    fn set_synchronize_timeout(&self, bound: Duration) {
        let mut config = self.config.lock().unwrap();
        config.synchronize_timeout = bound;
    }

    async fn invalidate_connection(
        &self,
        device_id: &str,
        expected: Option<&Arc<RemoteHostConnection>>,
    ) {
        let mut connections = self.connections.lock().await;
        let should_remove = connections
            .get(device_id)
            .is_some_and(|current| expected.is_none_or(|expected| Arc::ptr_eq(current, expected)));
        if should_remove && let Some(connection) = connections.remove(device_id) {
            connection.healthy.store(false, Ordering::Release);
            connection.connection.close();
        }
    }

    async fn ready(&self) -> Result<MeshReady> {
        self.ready
            .read()
            .await
            .clone()
            .context("Truffle terminal networking is disabled or still starting")
    }
}

struct QuicHostTransport {
    ready: MeshReady,
}

#[async_trait]
impl HostTransport for QuicHostTransport {
    fn capability(&self) -> Option<String> {
        self.ready.capability.clone()
    }

    async fn device_name(&self, device_id: &str) -> Option<String> {
        self.ready
            .node
            .peers()
            .await
            .into_iter()
            .find(|peer| peer.device_id.as_deref() == Some(device_id))
            .map(|peer| peer.display_name)
    }

    async fn peer_is_online(&self, device_id: &str) -> bool {
        self.ready
            .node
            .peers()
            .await
            .into_iter()
            .any(|peer| peer.device_id.as_deref() == Some(device_id) && peer.online)
    }

    async fn host_instance_id(&self, device_id: &str) -> Result<String> {
        Ok(validated_advertisement(&self.ready, device_id)
            .await?
            .host_instance_id)
    }

    async fn dial(&self, device_id: &str) -> Result<Arc<RemoteHostConnection>> {
        let advertisement = validated_advertisement(&self.ready, device_id).await?;
        let connection = Arc::new(
            tokio::time::timeout(
                CONNECT_TIMEOUT,
                self.ready
                    .node
                    .connect_quic(device_id, advertisement.quic_port),
            )
            .await
            .context("timed out connecting to remote terminal host")?
            .context("connect to remote terminal host")?,
        );
        let connection: Arc<dyn MeshConnection> = connection;
        match client_handshake(
            Arc::clone(&connection),
            &self.ready.node.local_info().device_id,
            &self.ready.host_instance_id,
            &advertisement.host_instance_id,
        )
        .await
        {
            Ok(remote) => Ok(remote),
            Err(error) => {
                // Close what we opened. A handshake that times out against an
                // unresponsive host would otherwise leave a half-open
                // connection behind on every attempt, and a retry loop makes
                // that dozens of them.
                connection.close();
                Err(error)
            }
        }
    }
}

/// The viewer half of the connection handshake, up to a usable control stream.
async fn client_handshake(
    connection: Arc<dyn MeshConnection>,
    local_device_id: &str,
    local_host_instance_id: &str,
    expected_host_instance_id: &str,
) -> Result<Arc<RemoteHostConnection>> {
    let mut control = ProtocolStream::new(connection.open_stream().await?);
    control
        .write_preface(&StreamPreface {
            stream_kind: StreamKind::ConnectionControl,
            session_id: None,
            view_id: None,
        })
        .await?;
    let nonce = Uuid::new_v4().to_string();
    control
        .write_message(
            &ConnectionMessage::ClientHello {
                protocol_major: PROTOCOL_MAJOR,
                protocol_minor: PROTOCOL_MINOR,
                host_instance_id: local_host_instance_id.to_owned(),
                local_device_id: local_device_id.to_owned(),
                nonce: nonce.clone(),
                state_codecs: Some(vec![StateCodec::CompactJsonV1]),
            },
            MAX_CONTROL_MESSAGE_BYTES,
        )
        .await?;
    let state_codec = match tokio::time::timeout(
        HANDSHAKE_TIMEOUT,
        control.read_message::<ConnectionMessage>(MAX_CONTROL_MESSAGE_BYTES),
    )
    .await
    .context("timed out waiting for remote terminal handshake")??
    .context("remote host closed during handshake")?
    {
        ConnectionMessage::ServerHello {
            protocol_major,
            protocol_minor,
            host_instance_id,
            nonce: echoed_nonce,
            state_codec,
        } if protocol_major == PROTOCOL_MAJOR
            && protocol_minor > 0
            && echoed_nonce == nonce
            && host_instance_id == expected_host_instance_id
            && state_codec.is_none_or(|codec| codec == StateCodec::CompactJsonV1) =>
        {
            state_codec.unwrap_or(StateCodec::Json)
        }
        _ => bail!("remote host returned an invalid server hello"),
    };
    Ok(Arc::new(RemoteHostConnection {
        connection,
        control: tokio::sync::Mutex::new(control),
        incoming: tokio::sync::Mutex::new(()),
        host_instance_id: expected_host_instance_id.to_owned(),
        state_codec,
        healthy: AtomicBool::new(true),
        incarnation: NEXT_CONNECTION_INCARNATION.fetch_add(1, Ordering::Relaxed),
    }))
}

async fn validated_advertisement(
    ready: &MeshReady,
    device_id: &str,
) -> Result<TerminalHostAdvertisement> {
    let advertisement = ready
        .store
        .get(device_id)
        .await
        .context("terminal host is not advertised")?
        .data;
    if advertisement.expires_at_ms < now_ms() {
        bail!("terminal host advertisement has expired");
    }
    if advertisement.protocol_major != PROTOCOL_MAJOR {
        bail!("remote terminal protocol major is incompatible");
    }
    if advertisement.protocol_minor == 0 {
        bail!("remote terminal protocol minor is invalid");
    }
    Ok(advertisement)
}

#[derive(Clone, Debug)]
/// Terminal-specific routing and authorization layered on a shared Truffle
/// node. Application identity, node state, and sidecar configuration belong to
/// the embedding host instead.
pub struct TruffleTerminalConfig {
    pub service_name: String,
    pub quic_port: u16,
    pub compact_port: u16,
    pub capability: Option<String>,
    pub allow_tailnet_write: bool,
    pub reconnect: MeshReconnectConfig,
}

impl Default for TruffleTerminalConfig {
    fn default() -> Self {
        Self {
            service_name: "terminal.v1".to_owned(),
            quic_port: DEFAULT_QUIC_PORT,
            compact_port: DEFAULT_COMPACT_PORT,
            capability: None,
            allow_tailnet_write: false,
            reconnect: MeshReconnectConfig::default(),
        }
    }
}

impl TruffleTerminalConfig {
    fn validate(&self) -> Result<()> {
        if self.service_name.trim().is_empty() {
            bail!("Truffle terminal service name must not be empty");
        }
        if self.quic_port == 0 {
            bail!("Truffle terminal QUIC port must be nonzero");
        }
        if self.compact_port == 0 {
            bail!("Truffle terminal compact-stream port must be nonzero");
        }
        if self.compact_port == self.quic_port {
            bail!("Truffle terminal QUIC and compact-stream ports must differ");
        }
        Ok(())
    }

    fn access_for(&self, supplied: Option<&str>) -> ViewAccess {
        if self.allow_tailnet_write {
            return ViewAccess::ReadWrite;
        }
        let Some(expected) = self.capability.as_deref() else {
            return ViewAccess::ReadOnly;
        };
        let Some(supplied) = supplied else {
            return ViewAccess::ReadOnly;
        };
        if expected.len() == supplied.len()
            && bool::from(expected.as_bytes().ct_eq(supplied.as_bytes()))
        {
            ViewAccess::ReadWrite
        } else {
            ViewAccess::ReadOnly
        }
    }

    fn advertises_write(&self) -> bool {
        self.allow_tailnet_write || self.capability.is_some()
    }
}

/// A terminal transport adapter that borrows a host-owned Truffle node by
/// `Arc`. Its discovery store and QUIC listener are scoped to this terminal
/// service, while the node and sidecar remain shared with the host.
pub struct TruffleTerminalMesh {
    node: Arc<Node<TailscaleProvider>>,
    config: TruffleTerminalConfig,
    runtime: MeshRuntime,
}

impl TruffleTerminalMesh {
    pub fn new(node: Arc<Node<TailscaleProvider>>, config: TruffleTerminalConfig) -> Result<Self> {
        config.validate()?;
        let runtime = MeshRuntime::new();
        runtime.set_reconnect_config(config.reconnect);
        Ok(Self {
            node,
            config,
            runtime,
        })
    }

    pub fn runtime(&self) -> MeshRuntime {
        self.runtime.clone()
    }

    pub async fn serve(self, registry: Registry, host_config: HostConfigReceiver) -> Result<()> {
        let Self {
            node,
            config,
            runtime,
        } = self;
        let host_instance_id = Uuid::new_v4().to_string();
        let listener = Arc::new(
            node.listen_quic(config.quic_port)
                .await
                .context("listen for terminal QUIC connections")?,
        );
        let compact_listener = node
            .listen_tcp(config.compact_port)
            .await
            .context("listen for Apple terminal compact-stream connections")?;
        let store_id = format!("{}.hosts", config.service_name);
        let store_namespace = format!("ss:{store_id}");
        // Profiles keep a stable Truffle device ID, so persist the local store
        // version with it. Otherwise a restarted ghosttead begins again at
        // version 1 and a still-running peer rejects its advertisements as older
        // than the previous process's slice.
        let store = node.synced_store_with_backend::<TerminalHostAdvertisement>(
            &store_id,
            Arc::new(truffle::FileBackend::new(
                node.state_dir().join("synced-store"),
            )),
        );
        let ready = MeshReady {
            node: Arc::clone(&node),
            store: Arc::clone(&store),
            host_instance_id: host_instance_id.clone(),
            capability: config.capability.clone(),
        };
        *runtime.ready.write().await = Some(ready.clone());
        *runtime.transport.write().await = Some(Arc::new(QuicHostTransport { ready }));
        let probes = tokio::spawn(probe_trigger_loop(
            runtime.clone(),
            Arc::clone(&node),
            Arc::clone(&store),
        ));
        eprintln!(
            "[terminal-mesh] ready as {} on QUIC port {} and compact-stream port {}",
            node.local_info().device_name,
            listener.port(),
            compact_listener.port
        );

        let advertise = advertise_loop(
            Arc::clone(&node),
            Arc::clone(&store),
            registry.clone(),
            config.clone(),
            host_instance_id.clone(),
            store_namespace,
        );
        let accept = accept_loop(
            Arc::clone(&node),
            Arc::clone(&listener),
            registry.clone(),
            config.clone(),
            host_instance_id.clone(),
            host_config.clone(),
        );
        let compact_accept = compact_accept_loop(
            Arc::clone(&node),
            compact_listener,
            registry,
            config.clone(),
            host_instance_id,
            host_config,
        );
        let result = tokio::select! {
            result = advertise => result,
            result = accept => result,
            result = compact_accept => result,
        };
        probes.abort();
        if let Err(error) = node.unlisten_tcp(config.compact_port).await {
            eprintln!("[terminal-mesh] compact-stream listener cleanup failed: {error}");
        }
        runtime.connections.lock().await.clear();
        *runtime.transport.write().await = None;
        *runtime.ready.write().await = None;
        result
    }
}

/// Discovery is a hint, never a verdict. A peer going offline or an
/// advertisement expiring only fires a liveness probe on the cached
/// connection; nothing is torn down unless that probe fails.
async fn probe_trigger_loop(
    runtime: MeshRuntime,
    node: Arc<Node<TailscaleProvider>>,
    store: Arc<HostStore>,
) {
    let mut peers = node.on_peer_change();
    let mut advertisements = store.subscribe();
    let mut expiry = tokio::time::interval(ADVERTISEMENT_INTERVAL);
    expiry.set_missed_tick_behavior(MissedTickBehavior::Skip);
    loop {
        let device_id = tokio::select! {
            event = peers.recv() => match event {
                Ok(event) => {
                    if let Some(device_id) = peer_wakeup_candidate(&event) {
                        runtime.note_device_available(&device_id);
                    }
                    peer_probe_candidate(&event)
                }
                Err(broadcast::error::RecvError::Lagged(_)) => continue,
                Err(broadcast::error::RecvError::Closed) => break,
            },
            event = advertisements.recv() => match event {
                Ok(event) => {
                    let now = now_ms();
                    if let Some(device_id) = advertisement_wakeup_candidate(&event, now) {
                        runtime.note_device_available(&device_id);
                    }
                    advertisement_probe_candidate(&event, now)
                }
                Err(broadcast::error::RecvError::Lagged(_)) => continue,
                Err(broadcast::error::RecvError::Closed) => break,
            },
            _ = expiry.tick() => {
                runtime.probe_lapsed_advertisements().await;
                continue;
            },
        };
        let Some(device_id) = device_id else {
            continue;
        };
        if !runtime.has_sessions_on(&device_id).await {
            continue;
        }
        if let Err(error) = runtime.probe_connection(&device_id).await {
            eprintln!("[terminal-mesh] liveness probe of {device_id} failed: {error:#}");
        }
    }
}

async fn advertise_loop(
    node: Arc<Node<TailscaleProvider>>,
    store: Arc<HostStore>,
    registry: Registry,
    config: TruffleTerminalConfig,
    host_instance_id: String,
    store_namespace: String,
) -> Result<()> {
    let mut interval = tokio::time::interval(ADVERTISEMENT_INTERVAL);
    interval.set_missed_tick_behavior(MissedTickBehavior::Skip);
    loop {
        interval.tick().await;
        let now = now_ms();
        let sessions = registry
            .read()
            .unwrap()
            .values()
            .map(|session| {
                let summary = session.summary();
                SharedSessionSummary {
                    session_id: summary.id,
                    title: summary.title.unwrap_or_else(|| summary.executable.clone()),
                    cwd_label: summary.cwd,
                    running: !summary.exited,
                    attachable: true,
                    read_write: config.advertises_write(),
                    created_at_ms: session.created_at_ms(),
                    activity: summary.activity,
                }
            })
            .collect();
        store
            .set(TerminalHostAdvertisement {
                protocol_major: PROTOCOL_MAJOR,
                protocol_minor: PROTOCOL_MINOR,
                quic_port: config.quic_port,
                host_instance_id: host_instance_id.clone(),
                published_at_ms: now,
                expires_at_ms: now.saturating_add(ADVERTISEMENT_TTL.as_millis() as u64),
                sessions,
            })
            .await;

        // SyncedStore subscribes after Node startup. With durable Truffle
        // profiles, peer discovery can therefore finish before the store's
        // peer-event receiver exists, causing it to miss the one-time Joined
        // event that normally performs the initial full sync. A broadcast
        // alone cannot recover because it only targets message channels that
        // are already connected. Targeted requests both establish that
        // channel lazily and ask every known same-app peer for its latest
        // slice, making discovery converge after either side restarts.
        request_advertisements_from_online_peers(&node, &store_namespace).await;
    }
}

async fn request_advertisements_from_online_peers(
    node: &Node<TailscaleProvider>,
    store_namespace: &str,
) {
    let local_device_id = node.local_info().device_id;
    let request = truffle::SyncMessage::Request {};
    let Ok(payload) = serde_json::to_value(&request) else {
        return;
    };
    for peer in node.peers().await {
        let Some(device_id) = peer.device_id else {
            continue;
        };
        if !peer.online || device_id == local_device_id {
            continue;
        }
        if let Err(cause) = node
            .send_typed(&device_id, store_namespace, "request", &payload)
            .await
        {
            eprintln!(
                "[terminal-mesh] could not request advertisement from {}: {cause}",
                peer.display_name
            );
        }
    }
}

async fn compact_accept_loop(
    node: Arc<Node<TailscaleProvider>>,
    mut listener: truffle::transport::RawListener,
    registry: Registry,
    config: TruffleTerminalConfig,
    host_instance_id: String,
    host_config: HostConfigReceiver,
) -> Result<()> {
    while let Some(incoming) = listener.accept().await {
        let node = Arc::clone(&node);
        let registry = registry.clone();
        let config = config.clone();
        let host_instance_id = host_instance_id.clone();
        let host_config = host_config.clone();
        tokio::spawn(async move {
            if let Err(error) = handle_compact_connection(
                node,
                incoming,
                registry,
                config,
                host_instance_id,
                host_config,
            )
            .await
            {
                eprintln!("[terminal-mesh] rejected compact-stream connection: {error:#}");
            }
        });
    }
    Ok(())
}

async fn handle_compact_connection(
    node: Arc<Node<TailscaleProvider>>,
    incoming: truffle::transport::RawIncoming,
    registry: Registry,
    config: TruffleTerminalConfig,
    host_instance_id: String,
    host_config: HostConfigReceiver,
) -> Result<()> {
    let authenticated_node_id = incoming
        .remote_identity
        .as_ref()
        .and_then(|identity| identity.node_id.as_deref())
        .context("compact-stream source lacks a Tailscale WhoIs stable node ID")?;
    let peer = node
        .peers()
        .await
        .into_iter()
        .find(|peer| peer.tailscale_id == authenticated_node_id)
        .context("compact-stream source is not a current Truffle peer")?;
    let client_id = format!("truffle:{}", peer.peer_ref);
    handle_compact_protocol(
        incoming.stream,
        registry,
        config,
        host_instance_id,
        peer.device_id,
        client_id,
        host_config,
    )
    .await
}

async fn handle_compact_protocol<S>(
    stream: S,
    registry: Registry,
    config: TruffleTerminalConfig,
    host_instance_id: String,
    expected_device_id: Option<String>,
    client_id: String,
    host_config: HostConfigReceiver,
) -> Result<()>
where
    S: AsyncRead + AsyncWrite + Unpin + Send,
{
    let mut control = CompactProtocolStream::new(stream);
    let preface = tokio::time::timeout(HANDSHAKE_TIMEOUT, control.read_preface())
        .await
        .context("timed out reading compact-stream preface")??;
    let hello = tokio::time::timeout(
        HANDSHAKE_TIMEOUT,
        control.read_message::<ConnectionMessage>(MAX_CONTROL_MESSAGE_BYTES),
    )
    .await
    .context("timed out reading compact-stream client hello")??
    .context("compact stream closed before client hello")?;
    let (client_nonce, state_codec, protocol_minor) = match hello {
        ConnectionMessage::ClientHello {
            protocol_major,
            protocol_minor,
            local_device_id,
            nonce,
            state_codecs,
            ..
        } if protocol_major == PROTOCOL_MAJOR
            && protocol_minor > 0
            && !local_device_id.trim().is_empty()
            && expected_device_id
                .as_deref()
                .is_none_or(|expected| expected == local_device_id) =>
        {
            (
                nonce,
                negotiate_state_codec(state_codecs),
                protocol_minor.min(PROTOCOL_MINOR),
            )
        }
        ConnectionMessage::ClientHello { .. } => {
            bail!("compact-stream client hello identity or protocol mismatch")
        }
        _ => bail!("expected compact-stream client hello"),
    };
    control
        .write_message(
            &ConnectionMessage::ServerHello {
                protocol_major: PROTOCOL_MAJOR,
                protocol_minor: PROTOCOL_MINOR,
                host_instance_id,
                nonce: client_nonce,
                state_codec: (state_codec != StateCodec::Json).then_some(state_codec),
            },
            MAX_CONTROL_MESSAGE_BYTES,
        )
        .await?;

    match preface.stream_kind {
        StreamKind::ConnectionControl => {
            while let Some(message) = control
                .read_message::<ConnectionMessage>(MAX_CONTROL_MESSAGE_BYTES)
                .await?
            {
                match message {
                    ConnectionMessage::ListSessions { request_id } => {
                        control
                            .write_message(
                                &ConnectionMessage::Sessions {
                                    request_id,
                                    sessions: shared_sessions(&registry, &config),
                                },
                                MAX_CONTROL_MESSAGE_BYTES,
                            )
                            .await?;
                    }
                    _ => {
                        control
                            .write_message(
                                &ConnectionMessage::Error {
                                    request_id: None,
                                    code: "unexpected-message".into(),
                                    message:
                                        "message is not valid on the connection control stream"
                                            .into(),
                                },
                                MAX_CONTROL_MESSAGE_BYTES,
                            )
                            .await?;
                    }
                }
            }
        }
        StreamKind::SessionControl => {
            handle_compact_session_protocol(
                &mut control,
                preface,
                IncomingSessionContext {
                    registry,
                    config,
                    client_id,
                    state_codec,
                    protocol_minor,
                    host_config,
                },
            )
            .await?;
        }
        _ => bail!("compact stream kind is not client-openable"),
    }
    Ok(())
}

async fn handle_compact_session_protocol<S>(
    control: &mut CompactProtocolStream<S>,
    preface: StreamPreface,
    context: IncomingSessionContext,
) -> Result<()>
where
    S: AsyncRead + AsyncWrite + Unpin + Send,
{
    let IncomingSessionContext {
        registry,
        config,
        client_id,
        state_codec,
        protocol_minor,
        mut host_config,
    } = context;
    let session_id = preface
        .session_id
        .context("compact session stream lacks session id")?;
    let attach = tokio::time::timeout(
        HANDSHAKE_TIMEOUT,
        control.read_compact_message::<SessionControlMessage>(
            CompactChannel::Control,
            MAX_CONTROL_MESSAGE_BYTES,
        ),
    )
    .await
    .context("timed out reading compact session attach")??
    .context("compact session stream closed before attach")?;
    let (request_id, view_id, access_token) = match attach {
        SessionControlMessage::AttachView {
            request_id,
            session_id: requested_session,
            view_id,
            access_token,
            ..
        } if requested_session == session_id => (request_id, view_id, access_token),
        _ => bail!("expected matching compact attach-view message"),
    };
    let session = registry
        .read()
        .unwrap()
        .get(&session_id)
        .cloned()
        .context("unknown shared terminal session")?;
    let access = config.access_for(access_token.as_deref());
    // Attaching already performs and publishes a full refresh; render the
    // state once before acknowledging the new compact view.
    let attachment_epoch = session
        .attach_view_with_access(&view_id, &client_id, access)
        .context("attach compact terminal view")?;
    let (_, canonical_cols, canonical_rows, layout_epoch) = session.control_state();
    let presentation = (protocol_minor >= TERMINAL_PRESENTATION_PROTOCOL_MINOR)
        .then(|| host_config.borrow().as_ref().clone());
    control
        .write_compact_message(
            CompactChannel::Control,
            &SessionControlMessage::ViewAttached {
                request_id,
                session_epoch: session.session_epoch(),
                layout_epoch,
                attachment_epoch,
                cols: canonical_cols,
                rows: canonical_rows,
                read_write: access == ViewAccess::ReadWrite,
                presentation,
            },
            MAX_CONTROL_MESSAGE_BYTES,
        )
        .await
        .context("write compact view-attached response")?;

    let result = async {
        let mut controls = session.subscribe_control();
        let mut activities = session.subscribe_activity();
        let mut snapshots = session.subscribe_logical();
        let mut previous = session.logical_snapshot();
        let mut patch_sequence = 0_u64;
        if protocol_minor >= TERMINAL_PRESENTATION_PROTOCOL_MINOR {
            let presentation = host_config.borrow_and_update().as_ref().clone();
            control
                .write_compact_state_message(
                    &StateMessage::ConfigurationChanged { presentation },
                    state_codec,
                )
                .await?;
        }
        if let Some(snapshot) = previous.as_ref() {
            control
                .write_compact_state_message(
                    &StateMessage::Snapshot(snapshot.clone()),
                    state_codec,
                )
                .await?;
        }
        let (controller, cols, rows, layout_epoch) = session.control_state();
        if let Some(controller) = controller {
            control
                .write_compact_state_message(
                    &StateMessage::ControlChanged {
                        controller_view_id: controller.view_id,
                        control_epoch: controller.control_epoch,
                        cols,
                        rows,
                        layout_epoch,
                    },
                    state_codec,
                )
                .await?;
        }
        if protocol_minor >= SESSION_ACTIVITY_PROTOCOL_MINOR {
            control
                .write_compact_state_message(
                    &StateMessage::ActivityChanged {
                        activity: session.summary().activity,
                    },
                    state_codec,
                )
                .await?;
        }

        loop {
            tokio::select! {
                biased;
                changed = host_config.changed(), if protocol_minor >= TERMINAL_PRESENTATION_PROTOCOL_MINOR => {
                    changed.context("host configuration publisher closed")?;
                    let presentation = host_config.borrow_and_update().as_ref().clone();
                    control.write_compact_state_message(
                        &StateMessage::ConfigurationChanged { presentation },
                        state_codec,
                    ).await?;
                    if let Some(snapshot) = session.logical_snapshot() {
                        previous = Some(snapshot.clone());
                        patch_sequence = 0;
                        control.write_compact_state_message(
                            &StateMessage::Snapshot(snapshot),
                            state_codec,
                        ).await?;
                    }
                }
                incoming = control.read_compact_message::<SessionControlMessage>(
                    CompactChannel::Control,
                    MAX_CONTROL_MESSAGE_BYTES,
                ) => {
                    let Some(message) = incoming? else { break };
                    match message {
                        SessionControlMessage::FocusAndResize {
                            view_id: incoming_view,
                            attachment_epoch: epoch,
                            cols,
                            rows,
                            ..
                        } if incoming_view == view_id && epoch == attachment_epoch => {
                            session.claim_control(&view_id, &client_id, cols, rows)?;
                        }
                        SessionControlMessage::Resize {
                            view_id: incoming_view,
                            attachment_epoch: epoch,
                            control_epoch,
                            resize_sequence,
                            cols,
                            rows,
                        } if incoming_view == view_id && epoch == attachment_epoch => {
                            if session.resize_view(
                                &view_id,
                                &client_id,
                                control_epoch,
                                resize_sequence,
                                cols,
                                rows,
                            ).is_err() {
                                session.announce_control();
                            }
                        }
                        SessionControlMessage::Input {
                            view_id: incoming_view,
                            attachment_epoch: epoch,
                            input_sequence,
                            operation,
                        } if incoming_view == view_id && epoch == attachment_epoch => match operation {
                            TunnelInput::Text(text) => session.send_text(
                                &view_id, &client_id, attachment_epoch, input_sequence, text,
                            )?,
                            TunnelInput::Paste(text) => session.paste(
                                &view_id, &client_id, attachment_epoch, input_sequence, text,
                            )?,
                            TunnelInput::Key(input) => session.key(
                                &view_id, &client_id, attachment_epoch, input_sequence, input,
                            )?,
                            TunnelInput::Mouse(input) => session.mouse(
                                &view_id, &client_id, attachment_epoch, input_sequence, input,
                            )?,
                            TunnelInput::Scroll(rows) => session.scroll(
                                &view_id,
                                &client_id,
                                attachment_epoch,
                                input_sequence,
                                isize::try_from(rows.clamp(-10_000, 10_000))?,
                            )?,
                            TunnelInput::ScrollTo(row) => session.scroll_to(
                                &view_id,
                                &client_id,
                                attachment_epoch,
                                input_sequence,
                                usize::try_from(row)?,
                            )?,
                            TunnelInput::Focus(focused) => session.focus(
                                &view_id, &client_id, attachment_epoch, input_sequence, focused,
                            )?,
                            TunnelInput::Interrupt => session.interrupt(
                                &view_id, &client_id, attachment_epoch, input_sequence,
                            )?,
                        },
                        SessionControlMessage::RequestSnapshot => {
                            let snapshot = session
                                .logical_snapshot()
                                .context("shared terminal has no logical snapshot")?;
                            previous = Some(snapshot.clone());
                            patch_sequence = 0;
                            control.write_compact_state_message(
                                &StateMessage::Snapshot(snapshot),
                                state_codec,
                            ).await?;
                        }
                        SessionControlMessage::StateAck { .. } => {}
                        SessionControlMessage::SelectionText {
                            request_id,
                            view_id: incoming_view,
                            attachment_epoch: epoch,
                            start_column,
                            start_row,
                            end_column,
                            end_row,
                            select_all,
                        } if incoming_view == view_id && epoch == attachment_epoch => {
                            let text = session.selection_text(
                                start_column,
                                start_row,
                                end_column,
                                end_row,
                                select_all,
                            )?;
                            control.write_compact_message(
                                CompactChannel::Control,
                                &SessionControlMessage::SelectionTextResult { request_id, text },
                                MAX_CONTROL_MESSAGE_BYTES,
                            ).await?;
                        }
                        SessionControlMessage::Detach {
                            view_id: incoming_view,
                            attachment_epoch: epoch,
                        } if incoming_view == view_id && epoch == attachment_epoch => break,
                        _ => bail!("invalid, stale, or misrouted compact session message"),
                    }
                }
                snapshot = snapshots.recv() => {
                    let message = match snapshot {
                        Ok(snapshot) => {
                            let next_sequence = patch_sequence.saturating_add(1);
                            let message = previous
                                .as_ref()
                                .and_then(|previous| logical_patch(previous, &snapshot, next_sequence))
                                .map(StateMessage::Patch)
                                .unwrap_or_else(|| StateMessage::Snapshot(snapshot.clone()));
                            if matches!(message, StateMessage::Patch(_)) {
                                patch_sequence = next_sequence;
                            } else {
                                patch_sequence = 0;
                            }
                            previous = Some(snapshot);
                            message
                        }
                        Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                            let snapshot = session
                                .logical_snapshot()
                                .context("shared terminal has no logical snapshot after lag")?;
                            previous = Some(snapshot.clone());
                            patch_sequence = 0;
                            StateMessage::Snapshot(snapshot)
                        }
                        Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                    };
                    control.write_compact_state_message(
                        &message,
                        state_codec,
                    ).await?;
                }
                changed = controls.recv() => {
                    let changed = match changed {
                        Ok(changed) => changed,
                        Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                            session.announce_control();
                            continue;
                        }
                        Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                    };
                    control.write_compact_state_message(
                        &StateMessage::ControlChanged {
                            controller_view_id: changed.controller.view_id,
                            control_epoch: changed.controller.control_epoch,
                            cols: changed.cols,
                            rows: changed.rows,
                            layout_epoch: changed.layout_epoch,
                        },
                        state_codec,
                    ).await?;
                }
                changed = activities.recv(), if protocol_minor >= SESSION_ACTIVITY_PROTOCOL_MINOR => {
                    let activity = match changed {
                        Ok(activity) => activity,
                        Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                            session.announce_activity();
                            continue;
                        }
                        Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                    };
                    control.write_compact_state_message(
                        &StateMessage::ActivityChanged { activity },
                        state_codec,
                    ).await?;
                }
            }
        }
        Ok(())
    }
    .await;
    session.detach_view(&view_id, &client_id);
    result
}

async fn accept_loop(
    node: Arc<Node<TailscaleProvider>>,
    listener: Arc<truffle::transport::quic::QuicListener>,
    registry: Registry,
    config: TruffleTerminalConfig,
    host_instance_id: String,
    host_config: HostConfigReceiver,
) -> Result<()> {
    while let Some(connection) = listener.accept().await {
        let node = Arc::clone(&node);
        let registry = registry.clone();
        let config = config.clone();
        let host_instance_id = host_instance_id.clone();
        let host_config = host_config.clone();
        tokio::spawn(async move {
            if let Err(error) = handle_connection(
                node,
                Arc::new(connection),
                registry,
                config,
                host_instance_id,
                host_config,
            )
            .await
            {
                eprintln!("[terminal-mesh] rejected connection: {error:#}");
            }
        });
    }
    Ok(())
}

async fn handle_connection(
    node: Arc<Node<TailscaleProvider>>,
    connection: Arc<truffle::transport::quic::QuicConnection>,
    registry: Registry,
    config: TruffleTerminalConfig,
    host_instance_id: String,
    host_config: HostConfigReceiver,
) -> Result<()> {
    let remote_ip = connection.remote_address().ip();
    serve_connection(
        connection,
        registry,
        config,
        host_instance_id,
        Arc::new(NodeClientResolver { node }),
        Some(remote_ip),
        host_config,
    )
    .await
}

async fn serve_connection(
    connection: Arc<dyn MeshConnection>,
    registry: Registry,
    config: TruffleTerminalConfig,
    host_instance_id: String,
    resolver: Arc<dyn ClientResolver>,
    remote_ip: Option<IpAddr>,
    host_config: HostConfigReceiver,
) -> Result<()> {
    let stream = tokio::time::timeout(HANDSHAKE_TIMEOUT, connection.accept_stream())
        .await
        .context("timed out accepting connection control stream")?
        .context("accept connection control stream")?
        .context("connection closed before control handshake")?;
    let mut control = ProtocolStream::new(stream);
    let preface = tokio::time::timeout(HANDSHAKE_TIMEOUT, control.read_preface())
        .await
        .context("timed out reading connection control preface")??;
    if preface.stream_kind != StreamKind::ConnectionControl {
        bail!("first stream is not connection-control");
    }
    let hello = tokio::time::timeout(
        HANDSHAKE_TIMEOUT,
        control.read_message::<ConnectionMessage>(MAX_CONTROL_MESSAGE_BYTES),
    )
    .await
    .context("timed out reading client hello")??
    .context("connection closed before client hello")?;
    let (client_nonce, state_codec, protocol_minor, asserted_device_id) = match hello {
        ConnectionMessage::ClientHello {
            protocol_major,
            protocol_minor,
            local_device_id,
            nonce,
            state_codecs,
            ..
        } if protocol_major == PROTOCOL_MAJOR && protocol_minor > 0 => {
            let state_codec = negotiate_state_codec(state_codecs);
            (
                nonce,
                state_codec,
                protocol_minor.min(PROTOCOL_MINOR),
                local_device_id,
            )
        }
        ConnectionMessage::ClientHello { .. } => {
            bail!("client hello identity or protocol mismatch")
        }
        _ => bail!("expected client hello"),
    };
    let client_id = resolver.resolve(&asserted_device_id, remote_ip).await?;
    control
        .write_message(
            &ConnectionMessage::ServerHello {
                protocol_major: PROTOCOL_MAJOR,
                protocol_minor: PROTOCOL_MINOR,
                host_instance_id,
                nonce: client_nonce,
                state_codec: (state_codec != StateCodec::Json).then_some(state_codec),
            },
            MAX_CONTROL_MESSAGE_BYTES,
        )
        .await?;

    let streams_connection = Arc::clone(&connection);
    let streams_context = IncomingSessionContext {
        registry: registry.clone(),
        config: config.clone(),
        client_id: client_id.clone(),
        state_codec,
        protocol_minor,
        host_config,
    };
    let streams = tokio::spawn(async move {
        while let Some(stream) = streams_connection.accept_stream().await? {
            let context = streams_context.clone();
            let connection = Arc::clone(&streams_connection);
            tokio::spawn(async move {
                if let Err(error) = handle_application_stream(connection, stream, context).await {
                    eprintln!("[terminal-mesh] stream closed: {error:#}");
                }
            });
        }
        Ok::<(), anyhow::Error>(())
    });

    while let Some(message) = control
        .read_message::<ConnectionMessage>(MAX_CONTROL_MESSAGE_BYTES)
        .await?
    {
        match message {
            ConnectionMessage::ListSessions { request_id } => {
                let sessions = shared_sessions(&registry, &config);
                control
                    .write_message(
                        &ConnectionMessage::Sessions {
                            request_id,
                            sessions,
                        },
                        MAX_CONTROL_MESSAGE_BYTES,
                    )
                    .await?;
            }
            _ => {
                control
                    .write_message(
                        &ConnectionMessage::Error {
                            request_id: None,
                            code: "unexpected-message".into(),
                            message: "message is not valid on the connection control stream".into(),
                        },
                        MAX_CONTROL_MESSAGE_BYTES,
                    )
                    .await?;
            }
        }
    }
    streams.abort();
    connection.close();
    Ok(())
}

async fn handle_application_stream(
    connection: Arc<dyn MeshConnection>,
    stream: Box<dyn MeshStream>,
    context: IncomingSessionContext,
) -> Result<()> {
    let IncomingSessionContext {
        registry,
        config,
        client_id,
        state_codec,
        protocol_minor,
        host_config,
    } = context;
    let mut control = ProtocolStream::new(stream);
    let preface = control.read_preface().await?;
    if preface.stream_kind != StreamKind::SessionControl {
        bail!("peer-opened stream kind is not supported");
    }
    let session_id = preface
        .session_id
        .context("session control stream lacks session id")?;
    let attach = tokio::time::timeout(
        HANDSHAKE_TIMEOUT,
        control.read_message::<SessionControlMessage>(MAX_CONTROL_MESSAGE_BYTES),
    )
    .await
    .context("timed out reading session attach")??
    .context("session stream closed before attach")?;
    let (request_id, view_id, access_token, _cols, _rows) = match attach {
        SessionControlMessage::AttachView {
            request_id,
            session_id: requested_session,
            view_id,
            access_token,
            cols,
            rows,
        } if requested_session == session_id => (request_id, view_id, access_token, cols, rows),
        _ => bail!("expected matching attach-view message"),
    };
    let session = registry
        .read()
        .unwrap()
        .get(&session_id)
        .cloned()
        .context("unknown shared terminal session")?;
    let access = config.access_for(access_token.as_deref());
    let attachment_epoch = session.attach_view_with_access(&view_id, &client_id, access)?;
    session.refresh()?;
    let (_, canonical_cols, canonical_rows, layout_epoch) = session.control_state();
    let presentation = (protocol_minor >= TERMINAL_PRESENTATION_PROTOCOL_MINOR)
        .then(|| host_config.borrow().as_ref().clone());
    control
        .write_message(
            &SessionControlMessage::ViewAttached {
                request_id,
                session_epoch: session.session_epoch(),
                layout_epoch,
                attachment_epoch,
                cols: canonical_cols,
                rows: canonical_rows,
                read_write: access == ViewAccess::ReadWrite,
                presentation,
            },
            MAX_CONTROL_MESSAGE_BYTES,
        )
        .await?;
    let (state_cancel, state_cancelled) = tokio::sync::watch::channel(false);
    spawn_state_stream(
        Arc::clone(&connection),
        Arc::clone(&session),
        &view_id,
        state_cancelled.clone(),
        state_codec,
        protocol_minor,
        host_config.clone(),
    )
    .await?;

    let result = session_control_loop(
        &mut control,
        Arc::clone(&connection),
        Arc::clone(&session),
        &client_id,
        &view_id,
        attachment_epoch,
        StateStreamContext {
            cancelled: state_cancelled,
            codec: state_codec,
            protocol_minor,
            host_config,
        },
    )
    .await;
    state_cancel.send_replace(true);
    session.detach_view(&view_id, &client_id);
    result
}

struct StateStreamContext {
    cancelled: tokio::sync::watch::Receiver<bool>,
    codec: StateCodec,
    protocol_minor: u16,
    host_config: HostConfigReceiver,
}

async fn session_control_loop(
    control: &mut ProtocolStream,
    connection: Arc<dyn MeshConnection>,
    session: Arc<Session>,
    client_id: &str,
    attached_view_id: &str,
    attachment_epoch: u64,
    state_stream: StateStreamContext,
) -> Result<()> {
    while let Some(message) = control
        .read_message::<SessionControlMessage>(MAX_CONTROL_MESSAGE_BYTES)
        .await?
    {
        match message {
            SessionControlMessage::FocusAndResize {
                view_id,
                attachment_epoch: epoch,
                cols,
                rows,
                ..
            } if view_id == attached_view_id && epoch == attachment_epoch => {
                session.claim_control(&view_id, client_id, cols, rows)?;
            }
            SessionControlMessage::Resize {
                view_id,
                attachment_epoch: epoch,
                control_epoch,
                resize_sequence,
                cols,
                rows,
            } if view_id == attached_view_id && epoch == attachment_epoch => {
                if session
                    .resize_view(
                        &view_id,
                        client_id,
                        control_epoch,
                        resize_sequence,
                        cols,
                        rows,
                    )
                    .is_err()
                {
                    session.announce_control();
                }
            }
            SessionControlMessage::Input {
                view_id,
                attachment_epoch: epoch,
                input_sequence,
                operation,
            } if view_id == attached_view_id && epoch == attachment_epoch => match operation {
                TunnelInput::Text(text) => session.send_text(
                    &view_id,
                    client_id,
                    attachment_epoch,
                    input_sequence,
                    text,
                )?,
                TunnelInput::Paste(text) => {
                    session.paste(&view_id, client_id, attachment_epoch, input_sequence, text)?
                }
                TunnelInput::Key(input) => {
                    session.key(&view_id, client_id, attachment_epoch, input_sequence, input)?
                }
                TunnelInput::Mouse(input) => {
                    session.mouse(&view_id, client_id, attachment_epoch, input_sequence, input)?
                }
                TunnelInput::Scroll(rows) => session.scroll(
                    &view_id,
                    client_id,
                    attachment_epoch,
                    input_sequence,
                    isize::try_from(rows.clamp(-10_000, 10_000))?,
                )?,
                TunnelInput::ScrollTo(row) => session.scroll_to(
                    &view_id,
                    client_id,
                    attachment_epoch,
                    input_sequence,
                    usize::try_from(row)?,
                )?,
                TunnelInput::Focus(focused) => session.focus(
                    &view_id,
                    client_id,
                    attachment_epoch,
                    input_sequence,
                    focused,
                )?,
                TunnelInput::Interrupt => {
                    session.interrupt(&view_id, client_id, attachment_epoch, input_sequence)?
                }
            },
            SessionControlMessage::RequestSnapshot => {
                spawn_state_stream(
                    Arc::clone(&connection),
                    Arc::clone(&session),
                    attached_view_id,
                    state_stream.cancelled.clone(),
                    state_stream.codec,
                    state_stream.protocol_minor,
                    state_stream.host_config.clone(),
                )
                .await?;
            }
            SessionControlMessage::StateAck { .. } => {}
            SessionControlMessage::SelectionText {
                request_id,
                view_id,
                attachment_epoch: epoch,
                start_column,
                start_row,
                end_column,
                end_row,
                select_all,
            } if view_id == attached_view_id && epoch == attachment_epoch => {
                let text = session.selection_text(
                    start_column,
                    start_row,
                    end_column,
                    end_row,
                    select_all,
                )?;
                control
                    .write_message(
                        &SessionControlMessage::SelectionTextResult { request_id, text },
                        MAX_CONTROL_MESSAGE_BYTES,
                    )
                    .await?;
            }
            SessionControlMessage::Detach {
                view_id,
                attachment_epoch: epoch,
            } if view_id == attached_view_id && epoch == attachment_epoch => break,
            _ => bail!("invalid, stale, or misrouted session control message"),
        }
    }
    Ok(())
}

async fn spawn_state_stream(
    connection: Arc<dyn MeshConnection>,
    session: Arc<Session>,
    view_id: &str,
    mut cancelled: tokio::sync::watch::Receiver<bool>,
    state_codec: StateCodec,
    protocol_minor: u16,
    mut host_config: HostConfigReceiver,
) -> Result<()> {
    let stream = connection.open_stream().await?;
    let mut state = ProtocolStream::new(stream);
    state
        .write_preface(&StreamPreface {
            stream_kind: StreamKind::LiveState,
            session_id: Some(session.id()),
            view_id: Some(view_id.to_owned()),
        })
        .await?;
    let mut controls = session.subscribe_control();
    let mut activities = session.subscribe_activity();
    let mut snapshots = session.subscribe_logical();
    let mut previous = session.logical_snapshot();
    if protocol_minor >= TERMINAL_PRESENTATION_PROTOCOL_MINOR {
        let presentation = host_config.borrow_and_update().as_ref().clone();
        state
            .write_state_message(
                &StateMessage::ConfigurationChanged { presentation },
                state_codec,
            )
            .await?;
    }
    if let Some(snapshot) = previous.as_ref() {
        state
            .write_state_message(&StateMessage::Snapshot(snapshot.clone()), state_codec)
            .await?;
    }
    let (controller, cols, rows, layout_epoch) = session.control_state();
    if let Some(controller) = controller {
        state
            .write_state_message(
                &StateMessage::ControlChanged {
                    controller_view_id: controller.view_id,
                    control_epoch: controller.control_epoch,
                    cols,
                    rows,
                    layout_epoch,
                },
                state_codec,
            )
            .await?;
    }
    if protocol_minor >= SESSION_ACTIVITY_PROTOCOL_MINOR {
        state
            .write_state_message(
                &StateMessage::ActivityChanged {
                    activity: session.summary().activity,
                },
                state_codec,
            )
            .await?;
    }
    tokio::spawn(async move {
        let mut patch_sequence = 0_u64;
        loop {
            let message = tokio::select! {
                biased;
                changed = host_config.changed(), if protocol_minor >= TERMINAL_PRESENTATION_PROTOCOL_MINOR => {
                    if changed.is_err() {
                        break;
                    }
                    let presentation = host_config.borrow_and_update().as_ref().clone();
                    if state
                        .write_state_message(
                            &StateMessage::ConfigurationChanged { presentation },
                            state_codec,
                        )
                        .await
                        .is_err()
                    {
                        break;
                    }
                    if let Some(snapshot) = session.logical_snapshot() {
                        previous = Some(snapshot.clone());
                        patch_sequence = 0;
                        if state
                            .write_state_message(&StateMessage::Snapshot(snapshot), state_codec)
                            .await
                            .is_err()
                        {
                            break;
                        }
                    }
                    continue;
                },
                changed = cancelled.changed() => {
                    if changed.is_err() || *cancelled.borrow() {
                        break;
                    }
                    continue;
                },
                snapshot = snapshots.recv() => match snapshot {
                    Ok(snapshot) => {
                        let next_sequence = patch_sequence.saturating_add(1);
                        let message = previous
                            .as_ref()
                            .and_then(|previous| logical_patch(previous, &snapshot, next_sequence))
                            .map(StateMessage::Patch)
                            .unwrap_or_else(|| StateMessage::Snapshot(snapshot.clone()));
                        if matches!(message, StateMessage::Patch(_)) {
                            patch_sequence = next_sequence;
                        } else {
                            patch_sequence = 0;
                        }
                        previous = Some(snapshot);
                        Some(message)
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                },
                changed = controls.recv() => match changed {
                    Ok(changed) => Some(StateMessage::ControlChanged {
                        controller_view_id: changed.controller.view_id,
                        control_epoch: changed.controller.control_epoch,
                        cols: changed.cols,
                        rows: changed.rows,
                        layout_epoch: changed.layout_epoch,
                    }),
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                },
                changed = activities.recv(), if protocol_minor >= SESSION_ACTIVITY_PROTOCOL_MINOR => match changed {
                    Ok(activity) => Some(StateMessage::ActivityChanged { activity }),
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                        session.announce_activity();
                        continue;
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                },
            };
            if let Some(message) = message
                && state
                    .write_state_message(&message, state_codec)
                    .await
                    .is_err()
            {
                break;
            }
        }
    });
    Ok(())
}

fn logical_patch(
    previous: &LogicalTerminalSnapshot,
    current: &LogicalTerminalSnapshot,
    patch_sequence: u64,
) -> Option<LogicalTerminalPatch> {
    if previous.session_epoch != current.session_epoch
        || previous.layout_epoch != current.layout_epoch
        || previous.cols != current.cols
        || previous.rows.len() != current.rows.len()
        || previous.title != current.title
        || previous.cwd != current.cwd
        || current.terminal_revision <= previous.terminal_revision
    {
        return None;
    }
    let row_replacements = previous
        .rows
        .iter()
        .zip(&current.rows)
        .enumerate()
        .filter_map(|(index, (old, new))| {
            if old == new {
                return None;
            }
            Some(RowReplacement {
                row_index: u16::try_from(index).ok()?,
                row_revision: current.terminal_revision,
                row: new.clone(),
            })
        })
        .collect::<Vec<_>>();
    Some(LogicalTerminalPatch {
        session_epoch: current.session_epoch,
        layout_epoch: current.layout_epoch,
        patch_sequence,
        terminal_revision: current.terminal_revision,
        row_replacements,
        cursor: (previous.cursor != current.cursor).then_some(current.cursor),
        mouse_tracking: (previous.mouse_tracking != current.mouse_tracking)
            .then_some(current.mouse_tracking),
        scrollbar: (previous.scrollbar != current.scrollbar).then_some(current.scrollbar),
    })
}

fn shared_sessions(
    registry: &Registry,
    config: &TruffleTerminalConfig,
) -> Vec<SharedSessionSummary> {
    registry
        .read()
        .unwrap()
        .values()
        .map(|session| {
            let summary = session.summary();
            SharedSessionSummary {
                session_id: summary.id,
                title: summary.title.unwrap_or_else(|| summary.executable.clone()),
                cwd_label: summary.cwd,
                running: !summary.exited,
                attachable: true,
                read_write: config.advertises_write(),
                created_at_ms: session.created_at_ms(),
                activity: summary.activity,
            }
        })
        .collect()
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[derive(Default)]
struct ReadBuffer {
    bytes: Vec<u8>,
    start: usize,
}

impl ReadBuffer {
    fn available(&self) -> usize {
        self.bytes.len() - self.start
    }

    fn unread(&self, length: usize) -> &[u8] {
        &self.bytes[self.start..self.start + length]
    }

    fn consume(&mut self, length: usize) {
        self.start += length;
        if self.start == self.bytes.len() {
            self.bytes.clear();
            self.start = 0;
        }
    }

    fn compact(&mut self) {
        if self.start == 0 {
            return;
        }
        self.bytes.copy_within(self.start.., 0);
        self.bytes.truncate(self.available());
        self.start = 0;
    }

    fn append(&mut self, chunk: Vec<u8>) {
        if self.available() == 0 {
            self.bytes = chunk;
            self.start = 0;
            return;
        }
        self.compact();
        self.bytes.extend_from_slice(&chunk);
    }
}

struct CompactProtocolStream<S> {
    stream: S,
    buffered: ReadBuffer,
}

impl<S> CompactProtocolStream<S>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    fn new(stream: S) -> Self {
        Self {
            stream,
            buffered: ReadBuffer::default(),
        }
    }

    #[cfg(test)]
    async fn write_preface(&mut self, preface: &StreamPreface) -> Result<()> {
        self.stream.write_all(&encode_preface(preface)?).await?;
        Ok(())
    }

    async fn read_preface(&mut self) -> Result<StreamPreface> {
        if !self.fill(16).await? {
            bail!("EOF before compact-stream preface");
        }
        let metadata_len =
            u32::from_be_bytes(self.buffered.unread(16)[12..16].try_into().unwrap()) as usize;
        if metadata_len > ghosttea::tunnel_protocol::MAX_PREFACE_METADATA_BYTES {
            bail!("compact-stream preface metadata exceeds limit");
        }
        let total = 16 + metadata_len;
        if !self.fill(total).await? {
            bail!("EOF in compact-stream preface metadata");
        }
        let preface = decode_preface(self.buffered.unread(total))?.0;
        self.buffered.consume(total);
        Ok(preface)
    }

    async fn write_message<T: serde::Serialize>(
        &mut self,
        message: &T,
        limit: usize,
    ) -> Result<()> {
        self.stream
            .write_all(&encode_message(message, limit)?)
            .await?;
        Ok(())
    }

    async fn read_message<T: serde::de::DeserializeOwned>(
        &mut self,
        limit: usize,
    ) -> Result<Option<T>> {
        if !self.fill(4).await? {
            return Ok(None);
        }
        let payload_len =
            u32::from_be_bytes(self.buffered.unread(4)[..4].try_into().unwrap()) as usize;
        if payload_len > limit {
            bail!("compact-stream terminal protocol message exceeds limit");
        }
        let total = 4 + payload_len;
        if !self.fill(total).await? {
            bail!("EOF in compact-stream terminal protocol message");
        }
        let message = decode_message(self.buffered.unread(total), limit)?.0;
        self.buffered.consume(total);
        Ok(Some(message))
    }

    async fn write_compact_message<T: serde::Serialize>(
        &mut self,
        channel: CompactChannel,
        message: &T,
        limit: usize,
    ) -> Result<()> {
        self.stream
            .write_all(&encode_compact_message(channel, message, limit)?)
            .await?;
        Ok(())
    }

    async fn write_compact_state_message(
        &mut self,
        message: &StateMessage,
        codec: StateCodec,
    ) -> Result<()> {
        let encoded = encode_state_message(message, codec, MAX_STATE_MESSAGE_BYTES)?;
        let payload = &encoded[4..];
        let framed_len = payload
            .len()
            .checked_add(1)
            .context("compact state message length overflow")?;
        let mut framed = Vec::with_capacity(4 + framed_len);
        framed.extend_from_slice(&u32::try_from(framed_len)?.to_be_bytes());
        framed.push(CompactChannel::State.as_byte());
        framed.extend_from_slice(payload);
        self.stream.write_all(&framed).await?;
        Ok(())
    }

    async fn read_compact_message<T: serde::de::DeserializeOwned>(
        &mut self,
        expected_channel: CompactChannel,
        limit: usize,
    ) -> Result<Option<T>> {
        if !self.fill(4).await? {
            return Ok(None);
        }
        let framed_len =
            u32::from_be_bytes(self.buffered.unread(4)[..4].try_into().unwrap()) as usize;
        if framed_len == 0 || framed_len - 1 > limit {
            bail!("compact terminal message exceeds limit");
        }
        let total = 4 + framed_len;
        if !self.fill(total).await? {
            bail!("EOF in compact terminal protocol message");
        }
        let message =
            decode_compact_message(self.buffered.unread(total), expected_channel, limit)?.0;
        self.buffered.consume(total);
        Ok(Some(message))
    }

    async fn fill(&mut self, length: usize) -> Result<bool> {
        while self.buffered.available() < length {
            self.buffered.compact();
            self.buffered.bytes.reserve(64 * 1024);
            let read = self.stream.read_buf(&mut self.buffered.bytes).await?;
            if read == 0 {
                if self.buffered.available() == 0 {
                    return Ok(false);
                }
                bail!("truncated compact terminal stream");
            }
        }
        Ok(true)
    }
}

/// One ordered, reliable byte stream. Abstracting the transport keeps the
/// session state machine drivable in-process, where the QUIC path needs a live
/// tailnet.
#[async_trait]
trait MeshStream: Send + Sync {
    async fn read_chunk(&mut self, max_len: usize) -> Result<Option<Vec<u8>>>;
    async fn write_chunk(&mut self, data: &[u8]) -> Result<()>;
}

#[async_trait]
trait MeshConnection: Send + Sync {
    async fn open_stream(&self) -> Result<Box<dyn MeshStream>>;
    async fn accept_stream(&self) -> Result<Option<Box<dyn MeshStream>>>;
    fn close(&self);
}

#[async_trait]
impl MeshStream for QuicStream {
    async fn read_chunk(&mut self, max_len: usize) -> Result<Option<Vec<u8>>> {
        Ok(QuicStream::read(self, max_len).await?)
    }

    async fn write_chunk(&mut self, data: &[u8]) -> Result<()> {
        QuicStream::write(self, data).await?;
        Ok(())
    }
}

#[async_trait]
impl MeshConnection for truffle::transport::quic::QuicConnection {
    async fn open_stream(&self) -> Result<Box<dyn MeshStream>> {
        Ok(Box::new(
            truffle::transport::quic::QuicConnection::open_stream(self).await?,
        ))
    }

    async fn accept_stream(&self) -> Result<Option<Box<dyn MeshStream>>> {
        Ok(
            truffle::transport::quic::QuicConnection::accept_stream(self)
                .await?
                .map(|stream| Box::new(stream) as Box<dyn MeshStream>),
        )
    }

    fn close(&self) {
        truffle::transport::quic::QuicConnection::close(self);
    }
}

struct ProtocolStream {
    stream: Box<dyn MeshStream>,
    buffered: ReadBuffer,
}

impl ProtocolStream {
    fn new(stream: Box<dyn MeshStream>) -> Self {
        Self {
            stream,
            buffered: ReadBuffer::default(),
        }
    }

    async fn write_preface(&mut self, preface: &StreamPreface) -> Result<()> {
        self.stream.write_chunk(&encode_preface(preface)?).await?;
        Ok(())
    }

    async fn read_preface(&mut self) -> Result<StreamPreface> {
        if !self.fill(16).await? {
            bail!("EOF before stream preface");
        }
        let metadata_len =
            u32::from_be_bytes(self.buffered.unread(16)[12..16].try_into().unwrap()) as usize;
        if metadata_len > ghosttea::tunnel_protocol::MAX_PREFACE_METADATA_BYTES {
            bail!("stream preface metadata exceeds limit");
        }
        let total = 16 + metadata_len;
        if !self.fill(total).await? {
            bail!("EOF in stream preface metadata");
        }
        let preface = decode_preface(self.buffered.unread(total))?.0;
        self.buffered.consume(total);
        Ok(preface)
    }

    async fn write_message<T: serde::Serialize>(
        &mut self,
        message: &T,
        limit: usize,
    ) -> Result<()> {
        self.stream
            .write_chunk(&encode_message(message, limit)?)
            .await?;
        Ok(())
    }

    async fn write_state_message(
        &mut self,
        message: &StateMessage,
        codec: StateCodec,
    ) -> Result<()> {
        self.stream
            .write_chunk(&encode_state_message(
                message,
                codec,
                MAX_STATE_MESSAGE_BYTES,
            )?)
            .await?;
        Ok(())
    }

    async fn read_message<T: serde::de::DeserializeOwned>(
        &mut self,
        limit: usize,
    ) -> Result<Option<T>> {
        if !self.fill(4).await? {
            return Ok(None);
        }
        let payload_len =
            u32::from_be_bytes(self.buffered.unread(4)[..4].try_into().unwrap()) as usize;
        if payload_len > limit {
            bail!("terminal protocol message exceeds limit");
        }
        let total = 4 + payload_len;
        if !self.fill(total).await? {
            bail!("EOF in terminal protocol message");
        }
        let message = decode_message(self.buffered.unread(total), limit)?.0;
        self.buffered.consume(total);
        Ok(Some(message))
    }

    async fn read_state_message(&mut self, codec: StateCodec) -> Result<Option<StateMessage>> {
        if !self.fill(4).await? {
            return Ok(None);
        }
        let payload_len =
            u32::from_be_bytes(self.buffered.unread(4)[..4].try_into().unwrap()) as usize;
        if payload_len > MAX_STATE_MESSAGE_BYTES {
            bail!("terminal protocol state message exceeds limit");
        }
        let total = 4 + payload_len;
        if !self.fill(total).await? {
            bail!("EOF in terminal protocol state message");
        }
        let message =
            decode_state_message(self.buffered.unread(total), codec, MAX_STATE_MESSAGE_BYTES)?.0;
        self.buffered.consume(total);
        Ok(Some(message))
    }

    async fn fill(&mut self, length: usize) -> Result<bool> {
        while self.buffered.available() < length {
            match self.stream.read_chunk(64 * 1024).await? {
                Some(chunk) => self.buffered.append(chunk),
                None if self.buffered.available() == 0 => return Ok(false),
                None => bail!("truncated QUIC stream"),
            }
        }
        Ok(true)
    }
}

#[async_trait]
impl RemoteTerminalRuntime for MeshRuntime {
    fn subscribe_control(&self) -> broadcast::Receiver<RemoteControlChanged> {
        self.control_tx.subscribe()
    }

    fn subscribe_activity(&self) -> broadcast::Receiver<RemoteActivityChanged> {
        self.activity_tx.subscribe()
    }

    async fn hosts(&self) -> Result<Vec<RemoteHostSummary>> {
        MeshRuntime::hosts(self).await
    }

    async fn list_sessions(&self, device_id: &str) -> Result<Vec<SharedSessionSummary>> {
        MeshRuntime::list_sessions(self, device_id).await
    }

    async fn open_session(&self, request: RemoteSessionOpen) -> Result<SessionSummary> {
        MeshRuntime::open_session(self, request).await
    }

    async fn summaries(&self) -> Vec<SessionSummary> {
        MeshRuntime::summaries(self).await
    }

    async fn summary(&self, session_id: &str) -> Option<SessionSummary> {
        MeshRuntime::summary(self, session_id).await
    }

    async fn attach_view(&self, session_id: &str, view_id: &str) -> Result<RemoteAttachment> {
        MeshRuntime::attach_view(self, session_id, view_id).await
    }

    async fn send_input(
        &self,
        session_id: &str,
        view_id: &str,
        attachment_epoch: u64,
        input_sequence: u64,
        operation: TunnelInput,
    ) -> Result<()> {
        MeshRuntime::send_input(
            self,
            session_id,
            view_id,
            attachment_epoch,
            input_sequence,
            operation,
        )
        .await
    }

    async fn claim_control(
        &self,
        session_id: &str,
        view_id: &str,
        attachment_epoch: u64,
        cols: u16,
        rows: u16,
    ) -> Result<RemoteControlClaim> {
        MeshRuntime::claim_control(self, session_id, view_id, attachment_epoch, cols, rows).await
    }

    async fn resize(&self, session_id: &str, view_id: &str, request: RemoteResize) -> Result<()> {
        MeshRuntime::resize(self, session_id, view_id, request).await
    }

    async fn selection_text(
        &self,
        session_id: &str,
        view_id: &str,
        request: RemoteSelection,
    ) -> Result<String> {
        MeshRuntime::selection_text(self, session_id, view_id, request).await
    }

    async fn refresh(&self, session_id: &str) -> Result<()> {
        MeshRuntime::refresh(self, session_id).await
    }

    async fn refresh_remote(&self, session_id: &str) -> Result<()> {
        MeshRuntime::refresh_remote(self, session_id).await
    }

    async fn detach_view(&self, session_id: &str, view_id: &str, attachment_epoch: u64) {
        MeshRuntime::detach_view(self, session_id, view_id, attachment_epoch).await;
    }

    async fn close_session(&self, session_id: &str) -> bool {
        MeshRuntime::close_session(self, session_id).await
    }

    fn subscribe_lifecycle(&self) -> broadcast::Receiver<RemoteLifecycleChanged> {
        self.lifecycle_tx.subscribe()
    }

    fn subscribe_view_state(&self) -> broadcast::Receiver<RemoteViewStateChanged> {
        self.view_state_tx.subscribe()
    }

    async fn session_lifecycle(&self, session_id: &str) -> Option<RemoteSessionLifecycle> {
        MeshRuntime::session_lifecycle(self, session_id).await
    }

    async fn current_attachment(&self, session_id: &str, view_id: &str) -> Option<(u64, bool)> {
        MeshRuntime::current_attachment(self, session_id, view_id).await
    }

    async fn reconnect_session(&self, session_id: &str) -> Result<RemoteSessionLifecycle> {
        MeshRuntime::reconnect_session(self, session_id).await
    }

    async fn probe_connection(&self, device_id: &str) -> Result<()> {
        MeshRuntime::probe_connection(self, device_id).await
    }

    async fn offline_selection_text(
        &self,
        session_id: &str,
        request: RemoteSelection,
    ) -> Result<String> {
        MeshRuntime::offline_selection_text(self, session_id, request).await
    }
}

#[async_trait]
impl TerminalMesh for TruffleTerminalMesh {
    fn runtime(&self) -> Arc<dyn RemoteTerminalRuntime> {
        Arc::new(self.runtime())
    }

    async fn serve(
        self: Box<Self>,
        registry: Registry,
        host_config: HostConfigReceiver,
    ) -> Result<()> {
        TruffleTerminalMesh::serve(*self, registry, host_config).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn logical_snapshot(revision: u64, text: &str) -> LogicalTerminalSnapshot {
        LogicalTerminalSnapshot {
            session_epoch: 1,
            layout_epoch: 2,
            terminal_revision: revision,
            cols: 80,
            rows: vec![ghosttea::tunnel_protocol::LogicalRow {
                text: text.into(),
                cells: vec![],
            }],
            cursor: ghosttea::tunnel_protocol::LogicalCursor::default(),
            mouse_tracking: false,
            scrollbar: ghosttea::tunnel_protocol::LogicalScrollbar::default(),
            title: Some("terminal".into()),
            cwd: Some("/tmp".into()),
        }
    }

    #[test]
    fn terminal_access_policy_requires_an_explicit_write_grant() {
        let config = TruffleTerminalConfig {
            service_name: "terminal.test".into(),
            quic_port: DEFAULT_QUIC_PORT,
            compact_port: DEFAULT_COMPACT_PORT,
            capability: Some("secret".into()),
            allow_tailnet_write: false,
            reconnect: MeshReconnectConfig::default(),
        };
        assert_eq!(config.access_for(None), ViewAccess::ReadOnly);
        assert_eq!(config.access_for(Some("wrong")), ViewAccess::ReadOnly);
        assert_eq!(config.access_for(Some("secret")), ViewAccess::ReadWrite);
    }

    #[test]
    fn terminal_service_scope_and_port_are_validated() {
        let node_free = TruffleTerminalConfig {
            service_name: " ".into(),
            ..TruffleTerminalConfig::default()
        };
        assert!(node_free.validate().is_err());
        let zero_port = TruffleTerminalConfig {
            quic_port: 0,
            ..TruffleTerminalConfig::default()
        };
        assert!(zero_port.validate().is_err());
        let same_ports = TruffleTerminalConfig {
            compact_port: DEFAULT_QUIC_PORT,
            ..TruffleTerminalConfig::default()
        };
        assert!(same_ports.validate().is_err());
    }

    #[test]
    fn compact_state_codec_is_used_only_when_the_peer_offers_it() {
        assert_eq!(negotiate_state_codec(None), StateCodec::Json);
        assert_eq!(
            negotiate_state_codec(Some(vec![StateCodec::Json])),
            StateCodec::Json
        );
        assert_eq!(
            negotiate_state_codec(Some(vec![StateCodec::Json, StateCodec::CompactJsonV1])),
            StateCodec::CompactJsonV1
        );
    }

    #[tokio::test]
    async fn compact_stream_frames_negotiated_state_payloads() {
        let (server_io, mut client_io) = tokio::io::duplex(4096);
        let mut server = CompactProtocolStream::new(server_io);
        server
            .write_compact_state_message(
                &StateMessage::ControlChanged {
                    controller_view_id: "view".into(),
                    control_epoch: 9,
                    cols: 120,
                    rows: 40,
                    layout_epoch: 3,
                },
                StateCodec::CompactJsonV1,
            )
            .await
            .unwrap();

        let mut header = [0_u8; 4];
        client_io.read_exact(&mut header).await.unwrap();
        let framed_len = u32::from_be_bytes(header) as usize;
        let mut framed = vec![0_u8; framed_len];
        client_io.read_exact(&mut framed).await.unwrap();
        assert_eq!(framed[0], CompactChannel::State.as_byte());
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&framed[1..]).unwrap(),
            serde_json::json!({"c": ["view", 9, 120, 40, 3]})
        );
    }

    #[tokio::test]
    async fn compact_stream_handshake_and_session_listing_match_apple_client() {
        let (server_io, client_io) = tokio::io::duplex(64 * 1024);
        let registry = Registry::default();
        let server = tokio::spawn(handle_compact_protocol(
            server_io,
            registry,
            TruffleTerminalConfig::default(),
            "desktop-instance".into(),
            Some("ios-device".into()),
            "truffle:peer:1".into(),
            tokio::sync::watch::channel(Arc::new(
                ghosttea::ConfigSnapshot::default().terminal_presentation(),
            ))
            .1,
        ));
        let mut client = CompactProtocolStream::new(client_io);
        client
            .write_preface(&StreamPreface {
                stream_kind: StreamKind::ConnectionControl,
                session_id: None,
                view_id: None,
            })
            .await
            .unwrap();
        client
            .write_message(
                &ConnectionMessage::ClientHello {
                    protocol_major: PROTOCOL_MAJOR,
                    protocol_minor: PROTOCOL_MINOR,
                    host_instance_id: String::new(),
                    local_device_id: "ios-device".into(),
                    nonce: "fixed-nonce".into(),
                    state_codecs: Some(vec![StateCodec::CompactJsonV1]),
                },
                MAX_CONTROL_MESSAGE_BYTES,
            )
            .await
            .unwrap();
        let hello = client
            .read_message::<ConnectionMessage>(MAX_CONTROL_MESSAGE_BYTES)
            .await
            .unwrap()
            .unwrap();
        assert!(matches!(
            hello,
            ConnectionMessage::ServerHello {
                protocol_major: PROTOCOL_MAJOR,
                protocol_minor: PROTOCOL_MINOR,
                ref host_instance_id,
                ref nonce,
                state_codec: Some(StateCodec::CompactJsonV1),
            } if host_instance_id == "desktop-instance" && nonce == "fixed-nonce"
        ));

        client
            .write_message(
                &ConnectionMessage::ListSessions {
                    request_id: "request-1".into(),
                },
                MAX_CONTROL_MESSAGE_BYTES,
            )
            .await
            .unwrap();
        let sessions = client
            .read_message::<ConnectionMessage>(MAX_CONTROL_MESSAGE_BYTES)
            .await
            .unwrap()
            .unwrap();
        assert!(matches!(
            sessions,
            ConnectionMessage::Sessions {
                ref request_id,
                ref sessions,
            } if request_id == "request-1" && sessions.is_empty()
        ));
        drop(client);
        server.await.unwrap().unwrap();
    }

    #[tokio::test]
    async fn compact_stream_rejects_a_claim_that_conflicts_with_confirmed_peer_identity() {
        let (server_io, client_io) = tokio::io::duplex(64 * 1024);
        let server = tokio::spawn(handle_compact_protocol(
            server_io,
            Registry::default(),
            TruffleTerminalConfig::default(),
            "desktop-instance".into(),
            Some("expected-device".into()),
            "truffle:peer:1".into(),
            tokio::sync::watch::channel(Arc::new(
                ghosttea::ConfigSnapshot::default().terminal_presentation(),
            ))
            .1,
        ));
        let mut client = CompactProtocolStream::new(client_io);
        client
            .write_preface(&StreamPreface {
                stream_kind: StreamKind::ConnectionControl,
                session_id: None,
                view_id: None,
            })
            .await
            .unwrap();
        client
            .write_message(
                &ConnectionMessage::ClientHello {
                    protocol_major: PROTOCOL_MAJOR,
                    protocol_minor: PROTOCOL_MINOR,
                    host_instance_id: String::new(),
                    local_device_id: "claimed-device".into(),
                    nonce: "fixed-nonce".into(),
                    state_codecs: None,
                },
                MAX_CONTROL_MESSAGE_BYTES,
            )
            .await
            .unwrap();
        drop(client);
        assert!(server.await.unwrap().is_err());
    }

    #[test]
    fn connection_cache_requires_health_and_the_current_host_generation() {
        assert!(connection_is_reusable("host-a", true, "host-a"));
        assert!(!connection_is_reusable("host-a", false, "host-a"));
        assert!(!connection_is_reusable("host-a", true, "host-b"));
    }

    #[test]
    fn logical_state_uses_patches_only_with_a_compatible_baseline() {
        let previous = logical_snapshot(4, "before");
        let current = logical_snapshot(5, "after");
        let patch = logical_patch(&previous, &current, 1).unwrap();
        assert_eq!(patch.patch_sequence, 1);
        assert_eq!(patch.row_replacements.len(), 1);
        assert_eq!(patch.row_replacements[0].row.text, "after");

        let mut resized = current;
        resized.layout_epoch += 1;
        assert!(logical_patch(&previous, &resized, 1).is_none());
    }

    // ── Phase-1 reconnect harness ────────────────────────────────────────
    //
    // The QUIC path needs a live tailnet, so the session state machine is
    // exercised over an in-process transport that speaks the same protocol
    // against the same unmodified host code.

    const TEST_DEVICE: &str = "studio-device";

    struct LoopbackStream {
        io: tokio::io::DuplexStream,
        closed: tokio::sync::watch::Receiver<bool>,
    }

    #[async_trait]
    impl MeshStream for LoopbackStream {
        async fn read_chunk(&mut self, max_len: usize) -> Result<Option<Vec<u8>>> {
            if *self.closed.borrow() {
                bail!("loopback connection closed");
            }
            let mut buffer = vec![0_u8; max_len.min(64 * 1024)];
            let read = tokio::select! {
                _ = self.closed.changed() => bail!("loopback connection closed"),
                read = self.io.read(&mut buffer) => read?,
            };
            if read == 0 {
                return Ok(None);
            }
            buffer.truncate(read);
            Ok(Some(buffer))
        }

        async fn write_chunk(&mut self, data: &[u8]) -> Result<()> {
            if *self.closed.borrow() {
                bail!("loopback connection closed");
            }
            self.io.write_all(data).await?;
            Ok(())
        }
    }

    struct LoopbackConnection {
        outgoing: tokio::sync::mpsc::UnboundedSender<tokio::io::DuplexStream>,
        incoming: tokio::sync::Mutex<tokio::sync::mpsc::UnboundedReceiver<tokio::io::DuplexStream>>,
        closed: tokio::sync::watch::Sender<bool>,
    }

    #[async_trait]
    impl MeshConnection for LoopbackConnection {
        async fn open_stream(&self) -> Result<Box<dyn MeshStream>> {
            if *self.closed.borrow() {
                bail!("loopback connection closed");
            }
            let (near, far) = tokio::io::duplex(256 * 1024);
            self.outgoing
                .send(far)
                .map_err(|_| anyhow::anyhow!("loopback peer is gone"))?;
            Ok(Box::new(LoopbackStream {
                io: near,
                closed: self.closed.subscribe(),
            }))
        }

        async fn accept_stream(&self) -> Result<Option<Box<dyn MeshStream>>> {
            let mut closed = self.closed.subscribe();
            if *closed.borrow() {
                return Ok(None);
            }
            let mut incoming = self.incoming.lock().await;
            let stream = tokio::select! {
                _ = closed.changed() => return Ok(None),
                stream = incoming.recv() => stream,
            };
            Ok(stream.map(|io| {
                Box::new(LoopbackStream {
                    io,
                    closed: self.closed.subscribe(),
                }) as Box<dyn MeshStream>
            }))
        }

        fn close(&self) {
            self.closed.send_replace(true);
        }
    }

    /// Each endpoint owns its close flag. Closing the server side is an
    /// orderly death the host observes; closing only the client side strands
    /// the host's handlers on streams that will never speak again, which is
    /// the black hole the zombie purge exists for.
    fn loopback_pair() -> (Arc<LoopbackConnection>, Arc<LoopbackConnection>) {
        let (client_tx, server_rx) = tokio::sync::mpsc::unbounded_channel();
        let (server_tx, client_rx) = tokio::sync::mpsc::unbounded_channel();
        (
            Arc::new(LoopbackConnection {
                outgoing: client_tx,
                incoming: tokio::sync::Mutex::new(client_rx),
                closed: tokio::sync::watch::channel(false).0,
            }),
            Arc::new(LoopbackConnection {
                outgoing: server_tx,
                incoming: tokio::sync::Mutex::new(server_rx),
                closed: tokio::sync::watch::channel(false).0,
            }),
        )
    }

    struct TestTransportState {
        /// `None` models an expired or missing advertisement.
        advertised: Option<String>,
        online: bool,
        queued: std::collections::VecDeque<Arc<RemoteHostConnection>>,
        dials: u32,
    }

    struct TestTransport {
        state: SyncMutex<TestTransportState>,
    }

    impl TestTransport {
        fn new(advertised: &str) -> Arc<Self> {
            Arc::new(Self {
                state: SyncMutex::new(TestTransportState {
                    advertised: Some(advertised.to_owned()),
                    online: true,
                    queued: std::collections::VecDeque::new(),
                    dials: 0,
                }),
            })
        }

        fn queue(&self, connection: Arc<RemoteHostConnection>) {
            self.state.lock().unwrap().queued.push_back(connection);
        }

        fn advertise(&self, host_instance_id: Option<&str>) {
            self.state.lock().unwrap().advertised = host_instance_id.map(str::to_owned);
        }

        fn set_online(&self, online: bool) {
            self.state.lock().unwrap().online = online;
        }

        fn dials(&self) -> u32 {
            self.state.lock().unwrap().dials
        }
    }

    #[async_trait]
    impl HostTransport for TestTransport {
        fn capability(&self) -> Option<String> {
            None
        }

        async fn device_name(&self, _device_id: &str) -> Option<String> {
            Some("studio-mac".into())
        }

        async fn peer_is_online(&self, _device_id: &str) -> bool {
            self.state.lock().unwrap().online
        }

        async fn host_instance_id(&self, _device_id: &str) -> Result<String> {
            self.state
                .lock()
                .unwrap()
                .advertised
                .clone()
                .context("terminal host advertisement has expired")
        }

        async fn dial(&self, _device_id: &str) -> Result<Arc<RemoteHostConnection>> {
            let mut state = self.state.lock().unwrap();
            state.dials += 1;
            state
                .queued
                .pop_front()
                .context("test transport has no connection to hand out")
        }
    }

    /// A host that completes the attach handshake but releases each view's
    /// first snapshot only on command, so tests can hold a session inside the
    /// window between `ViewAttached` and synchronization.
    #[derive(Clone, Default)]
    struct SnapshotGate {
        held: Arc<SyncMutex<std::collections::HashSet<String>>>,
        released: Arc<tokio::sync::Notify>,
    }

    impl SnapshotGate {
        fn hold(&self, local_view_id: &str) {
            self.held.lock().unwrap().insert(local_view_id.to_owned());
        }

        fn release(&self, local_view_id: &str) {
            self.held.lock().unwrap().remove(local_view_id);
            self.released.notify_waiters();
        }

        async fn wait(&self, wire_view_id: &str) {
            let Some(local) = local_view_id_from_wire(wire_view_id) else {
                return;
            };
            loop {
                let waiter = self.released.notified();
                if !self.held.lock().unwrap().contains(&local) {
                    return;
                }
                waiter.await;
            }
        }
    }

    async fn serve_scripted_host(
        connection: Arc<dyn MeshConnection>,
        host_instance_id: String,
        remote_session_id: String,
        gate: SnapshotGate,
    ) -> Result<()> {
        let control_stream = connection
            .accept_stream()
            .await?
            .context("scripted host got no control stream")?;
        let mut control = ProtocolStream::new(control_stream);
        let preface = control.read_preface().await?;
        if preface.stream_kind != StreamKind::ConnectionControl {
            bail!("scripted host expected a connection-control stream");
        }
        let nonce = match control
            .read_message::<ConnectionMessage>(MAX_CONTROL_MESSAGE_BYTES)
            .await?
            .context("scripted host got no client hello")?
        {
            ConnectionMessage::ClientHello { nonce, .. } => nonce,
            _ => bail!("scripted host expected a client hello"),
        };
        control
            .write_message(
                &ConnectionMessage::ServerHello {
                    protocol_major: PROTOCOL_MAJOR,
                    protocol_minor: PROTOCOL_MINOR,
                    host_instance_id,
                    nonce,
                    state_codec: Some(StateCodec::CompactJsonV1),
                },
                MAX_CONTROL_MESSAGE_BYTES,
            )
            .await?;

        let session = remote_session_id.clone();
        let streams_connection = Arc::clone(&connection);
        let streams = tokio::spawn(async move {
            let mut epoch = 0_u64;
            while let Some(stream) = streams_connection.accept_stream().await? {
                let mut view_control = ProtocolStream::new(stream);
                let preface = view_control.read_preface().await?;
                if preface.stream_kind != StreamKind::SessionControl {
                    continue;
                }
                let (request_id, wire_view_id) = match view_control
                    .read_message::<SessionControlMessage>(MAX_CONTROL_MESSAGE_BYTES)
                    .await?
                    .context("scripted host got no attach")?
                {
                    SessionControlMessage::AttachView {
                        request_id,
                        view_id,
                        ..
                    } => (request_id, view_id),
                    _ => bail!("scripted host expected an attach"),
                };
                epoch += 1;
                view_control
                    .write_message(
                        &SessionControlMessage::ViewAttached {
                            request_id,
                            session_epoch: 1,
                            layout_epoch: 1,
                            attachment_epoch: epoch,
                            cols: 80,
                            rows: 24,
                            read_write: true,
                            presentation: None,
                        },
                        MAX_CONTROL_MESSAGE_BYTES,
                    )
                    .await?;
                let mut state = ProtocolStream::new(streams_connection.open_stream().await?);
                state
                    .write_preface(&StreamPreface {
                        stream_kind: StreamKind::LiveState,
                        session_id: Some(session.clone()),
                        view_id: Some(wire_view_id.clone()),
                    })
                    .await?;
                let gate = gate.clone();
                tokio::spawn(async move {
                    gate.wait(&wire_view_id).await;
                    let _ = state
                        .write_state_message(
                            &StateMessage::Snapshot(logical_snapshot(1, "scripted")),
                            StateCodec::CompactJsonV1,
                        )
                        .await;
                    // Hold the stream open; a dropped stream would read as a
                    // disconnect rather than a quiet host.
                    std::future::pending::<()>().await;
                });
                tokio::spawn(async move {
                    while view_control
                        .read_message::<SessionControlMessage>(MAX_CONTROL_MESSAGE_BYTES)
                        .await
                        .is_ok_and(|message| message.is_some())
                    {}
                });
            }
            Ok::<(), anyhow::Error>(())
        });

        while let Some(message) = control
            .read_message::<ConnectionMessage>(MAX_CONTROL_MESSAGE_BYTES)
            .await?
        {
            if let ConnectionMessage::ListSessions { request_id } = message {
                control
                    .write_message(
                        &ConnectionMessage::Sessions {
                            request_id,
                            sessions: vec![SharedSessionSummary {
                                session_id: remote_session_id.clone(),
                                title: "scripted".into(),
                                cwd_label: None,
                                running: true,
                                attachable: true,
                                read_write: true,
                                created_at_ms: 0,
                                activity: ghosttea::SessionActivity::default(),
                            }],
                        },
                        MAX_CONTROL_MESSAGE_BYTES,
                    )
                    .await?;
            }
        }
        streams.abort();
        Ok(())
    }

    /// The loopback transport carries no tailnet identity, so tests assert the
    /// client id directly.
    struct StaticClientResolver(&'static str);

    #[async_trait]
    impl ClientResolver for StaticClientResolver {
        async fn resolve(&self, _device_id: &str, _remote_ip: Option<IpAddr>) -> Result<String> {
            Ok(self.0.to_owned())
        }
    }

    struct LoopbackHost {
        server: Arc<LoopbackConnection>,
        task: tokio::task::JoinHandle<Result<()>>,
        _presentation: tokio::sync::watch::Sender<Arc<TerminalPresentationConfig>>,
    }

    impl LoopbackHost {
        /// Sever the transport the way a host disappearance does: existing
        /// streams break, and nothing new can be sent.
        fn kill(&self) {
            self.server.close();
            self.task.abort();
        }
    }

    /// A viewer-side connection wired to the real host protocol handler over
    /// the in-process transport.
    async fn connect_loopback(
        registry: &Registry,
        host_instance_id: &str,
    ) -> Result<(Arc<RemoteHostConnection>, LoopbackHost)> {
        let (client, server) = loopback_pair();
        let (presentation, presentation_rx) = tokio::sync::watch::channel(Arc::new(
            ghosttea::ConfigSnapshot::default().terminal_presentation(),
        ));
        let task = tokio::spawn(serve_connection(
            Arc::clone(&server) as Arc<dyn MeshConnection>,
            registry.clone(),
            TruffleTerminalConfig {
                allow_tailnet_write: true,
                ..TruffleTerminalConfig::default()
            },
            host_instance_id.to_owned(),
            Arc::new(StaticClientResolver("truffle:peer:1")) as Arc<dyn ClientResolver>,
            None,
            presentation_rx,
        ));
        let connection = client_handshake(
            client as Arc<dyn MeshConnection>,
            "viewer-device",
            "viewer-instance",
            host_instance_id,
        )
        .await?;
        Ok((
            connection,
            LoopbackHost {
                server,
                task,
                _presentation: presentation,
            },
        ))
    }

    /// A quiet, long-lived PTY child for the harness to attach to. `cat` idles
    /// reading stdin on Unix; the Windows integration fixtures already prove
    /// the command shell is spawnable there, and it idles the same way.
    fn idle_child_executable() -> String {
        #[cfg(unix)]
        {
            "/bin/cat".to_owned()
        }
        #[cfg(windows)]
        {
            std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".to_owned())
        }
    }

    fn spawn_host_session(registry: &Registry) -> Result<String> {
        let session = Session::spawn(
            ghosttea::session::SpawnOptions {
                executable: idle_child_executable(),
                args: Vec::new(),
                cwd: None,
                env: std::collections::HashMap::new(),
                environment: None,
                cols: 80,
                rows: 24,
                persistence: ghosttea::session::Persistence::TerminateWithApp,
                program_kind: ghosttea::SessionProgramKind::default(),
                owner_id: None,
            },
            ghosttea::FrameHub::new(8),
            Arc::new(std::sync::Mutex::new(
                ghosttea::TextEngine::discover().context("discover text engine")?,
            )),
            Arc::new(|_, _| {}),
        )?;
        let id = session.id();
        registry.write().unwrap().insert(id.clone(), session);
        Ok(id)
    }

    /// Auto-resume parked immediately, so tests that are not about the engine
    /// see a deterministic resting state instead of a background dial loop.
    fn quiet_reconnect() -> MeshReconnectConfig {
        MeshReconnectConfig {
            suspend_after: Duration::ZERO,
            advertisement_fast_path: false,
            zombie_purge: false,
            ..MeshReconnectConfig::default()
        }
    }

    struct Fixture {
        runtime: MeshRuntime,
        transport: Arc<TestTransport>,
        registry: Registry,
        remote_session_id: String,
        session_id: String,
        hosts: Vec<LoopbackHost>,
    }

    impl Fixture {
        /// An open remote session with one attached view, live.
        async fn attached() -> Result<Self> {
            Self::attached_with(quiet_reconnect()).await
        }

        async fn attached_with(config: MeshReconnectConfig) -> Result<Self> {
            let registry = Registry::default();
            let remote_session_id = spawn_host_session(&registry)?;
            let transport = TestTransport::new("host-1");
            let runtime = MeshRuntime::new();
            runtime.set_reconnect_config(config);
            runtime
                .install_transport(Arc::clone(&transport) as Arc<dyn HostTransport>)
                .await;
            let (connection, host) = connect_loopback(&registry, "host-1").await?;
            transport.queue(connection);

            let summary = runtime
                .open_session(RemoteSessionOpen {
                    device_id: TEST_DEVICE.into(),
                    remote_session_id: remote_session_id.clone(),
                    cols: 80,
                    rows: 24,
                    owner_id: None,
                    frames: ghosttea::FrameHub::new(8),
                    text_engine: Arc::new(std::sync::Mutex::new(
                        ghosttea::TextEngine::discover().context("discover text engine")?,
                    )),
                })
                .await?;
            let fixture = Self {
                runtime,
                transport,
                registry,
                remote_session_id,
                session_id: summary.id,
                hosts: vec![host],
            };
            fixture
                .runtime
                .attach_view(&fixture.session_id, "pane-1")
                .await?;
            Ok(fixture)
        }

        /// An open remote session whose host withholds snapshots until told.
        /// Returns before the first view has attached.
        async fn scripted(gate: SnapshotGate) -> Result<Self> {
            let registry = Registry::default();
            let remote_session_id = "scripted-session".to_owned();
            let transport = TestTransport::new("host-1");
            let runtime = MeshRuntime::new();
            runtime.set_reconnect_config(quiet_reconnect());
            runtime
                .install_transport(Arc::clone(&transport) as Arc<dyn HostTransport>)
                .await;

            let (client, server) = loopback_pair();
            let (presentation, _presentation_rx) = tokio::sync::watch::channel(Arc::new(
                ghosttea::ConfigSnapshot::default().terminal_presentation(),
            ));
            let task = tokio::spawn(serve_scripted_host(
                Arc::clone(&server) as Arc<dyn MeshConnection>,
                "host-1".into(),
                remote_session_id.clone(),
                gate,
            ));
            let connection = client_handshake(
                client as Arc<dyn MeshConnection>,
                "viewer-device",
                "viewer-instance",
                "host-1",
            )
            .await?;
            transport.queue(connection);

            let summary = runtime
                .open_session(RemoteSessionOpen {
                    device_id: TEST_DEVICE.into(),
                    remote_session_id: remote_session_id.clone(),
                    cols: 80,
                    rows: 24,
                    owner_id: None,
                    frames: ghosttea::FrameHub::new(8),
                    text_engine: Arc::new(std::sync::Mutex::new(
                        ghosttea::TextEngine::discover().context("discover text engine")?,
                    )),
                })
                .await?;
            Ok(Self {
                runtime,
                transport,
                registry,
                remote_session_id,
                session_id: summary.id,
                hosts: vec![LoopbackHost {
                    server,
                    task,
                    _presentation: presentation,
                }],
            })
        }

        async fn feed_view_id(&self) -> Option<String> {
            self.runtime
                .replicas
                .read()
                .await
                .get(&self.session_id)?
                .lifecycle
                .feed_view_id()
        }

        /// How many of this session's live readers publish into the replica.
        async fn feed_reader_count(&self) -> usize {
            self.runtime
                .views
                .lock()
                .await
                .iter()
                .filter(|((session, _), view)| session == &self.session_id && view.feed)
                .count()
        }

        async fn view_state(&self, local_view_id: &str) -> Option<RemoteViewState> {
            self.lifecycle()
                .await
                .views
                .into_iter()
                .find(|view| view.local_view_id == local_view_id)
                .map(|view| view.view_state)
        }

        async fn wait_for_view(&self, local_view_id: &str, state: RemoteViewState) -> Result<()> {
            for _ in 0..200 {
                if self.view_state(local_view_id).await == Some(state) {
                    return Ok(());
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            bail!("view {local_view_id} never reached {state:?}")
        }

        /// Queue a fresh host connection for the next dial.
        async fn arm_host(&mut self, host_instance_id: &str) -> Result<()> {
            let (connection, host) = connect_loopback(&self.registry, host_instance_id).await?;
            self.transport.queue(connection);
            self.hosts.push(host);
            Ok(())
        }

        fn kill_host(&self) {
            for host in &self.hosts {
                host.kill();
            }
        }

        /// Sever the viewer's end without telling the host, so its handlers
        /// keep every attachment they hold.
        async fn black_hole(&self) {
            if let Some(host) = self.runtime.cached_connection(TEST_DEVICE).await {
                host.connection.close();
            }
        }

        async fn lifecycle(&self) -> RemoteSessionLifecycle {
            self.runtime
                .session_lifecycle(&self.session_id)
                .await
                .expect("session lifecycle")
        }

        async fn retained_snapshot(&self) -> Option<LogicalTerminalSnapshot> {
            self.runtime
                .replicas
                .read()
                .await
                .get(&self.session_id)
                .and_then(|remote| remote.replica.retained_snapshot())
        }

        async fn await_first_snapshot(&self) -> Result<LogicalTerminalSnapshot> {
            for _ in 0..200 {
                if let Some(snapshot) = self.retained_snapshot().await {
                    return Ok(snapshot);
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            bail!("replica never received a snapshot")
        }

        async fn wait_for_state(&self, state: RemoteLifecycleState) -> Result<()> {
            for _ in 0..200 {
                if self.lifecycle().await.state == state {
                    return Ok(());
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            bail!(
                "session never reached {state:?}; it is {:?}",
                self.lifecycle().await.state
            )
        }
    }

    #[test]
    fn rotated_wire_ids_stay_inside_the_host_view_id_cap() {
        let short = "pane-1";
        let first = wire_view_id(short, 1);
        let second = wire_view_id(short, 2);
        assert_eq!(first, "r:pane-1#g1");
        assert_ne!(first, second);

        let long = "p".repeat(128);
        let hashed = wire_view_id(&long, 7);
        assert!(hashed.starts_with("h:"));
        assert!(hashed.len() <= 128);
        assert_ne!(hashed, wire_view_id(&long, 8));
        assert_ne!(wire_view_id(&long, 7), wire_view_id(&"q".repeat(128), 7));

        // The widest possible inline id still fits once the prefix and a
        // u64-sized generation suffix are added.
        let widest = wire_view_id(&"p".repeat(MAX_INLINE_LOCAL_VIEW_ID_BYTES), u64::MAX);
        assert!(widest.starts_with("r:"));
        assert!(widest.len() <= 128);
    }

    #[test]
    fn raw_and_hashed_wire_namespaces_cannot_collide() {
        // A short local id literally equal to another id's hash would share a
        // base without the namespace prefixes.
        let long = "z".repeat(200);
        let hashed = wire_view_id(&long, 3);
        let impostor = hashed
            .strip_prefix("h:")
            .and_then(|rest| rest.split_once("#g"))
            .map(|(base, _)| base.to_owned())
            .expect("hashed wire id shape");
        assert_ne!(wire_view_id(&impostor, 3), hashed);
        assert_eq!(local_view_id_from_wire(&hashed), None);
        assert_eq!(
            local_view_id_from_wire("r:pane-1#g4").as_deref(),
            Some("pane-1")
        );
    }

    #[test]
    fn end_reasons_are_claimed_only_on_listing_evidence() {
        let listed = |attachable, running| SharedSessionSummary {
            session_id: "s".into(),
            title: "t".into(),
            cwd_label: None,
            running,
            attachable,
            read_write: true,
            created_at_ms: 0,
            activity: ghosttea::SessionActivity::default(),
        };
        assert_eq!(ended_reason_from_listing(Some(&listed(true, true))), None);
        // Exited but still attachable resumes normally; exitedness is process
        // metadata, not a lifecycle verdict.
        assert_eq!(ended_reason_from_listing(Some(&listed(true, false))), None);
        assert_eq!(
            ended_reason_from_listing(Some(&listed(false, false))),
            Some(RemoteEndedReason::SessionExited)
        );
        assert_eq!(
            ended_reason_from_listing(Some(&listed(false, true))),
            Some(RemoteEndedReason::SessionClosed)
        );
        assert_eq!(
            ended_reason_from_listing(None),
            Some(RemoteEndedReason::SessionUnavailable)
        );
    }

    #[test]
    fn advertisement_expiry_is_a_probe_trigger() {
        let advertisement = |expires_at_ms| TerminalHostAdvertisement {
            protocol_major: PROTOCOL_MAJOR,
            protocol_minor: PROTOCOL_MINOR,
            quic_port: DEFAULT_QUIC_PORT,
            host_instance_id: "host-1".into(),
            published_at_ms: 0,
            expires_at_ms,
            sessions: Vec::new(),
        };
        assert_eq!(
            advertisement_probe_candidate(
                &StoreEvent::PeerRemoved {
                    device_id: TEST_DEVICE.into()
                },
                1_000
            )
            .as_deref(),
            Some(TEST_DEVICE)
        );
        assert_eq!(
            advertisement_probe_candidate(
                &StoreEvent::PeerUpdated {
                    device_id: TEST_DEVICE.into(),
                    data: advertisement(500),
                    version: 1,
                },
                1_000
            )
            .as_deref(),
            Some(TEST_DEVICE)
        );
        assert_eq!(
            advertisement_probe_candidate(
                &StoreEvent::PeerUpdated {
                    device_id: TEST_DEVICE.into(),
                    data: advertisement(5_000),
                    version: 1,
                },
                1_000
            ),
            None
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn attaching_a_remote_view_reports_live_with_a_wire_identity() -> Result<()> {
        let fixture = Fixture::attached().await?;
        let lifecycle = fixture.lifecycle().await;
        assert_eq!(lifecycle.state, RemoteLifecycleState::Live);
        assert_eq!(lifecycle.device_name, "studio-mac");
        assert_eq!(lifecycle.views.len(), 1);
        let view = &lifecycle.views[0];
        assert_eq!(view.local_view_id, "pane-1");
        assert_eq!(view.view_state, RemoteViewState::Attached);
        assert!(view.attachment_epoch.is_some());
        assert_eq!(view.read_write, Some(true));

        // The host only ever saw the rotated identity.
        let wire = fixture
            .runtime
            .views
            .lock()
            .await
            .get(&(fixture.session_id.clone(), "pane-1".to_owned()))
            .map(|view| view.wire_view_id.clone())
            .expect("attached view");
        assert_eq!(wire, "r:pane-1#g1");
        Ok(())
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_dead_connection_suspends_the_session_and_rejects_input() -> Result<()> {
        let fixture = Fixture::attached().await?;
        let mut lifecycles = fixture.runtime.subscribe_lifecycle();
        let epoch = fixture
            .runtime
            .current_attachment(&fixture.session_id, "pane-1")
            .await
            .expect("attached epoch")
            .0;

        fixture.kill_host();
        fixture
            .wait_for_state(RemoteLifecycleState::Suspended)
            .await?;

        let event = loop {
            let event = tokio::time::timeout(Duration::from_secs(5), lifecycles.recv()).await??;
            if event.state == RemoteLifecycleState::Suspended {
                break event;
            }
        };
        assert_eq!(event.session_id, fixture.session_id);
        assert_eq!(event.device_id, TEST_DEVICE);
        assert_eq!(event.device_name, "studio-mac");
        assert_eq!(event.reason, None);
        assert_eq!(event.exit, None);
        // Phase 1 schedules nothing: Suspended is a resting state, not a
        // countdown.
        assert_eq!(event.next_retry_ms, None);
        assert!(event.last_contact_ms.is_some());

        // The view is no longer attached, so there is no epoch to speak with
        // and input fails cleanly rather than being queued or panicking.
        assert!(
            fixture
                .runtime
                .current_attachment(&fixture.session_id, "pane-1")
                .await
                .is_none()
        );
        let rejected = fixture
            .runtime
            .send_input(
                &fixture.session_id,
                "pane-1",
                epoch,
                1,
                TunnelInput::Text("rm -rf tmp\n".into()),
            )
            .await;
        assert!(rejected.is_err());
        assert_eq!(
            fixture.lifecycle().await.views[0].view_state,
            RemoteViewState::Pending
        );
        Ok(())
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn one_shot_resume_reattaches_under_a_fresh_epoch_and_generation() -> Result<()> {
        let mut fixture = Fixture::attached().await?;
        fixture.await_first_snapshot().await?;
        let before = fixture
            .runtime
            .current_attachment(&fixture.session_id, "pane-1")
            .await
            .expect("attached epoch")
            .0;
        let before_seq = fixture.lifecycle().await.lifecycle_seq;
        let dials_before = fixture.transport.dials();

        fixture.kill_host();
        fixture
            .wait_for_state(RemoteLifecycleState::Suspended)
            .await?;
        fixture.arm_host("host-1").await?;

        let resumed = fixture
            .runtime
            .reconnect_session(&fixture.session_id)
            .await?;
        assert_eq!(resumed.state, RemoteLifecycleState::Live);
        assert!(resumed.lifecycle_seq > before_seq);
        // Exactly one dial: Phase 1 is a one-shot resume, not an engine.
        assert_eq!(fixture.transport.dials(), dials_before + 1);
        // Live is reported only after the recovery snapshot has applied.
        assert!(fixture.retained_snapshot().await.is_some());

        let (after, read_write) = fixture
            .runtime
            .current_attachment(&fixture.session_id, "pane-1")
            .await
            .expect("resumed epoch");
        assert!(read_write);
        assert_ne!(after, before);

        // Rotation means the host minted a new identity, so the epoch is new
        // and the old one is dead.
        let wire = fixture
            .runtime
            .views
            .lock()
            .await
            .get(&(fixture.session_id.clone(), "pane-1".to_owned()))
            .map(|view| view.wire_view_id.clone())
            .expect("resumed view");
        assert_eq!(wire, "r:pane-1#g2");

        fixture
            .runtime
            .send_input(
                &fixture.session_id,
                "pane-1",
                after,
                1,
                TunnelInput::Text("ok".into()),
            )
            .await?;
        assert!(
            fixture
                .runtime
                .send_input(
                    &fixture.session_id,
                    "pane-1",
                    before,
                    2,
                    TunnelInput::Text("stale".into()),
                )
                .await
                .is_err()
        );
        Ok(())
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_restarted_host_ends_the_session_without_dialing() -> Result<()> {
        let fixture = Fixture::attached().await?;
        fixture.kill_host();
        fixture
            .wait_for_state(RemoteLifecycleState::Suspended)
            .await?;

        let dials = fixture.transport.dials();
        fixture.transport.advertise(Some("host-2"));
        let resumed = fixture
            .runtime
            .reconnect_session(&fixture.session_id)
            .await?;
        assert_eq!(resumed.state, RemoteLifecycleState::Ended);
        assert_eq!(resumed.reason, Some(RemoteEndedReason::HostRestarted));
        assert_eq!(fixture.transport.dials(), dials);
        Ok(())
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_session_absent_from_the_listing_ends_as_unavailable() -> Result<()> {
        let mut fixture = Fixture::attached().await?;
        fixture.kill_host();
        fixture
            .wait_for_state(RemoteLifecycleState::Suspended)
            .await?;

        fixture
            .registry
            .write()
            .unwrap()
            .remove(&fixture.remote_session_id);
        fixture.arm_host("host-1").await?;

        let resumed = fixture
            .runtime
            .reconnect_session(&fixture.session_id)
            .await?;
        assert_eq!(resumed.state, RemoteLifecycleState::Ended);
        assert_eq!(resumed.reason, Some(RemoteEndedReason::SessionUnavailable));
        Ok(())
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_listing_showing_an_exited_unattachable_session_ends_as_exited() -> Result<()> {
        let fixture = Fixture::attached().await?;
        fixture.kill_host();
        fixture
            .wait_for_state(RemoteLifecycleState::Suspended)
            .await?;

        fixture
            .runtime
            .reconcile_evidence(
                TEST_DEVICE,
                &[SharedSessionSummary {
                    session_id: fixture.remote_session_id.clone(),
                    title: "cat".into(),
                    cwd_label: None,
                    running: false,
                    attachable: false,
                    read_write: true,
                    created_at_ms: 0,
                    activity: ghosttea::SessionActivity::default(),
                }],
            )
            .await;
        let lifecycle = fixture.lifecycle().await;
        assert_eq!(lifecycle.state, RemoteLifecycleState::Ended);
        assert_eq!(lifecycle.reason, Some(RemoteEndedReason::SessionExited));
        Ok(())
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn input_is_rejected_while_a_view_is_attached_but_the_session_is_not_live() -> Result<()>
    {
        let fixture = Fixture::attached().await?;
        let (epoch, _) = fixture
            .runtime
            .current_attachment(&fixture.session_id, "pane-1")
            .await
            .expect("attached epoch");
        let lifecycle = fixture
            .runtime
            .replicas
            .read()
            .await
            .get(&fixture.session_id)
            .map(|remote| Arc::clone(&remote.lifecycle))
            .expect("session lifecycle");

        // The host sends ViewAttached before it opens the state stream, so a
        // view can be attached while recovery is still in flight.
        lifecycle.commit_synchronizing();
        let typed = fixture
            .runtime
            .send_input(
                &fixture.session_id,
                "pane-1",
                epoch,
                1,
                TunnelInput::Text("rm -rf tmp\n".into()),
            )
            .await;
        assert!(typed.is_err());
        assert!(
            fixture
                .runtime
                .resize(
                    &fixture.session_id,
                    "pane-1",
                    RemoteResize {
                        attachment_epoch: epoch,
                        control_epoch: 1,
                        resize_sequence: 1,
                        cols: 90,
                        rows: 30,
                    },
                )
                .await
                .is_err()
        );

        lifecycle.commit_live();
        fixture
            .runtime
            .send_input(
                &fixture.session_id,
                "pane-1",
                epoch,
                2,
                TunnelInput::Text("ok".into()),
            )
            .await?;
        Ok(())
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn an_initial_open_stays_synchronizing_until_its_first_snapshot() -> Result<()> {
        let gate = SnapshotGate::default();
        gate.hold("pane-1");
        let fixture = Fixture::scripted(gate.clone()).await?;

        let session_id = fixture.session_id.clone();
        let runtime = fixture.runtime.clone();
        let attaching =
            tokio::spawn(async move { runtime.attach_view(&session_id, "pane-1").await });

        // The host answered ViewAttached, but the authoritative screen does not
        // exist yet — the session must not claim to be live.
        fixture
            .wait_for_state(RemoteLifecycleState::Synchronizing)
            .await?;
        assert!(
            fixture
                .runtime
                .send_input(
                    &fixture.session_id,
                    "pane-1",
                    1,
                    1,
                    TunnelInput::Text("rm -rf tmp\n".into()),
                )
                .await
                .is_err(),
            "input was accepted before the first snapshot"
        );

        gate.release("pane-1");
        let attachment = attaching.await??;
        fixture.wait_for_state(RemoteLifecycleState::Live).await?;
        assert!(fixture.retained_snapshot().await.is_some());
        fixture
            .runtime
            .send_input(
                &fixture.session_id,
                "pane-1",
                attachment.attachment_epoch,
                1,
                TunnelInput::Text("ok".into()),
            )
            .await?;
        Ok(())
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_feed_that_never_synchronizes_leaves_nothing_attached() -> Result<()> {
        let gate = SnapshotGate::default();
        gate.hold("pane-1");
        let fixture = Fixture::scripted(gate.clone()).await?;
        fixture
            .runtime
            .set_synchronize_timeout(Duration::from_millis(150));

        assert!(
            fixture
                .runtime
                .attach_view(&fixture.session_id, "pane-1")
                .await
                .is_err()
        );
        fixture
            .wait_for_state(RemoteLifecycleState::Suspended)
            .await?;
        // The abandoned attempt must leave no attachment behind and no reader
        // able to touch the replica the user has been told is frozen.
        assert_eq!(
            fixture
                .runtime
                .current_attachment(&fixture.session_id, "pane-1")
                .await,
            None
        );
        assert_eq!(fixture.feed_reader_count().await, 0);

        gate.release("pane-1");
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert!(
            fixture.retained_snapshot().await.is_none(),
            "a late snapshot mutated the frozen replica"
        );
        assert_eq!(
            fixture.view_state("pane-1").await,
            Some(RemoteViewState::Pending)
        );
        Ok(())
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn detaching_a_secondary_leaves_the_session_and_its_feed_alone() -> Result<()> {
        let fixture = Fixture::attached().await?;
        fixture
            .runtime
            .attach_view(&fixture.session_id, "pane-2")
            .await?;
        assert_eq!(fixture.feed_view_id().await.as_deref(), Some("pane-1"));
        let feed_epoch = fixture
            .runtime
            .current_attachment(&fixture.session_id, "pane-1")
            .await
            .expect("feed attachment");
        let secondary_epoch = fixture
            .runtime
            .current_attachment(&fixture.session_id, "pane-2")
            .await
            .expect("secondary attachment")
            .0;

        fixture
            .runtime
            .detach_view(&fixture.session_id, "pane-2", secondary_epoch)
            .await;
        tokio::time::sleep(Duration::from_millis(100)).await;

        // A deliberate detach is the caller's intent, not a disconnect.
        assert_eq!(fixture.lifecycle().await.state, RemoteLifecycleState::Live);
        assert_eq!(
            fixture
                .runtime
                .current_attachment(&fixture.session_id, "pane-1")
                .await,
            Some(feed_epoch)
        );
        assert_eq!(fixture.feed_reader_count().await, 1);
        Ok(())
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_resumed_multi_view_session_publishes_from_exactly_one_stream() -> Result<()> {
        let mut fixture = Fixture::attached().await?;
        fixture
            .runtime
            .attach_view(&fixture.session_id, "pane-2")
            .await?;
        fixture.await_first_snapshot().await?;

        fixture.kill_host();
        fixture
            .wait_for_state(RemoteLifecycleState::Suspended)
            .await?;
        fixture.arm_host("host-1").await?;

        let resumed = fixture
            .runtime
            .reconnect_session(&fixture.session_id)
            .await?;
        assert_eq!(resumed.state, RemoteLifecycleState::Live);
        // Live is gated on the feed alone; secondaries attach behind it.
        assert_eq!(fixture.feed_view_id().await.as_deref(), Some("pane-1"));
        assert_eq!(
            fixture.view_state("pane-1").await,
            Some(RemoteViewState::Attached)
        );
        fixture
            .wait_for_view("pane-2", RemoteViewState::Attached)
            .await?;

        // Two publishing readers would interleave independent patch sequences
        // into the one replica.
        assert_eq!(fixture.feed_reader_count().await, 1);

        // The surviving feed still tracks the host, and nothing corrupted it.
        let session = fixture
            .registry
            .read()
            .unwrap()
            .get(&fixture.remote_session_id)
            .cloned()
            .expect("host session");
        let feed_wire = fixture
            .runtime
            .views
            .lock()
            .await
            .get(&(fixture.session_id.clone(), "pane-1".to_owned()))
            .map(|view| view.wire_view_id.clone())
            .expect("feed view");
        session.claim_control(&feed_wire, "truffle:peer:1", 100, 30)?;
        for _ in 0..200 {
            let summary = fixture
                .runtime
                .replicas
                .read()
                .await
                .get(&fixture.session_id)
                .map(|remote| remote.replica.summary())
                .expect("session");
            if (summary.cols, summary.rows) == (100, 30) {
                return Ok(());
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        bail!("the resumed feed never applied the host's resize")
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_stalled_secondary_never_gates_the_session() -> Result<()> {
        let gate = SnapshotGate::default();
        let fixture = Fixture::scripted(gate.clone()).await?;
        fixture
            .runtime
            .attach_view(&fixture.session_id, "pane-1")
            .await?;
        fixture.wait_for_state(RemoteLifecycleState::Live).await?;

        // This pane's stream will never produce a snapshot.
        gate.hold("pane-2");
        let mut lifecycles = fixture.runtime.subscribe_lifecycle();
        fixture
            .runtime
            .attach_view(&fixture.session_id, "pane-2")
            .await?;

        // A secondary is not the feed, so it neither waits for a snapshot nor
        // pulls the session back through Synchronizing.
        assert_eq!(fixture.lifecycle().await.state, RemoteLifecycleState::Live);
        assert_eq!(
            fixture.view_state("pane-2").await,
            Some(RemoteViewState::Attached)
        );
        assert_eq!(fixture.feed_reader_count().await, 1);
        while let Ok(event) = lifecycles.try_recv() {
            assert_ne!(
                event.state,
                RemoteLifecycleState::Synchronizing,
                "a secondary pulled the session back into synchronizing"
            );
        }
        gate.release("pane-2");
        Ok(())
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn detaching_the_feed_promotes_a_survivor_and_resynchronizes() -> Result<()> {
        let fixture = Fixture::attached().await?;
        fixture
            .runtime
            .attach_view(&fixture.session_id, "pane-2")
            .await?;
        assert_eq!(fixture.feed_view_id().await.as_deref(), Some("pane-1"));
        let feed_epoch = fixture
            .runtime
            .current_attachment(&fixture.session_id, "pane-1")
            .await
            .expect("feed attachment")
            .0;

        fixture
            .runtime
            .detach_view(&fixture.session_id, "pane-1", feed_epoch)
            .await;

        // Promotion is a generation-advanced re-attach, so the survivor gets a
        // fresh stream and a full snapshot rather than an in-place switch.
        assert_eq!(fixture.feed_view_id().await.as_deref(), Some("pane-2"));
        assert_eq!(fixture.lifecycle().await.state, RemoteLifecycleState::Live);
        assert_eq!(fixture.feed_reader_count().await, 1);
        assert!(
            fixture
                .runtime
                .current_attachment(&fixture.session_id, "pane-2")
                .await
                .is_some()
        );
        assert!(fixture.retained_snapshot().await.is_some());
        Ok(())
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_lapsed_advertisement_probes_without_any_discovery_event() -> Result<()> {
        let fixture = Fixture::attached().await?;
        // A fresh advertisement is not a probe trigger.
        fixture.runtime.probe_lapsed_advertisements().await;
        assert_eq!(fixture.lifecycle().await.state, RemoteLifecycleState::Live);
        assert!(
            fixture
                .runtime
                .lapsed_advertisement_devices()
                .await
                .is_empty()
        );

        // A host process can stall while its device stays online: no store
        // event ever fires, the advertisement just ages out.
        fixture.transport.advertise(None);
        assert_eq!(
            fixture.runtime.lapsed_advertisement_devices().await,
            vec![TEST_DEVICE.to_owned()]
        );
        fixture.kill_host();
        fixture.runtime.probe_lapsed_advertisements().await;
        fixture
            .wait_for_state(RemoteLifecycleState::Suspended)
            .await?;
        Ok(())
    }

    /// An engine that retries fast enough for a test to watch it work.
    fn eager_reconnect() -> MeshReconnectConfig {
        MeshReconnectConfig {
            backoff_base: Duration::from_millis(10),
            backoff_cap: Duration::from_millis(40),
            backoff_floor: Duration::from_millis(5),
            suspend_after: Duration::from_secs(60),
            advertisement_fast_path: true,
            zombie_purge: false,
            ..MeshReconnectConfig::default()
        }
    }

    #[test]
    fn full_jitter_backoff_stays_inside_its_doubling_window() {
        let config = MeshReconnectConfig::default();
        // The window doubles per attempt and is then capped; every sample
        // lands inside it, floored so a hot loop cannot form.
        for attempt in 0..12_u32 {
            let window = config
                .backoff_base
                .saturating_mul(2_u32.saturating_pow(attempt))
                .min(config.backoff_cap);
            for _ in 0..64 {
                let delay = backoff_delay(&config, attempt, &uniform_jitter());
                assert!(
                    delay >= config.backoff_floor,
                    "attempt {attempt}: {delay:?}"
                );
                assert!(
                    delay <= window.max(config.backoff_floor),
                    "attempt {attempt}: {delay:?} exceeds {window:?}"
                );
            }
        }
        // Full jitter, not equal jitter: the samples must actually spread.
        let late = (0..256)
            .map(|_| backoff_delay(&config, 8, &uniform_jitter()))
            .collect::<Vec<_>>();
        let spread = late
            .iter()
            .max()
            .unwrap()
            .saturating_sub(*late.iter().min().unwrap());
        assert!(
            spread > Duration::from_secs(1),
            "samples barely varied: {spread:?}"
        );
    }

    /// A runtime wired to a test transport, with no session opened yet.
    async fn bare_runtime() -> (MeshRuntime, Arc<TestTransport>) {
        let transport = TestTransport::new("host-1");
        let runtime = MeshRuntime::new();
        runtime.set_reconnect_config(quiet_reconnect());
        runtime
            .install_transport(Arc::clone(&transport) as Arc<dyn HostTransport>)
            .await;
        (runtime, transport)
    }

    struct RefusingClientResolver;

    #[async_trait]
    impl ClientResolver for RefusingClientResolver {
        async fn resolve(&self, _device_id: &str, _remote_ip: Option<IpAddr>) -> Result<String> {
            bail!("client hello asserts a device that is not a current Truffle peer")
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_client_whose_identity_does_not_resolve_gets_no_server_hello() -> Result<()> {
        let (client, server) = loopback_pair();
        let (_presentation, presentation_rx) = tokio::sync::watch::channel(Arc::new(
            ghosttea::ConfigSnapshot::default().terminal_presentation(),
        ));
        let host = tokio::spawn(serve_connection(
            Arc::clone(&server) as Arc<dyn MeshConnection>,
            Registry::default(),
            TruffleTerminalConfig::default(),
            "host-1".into(),
            Arc::new(RefusingClientResolver) as Arc<dyn ClientResolver>,
            None,
            presentation_rx,
        ));
        // Identity now rides the hello, so an unresolvable device must be
        // refused there rather than being handed a session surface.
        assert!(
            client_handshake(
                client as Arc<dyn MeshConnection>,
                "viewer-device",
                "viewer-instance",
                "host-1",
            )
            .await
            .is_err()
        );
        assert!(host.await?.is_err());
        Ok(())
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_connection_that_breaks_after_dialing_is_evicted() -> Result<()> {
        let registry = Registry::default();
        spawn_host_session(&registry)?;
        let (runtime, transport) = bare_runtime().await;

        // A connection that completes its handshake and only then dies —
        // exactly what a dial at a host that is about to stop responding
        // produces.
        let (dead, dead_host) = connect_loopback(&registry, "host-1").await?;
        transport.queue(dead);
        dead_host.kill();

        assert!(runtime.list_sessions_once(TEST_DEVICE).await.is_err());
        // Nothing may keep it: cached and still flagged healthy, it would be
        // handed to every later caller, including ones that must dial fresh.
        assert!(
            runtime.cached_connection(TEST_DEVICE).await.is_none(),
            "a broken connection stayed in the cache"
        );

        let (live, _live_host) = connect_loopback(&registry, "host-1").await?;
        transport.queue(live);
        assert_eq!(runtime.list_sessions_once(TEST_DEVICE).await?.len(), 1);
        Ok(())
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn concurrent_dials_converge_on_one_connection() -> Result<()> {
        let registry = Registry::default();
        spawn_host_session(&registry)?;
        let (runtime, transport) = bare_runtime().await;
        let (first, _first_host) = connect_loopback(&registry, "host-1").await?;
        let (second, _second_host) = connect_loopback(&registry, "host-1").await?;
        transport.queue(first);
        transport.queue(second);

        // Dialing happens off the cache lock, so two callers can be in flight
        // at once; they must still end up sharing one published connection
        // rather than clobbering each other.
        let left = runtime.clone();
        let right = runtime.clone();
        let (left, right) = tokio::join!(
            async move { left.remote_connection(TEST_DEVICE).await },
            async move { right.remote_connection(TEST_DEVICE).await },
        );
        let (left, right) = (left?, right?);
        let cached = runtime
            .cached_connection(TEST_DEVICE)
            .await
            .expect("a connection is published");
        assert!(
            Arc::ptr_eq(&left, &right),
            "callers got different connections"
        );
        assert!(
            Arc::ptr_eq(&left, &cached),
            "the cache holds a third connection"
        );
        Ok(())
    }

    /// Always takes the whole window, so a schedule is exactly predictable.
    fn full_window_jitter() -> JitterSource {
        Arc::new(|window| window)
    }

    #[test]
    fn an_injected_sampler_makes_the_schedule_exact() {
        let config = MeshReconnectConfig {
            backoff_base: Duration::from_millis(100),
            backoff_cap: Duration::from_millis(400),
            backoff_floor: Duration::from_millis(50),
            ..MeshReconnectConfig::default()
        };
        let jitter = full_window_jitter();
        let schedule = (0..5)
            .map(|attempt| backoff_delay(&config, attempt, &jitter).as_millis())
            .collect::<Vec<_>>();
        // Doubling until the cap, then held there.
        assert_eq!(schedule, vec![100, 200, 400, 400, 400]);

        // The floor wins over a sampler that returns nothing, so no schedule
        // can degenerate into a hot loop.
        let zero: JitterSource = Arc::new(|_| Duration::ZERO);
        assert_eq!(backoff_delay(&config, 0, &zero), Duration::from_millis(50));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn the_engine_follows_the_scheduled_delays_it_announces() -> Result<()> {
        let fixture = Fixture::attached_with(MeshReconnectConfig {
            backoff_base: Duration::from_millis(60),
            backoff_cap: Duration::from_millis(240),
            backoff_floor: Duration::from_millis(10),
            suspend_after: Duration::from_secs(60),
            advertisement_fast_path: false,
            zombie_purge: false,
            ..MeshReconnectConfig::default()
        })
        .await?;
        fixture.runtime.set_jitter(full_window_jitter());
        let mut lifecycles = fixture.runtime.subscribe_lifecycle();

        fixture.kill_host();
        let mut schedule = Vec::new();
        while schedule.len() < 4 {
            let event = tokio::time::timeout(Duration::from_secs(5), lifecycles.recv()).await??;
            if event.state == RemoteLifecycleState::Reconnecting
                && let Some(delay) = event.next_retry_ms
            {
                schedule.push((event.attempt, delay));
            }
        }
        // Exactly the doubling-then-capped sequence, announced with a real
        // attempt counter rather than a placeholder.
        assert_eq!(schedule, vec![(1, 60), (2, 120), (3, 240), (4, 240)]);
        Ok(())
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_manual_retry_joins_the_engine_instead_of_replacing_it() -> Result<()> {
        // A backoff long enough that only the manual retry can drive an attempt.
        let mut fixture = Fixture::attached_with(MeshReconnectConfig {
            backoff_base: Duration::from_secs(30),
            backoff_cap: Duration::from_secs(30),
            backoff_floor: Duration::from_secs(30),
            suspend_after: Duration::from_secs(600),
            advertisement_fast_path: true,
            zombie_purge: false,
            ..MeshReconnectConfig::default()
        })
        .await?;
        let lifecycle = fixture
            .runtime
            .replicas
            .read()
            .await
            .get(&fixture.session_id)
            .map(|remote| Arc::clone(&remote.lifecycle))
            .expect("session lifecycle");

        fixture.kill_host();
        fixture
            .wait_for_state(RemoteLifecycleState::Reconnecting)
            .await?;
        let dials = fixture.transport.dials();

        // No host queued, so this attempt fails — but it must happen now
        // rather than in 30 s, and it must not disarm the engine behind it.
        assert!(
            fixture
                .runtime
                .reconnect_session(&fixture.session_id)
                .await
                .is_err()
        );
        assert!(
            fixture.transport.dials() > dials,
            "manual retry never dialed"
        );
        assert!(
            lifecycle.has_engine(),
            "a manual retry cancelled the auto-resume engine"
        );

        // The engine is still the thing that finishes the job.
        fixture.arm_host("host-1").await?;
        fixture.runtime.note_device_available(TEST_DEVICE);
        fixture.wait_for_state(RemoteLifecycleState::Live).await?;
        assert_eq!(fixture.feed_reader_count().await, 1);
        Ok(())
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn detaching_the_last_view_stops_the_engine() -> Result<()> {
        let fixture = Fixture::attached_with(eager_reconnect()).await?;
        let lifecycle = fixture
            .runtime
            .replicas
            .read()
            .await
            .get(&fixture.session_id)
            .map(|remote| Arc::clone(&remote.lifecycle))
            .expect("session lifecycle");

        fixture.kill_host();
        fixture
            .wait_for_state(RemoteLifecycleState::Reconnecting)
            .await?;
        assert!(lifecycle.has_engine());

        // The pane is gone, so there is nothing left to resume. The view is
        // already out of the map here, which is exactly the case that used to
        // slip past the bookkeeping.
        fixture
            .runtime
            .detach_view(&fixture.session_id, "pane-1", 0)
            .await;
        assert!(!lifecycle.has_engine(), "the engine outlived its last view");
        tokio::time::sleep(Duration::from_millis(150)).await;
        let settled = fixture.transport.dials();
        tokio::time::sleep(Duration::from_millis(250)).await;
        assert_eq!(
            fixture.transport.dials(),
            settled,
            "kept dialing for no views"
        );
        Ok(())
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_purge_evicts_every_stranded_generation() -> Result<()> {
        let mut fixture = Fixture::attached().await?;
        fixture.await_first_snapshot().await?;
        // Strand several identities. A rotation on a *live* connection is
        // reaped by the host the moment the old control stream closes, so the
        // only way to accumulate zombies is the way a real outage does it:
        // connections that die before the host notices.
        for _ in 0..3 {
            fixture.black_hole().await;
            fixture
                .wait_for_state(RemoteLifecycleState::Suspended)
                .await?;
            fixture.arm_host("host-1").await?;
            fixture
                .runtime
                .reconnect_session(&fixture.session_id)
                .await?;
        }
        let lifecycle = fixture
            .runtime
            .replicas
            .read()
            .await
            .get(&fixture.session_id)
            .map(|remote| Arc::clone(&remote.lifecycle))
            .expect("session lifecycle");
        let stranded = lifecycle.purgeable_generations();
        assert_eq!(stranded, vec![("pane-1".to_owned(), 1, 3)]);

        // Now let a resume run with the purge armed.
        fixture.runtime.set_reconnect_config(MeshReconnectConfig {
            zombie_purge: true,
            ..quiet_reconnect()
        });
        fixture.black_hole().await;
        fixture
            .wait_for_state(RemoteLifecycleState::Suspended)
            .await?;
        fixture.arm_host("host-1").await?;
        fixture
            .runtime
            .reconnect_session(&fixture.session_id)
            .await?;

        for _ in 0..300 {
            if lifecycle.purgeable_generations().is_empty() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        // An empty range means every one of those generations completed a real
        // attach / drain / detach round-trip against the host: a rejected or
        // hung purge leaves `oldest_unpurged` where it was.
        assert!(
            lifecycle.purgeable_generations().is_empty(),
            "stranded generations survived the purge: {:?}",
            lifecycle.purgeable_generations()
        );
        // Draining each transient state stream matters: left in the accept
        // queue one would be handed to the next attach as a misrouted feed.
        assert_eq!(fixture.feed_reader_count().await, 1);
        assert_eq!(fixture.lifecycle().await.state, RemoteLifecycleState::Live);
        Ok(())
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn lifecycle_sequences_stay_monotonic_across_repeated_outages() -> Result<()> {
        let mut fixture = Fixture::attached_with(eager_reconnect()).await?;
        let mut lifecycles = fixture.runtime.subscribe_lifecycle();

        for _ in 0..3 {
            fixture.kill_host();
            fixture
                .wait_for_state(RemoteLifecycleState::Reconnecting)
                .await?;
            fixture.arm_host("host-1").await?;
            fixture.wait_for_state(RemoteLifecycleState::Live).await?;
        }

        let mut last = 0;
        let mut seen = 0;
        while let Ok(event) = lifecycles.try_recv() {
            assert!(
                event.lifecycle_seq > last,
                "sequence regressed across an engine restart: {event:?}"
            );
            last = event.lifecycle_seq;
            seen += 1;
        }
        assert!(seen >= 6, "expected several transitions, saw {seen}");
        Ok(())
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_lost_host_is_resumed_without_anyone_asking() -> Result<()> {
        let mut fixture = Fixture::attached_with(eager_reconnect()).await?;
        fixture.await_first_snapshot().await?;
        let before = fixture
            .runtime
            .current_attachment(&fixture.session_id, "pane-1")
            .await
            .expect("attached epoch")
            .0;

        fixture.kill_host();
        // Teardown hands off to the engine rather than resting: Phase 2's
        // whole point is that nobody has to press anything.
        fixture
            .wait_for_state(RemoteLifecycleState::Reconnecting)
            .await?;
        fixture.arm_host("host-1").await?;

        fixture.wait_for_state(RemoteLifecycleState::Live).await?;
        let after = fixture
            .runtime
            .current_attachment(&fixture.session_id, "pane-1")
            .await
            .expect("resumed epoch")
            .0;
        assert_ne!(after, before);
        assert!(fixture.retained_snapshot().await.is_some());
        let lifecycle = fixture.lifecycle().await;
        assert_eq!(lifecycle.next_retry_ms, None);
        assert_eq!(lifecycle.attempt, 0);
        Ok(())
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_returning_advertisement_short_circuits_the_backoff() -> Result<()> {
        // A backoff long enough that only the fast path can rescue the test.
        let mut fixture = Fixture::attached_with(MeshReconnectConfig {
            backoff_base: Duration::from_secs(30),
            backoff_cap: Duration::from_secs(30),
            backoff_floor: Duration::from_secs(30),
            suspend_after: Duration::from_secs(600),
            advertisement_fast_path: true,
            zombie_purge: false,
            ..MeshReconnectConfig::default()
        })
        .await?;
        fixture.kill_host();
        fixture
            .wait_for_state(RemoteLifecycleState::Reconnecting)
            .await?;
        let scheduled = fixture.lifecycle().await.next_retry_ms;
        assert!(
            scheduled.is_some_and(|delay| delay >= 30_000),
            "expected a long scheduled retry, got {scheduled:?}"
        );

        fixture.arm_host("host-1").await?;
        fixture.runtime.note_device_available(TEST_DEVICE);
        fixture.wait_for_state(RemoteLifecycleState::Live).await?;
        Ok(())
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_provably_absent_device_is_not_dialed() -> Result<()> {
        let mut fixture = Fixture::attached_with(eager_reconnect()).await?;
        fixture.transport.set_online(false);
        fixture.transport.advertise(None);
        assert!(fixture.runtime.dial_is_pointless(TEST_DEVICE).await);

        fixture.kill_host();
        fixture
            .wait_for_state(RemoteLifecycleState::Reconnecting)
            .await?;
        let dials = fixture.transport.dials();
        // Arm a host the engine must not reach for: discovery says the device
        // is gone, so the scheduled dials are declined until it reappears.
        fixture.arm_host("host-1").await?;
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert_eq!(fixture.transport.dials(), dials, "dialed an absent device");
        assert_eq!(
            fixture.lifecycle().await.state,
            RemoteLifecycleState::Reconnecting
        );

        // Discovery says it is back; the same schedule now dials.
        fixture.transport.set_online(true);
        fixture.transport.advertise(Some("host-1"));
        assert!(!fixture.runtime.dial_is_pointless(TEST_DEVICE).await);
        fixture.wait_for_state(RemoteLifecycleState::Live).await?;
        Ok(())
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_long_absence_rests_in_suspended_and_wakes_on_return() -> Result<()> {
        let mut fixture = Fixture::attached_with(MeshReconnectConfig {
            backoff_base: Duration::from_millis(10),
            backoff_cap: Duration::from_millis(20),
            backoff_floor: Duration::from_millis(5),
            suspend_after: Duration::from_millis(80),
            advertisement_fast_path: true,
            zombie_purge: false,
            ..MeshReconnectConfig::default()
        })
        .await?;
        fixture.kill_host();

        // The engine burns dials for suspend_after, then stops: Suspended
        // costs zero network, but the watcher stays.
        fixture
            .wait_for_state(RemoteLifecycleState::Suspended)
            .await?;
        assert_eq!(fixture.lifecycle().await.next_retry_ms, None);
        let resting = fixture.transport.dials();
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert_eq!(
            fixture.transport.dials(),
            resting,
            "a suspended session kept dialing"
        );

        fixture.arm_host("host-1").await?;
        fixture.runtime.note_device_available(TEST_DEVICE);
        fixture.wait_for_state(RemoteLifecycleState::Live).await?;
        Ok(())
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn reconnecting_events_carry_a_real_attempt_and_countdown() -> Result<()> {
        let fixture = Fixture::attached_with(MeshReconnectConfig {
            backoff_base: Duration::from_millis(40),
            backoff_cap: Duration::from_millis(80),
            backoff_floor: Duration::from_millis(20),
            suspend_after: Duration::from_secs(60),
            advertisement_fast_path: false,
            zombie_purge: false,
            ..MeshReconnectConfig::default()
        })
        .await?;
        let mut lifecycles = fixture.runtime.subscribe_lifecycle();

        fixture.kill_host();
        let mut attempts = Vec::new();
        while attempts.len() < 3 {
            let event = tokio::time::timeout(Duration::from_secs(5), lifecycles.recv()).await??;
            if event.state == RemoteLifecycleState::Reconnecting
                && let Some(delay) = event.next_retry_ms
            {
                attempts.push((event.attempt, delay));
            }
        }
        // The counter is real, and each wait is a genuine sampled delay
        // rather than the Phase-1 placeholder null.
        assert_eq!(
            attempts
                .iter()
                .map(|(attempt, _)| *attempt)
                .collect::<Vec<_>>(),
            vec![1, 2, 3]
        );
        for (attempt, delay) in &attempts {
            assert!(*delay >= 20, "attempt {attempt} scheduled {delay}ms");
            assert!(*delay <= 80, "attempt {attempt} scheduled {delay}ms");
        }
        Ok(())
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_resume_purges_the_identity_it_stranded() -> Result<()> {
        let mut fixture = Fixture::attached_with(MeshReconnectConfig {
            zombie_purge: true,
            suspend_after: Duration::ZERO,
            advertisement_fast_path: false,
            ..MeshReconnectConfig::default()
        })
        .await?;
        fixture.await_first_snapshot().await?;
        fixture.kill_host();
        fixture
            .wait_for_state(RemoteLifecycleState::Suspended)
            .await?;
        fixture.arm_host("host-1").await?;
        fixture
            .runtime
            .reconnect_session(&fixture.session_id)
            .await?;

        let lifecycle = fixture
            .runtime
            .replicas
            .read()
            .await
            .get(&fixture.session_id)
            .map(|remote| Arc::clone(&remote.lifecycle))
            .expect("session lifecycle");
        // g1 was stranded by the resume; the purge attaches it, drains the
        // transient state stream, and detaches it.
        for _ in 0..200 {
            if lifecycle.purgeable_generations().is_empty() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert!(
            lifecycle.purgeable_generations().is_empty(),
            "stranded generations were never purged"
        );

        // Draining that stream matters: left in the accept queue it would be
        // handed to the next attach as a misrouted feed.
        assert_eq!(fixture.feed_reader_count().await, 1);
        assert_eq!(fixture.lifecycle().await.state, RemoteLifecycleState::Live);
        let session = fixture
            .registry
            .read()
            .unwrap()
            .get(&fixture.remote_session_id)
            .cloned()
            .expect("host session");
        let feed_wire = fixture
            .runtime
            .views
            .lock()
            .await
            .get(&(fixture.session_id.clone(), "pane-1".to_owned()))
            .map(|view| view.wire_view_id.clone())
            .expect("feed view");
        session.claim_control(&feed_wire, "truffle:peer:1", 100, 30)?;
        for _ in 0..200 {
            let summary = fixture
                .runtime
                .replicas
                .read()
                .await
                .get(&fixture.session_id)
                .map(|remote| remote.replica.summary())
                .expect("session");
            if (summary.cols, summary.rows) == (100, 30) {
                return Ok(());
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        bail!("the feed stopped tracking the host after the purge")
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn refreshing_a_live_session_re_attaches_the_feed() -> Result<()> {
        let fixture = Fixture::attached().await?;
        fixture.await_first_snapshot().await?;
        let before = fixture
            .runtime
            .current_attachment(&fixture.session_id, "pane-1")
            .await
            .expect("attached epoch")
            .0;

        fixture.runtime.refresh_remote(&fixture.session_id).await?;

        // A true remote refresh, not a local re-render: the feed is re-attached
        // under an advanced generation, which is what guarantees a fresh stream
        // and reset patch sequencing.
        let (after, _) = fixture
            .runtime
            .current_attachment(&fixture.session_id, "pane-1")
            .await
            .expect("refreshed epoch");
        assert_ne!(after, before);
        let wire = fixture
            .runtime
            .views
            .lock()
            .await
            .get(&(fixture.session_id.clone(), "pane-1".to_owned()))
            .map(|view| view.wire_view_id.clone())
            .expect("refreshed view");
        assert_eq!(wire, "r:pane-1#g2");
        assert_eq!(fixture.lifecycle().await.state, RemoteLifecycleState::Live);
        assert_eq!(fixture.feed_reader_count().await, 1);
        assert!(fixture.retained_snapshot().await.is_some());
        Ok(())
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn refreshing_a_frozen_session_is_refused_and_never_dials() -> Result<()> {
        let fixture = Fixture::attached().await?;
        fixture.await_first_snapshot().await?;
        fixture.kill_host();
        fixture
            .wait_for_state(RemoteLifecycleState::Suspended)
            .await?;

        let dials = fixture.transport.dials();
        // There is no host to ask, so the remote refresh is refused outright
        // rather than burning a connect.
        assert!(
            fixture
                .runtime
                .refresh_remote(&fixture.session_id)
                .await
                .is_err()
        );
        // The local re-render still works on the retained viewport.
        fixture.runtime.refresh(&fixture.session_id).await?;
        assert_eq!(fixture.transport.dials(), dials);
        assert_eq!(
            fixture.lifecycle().await.state,
            RemoteLifecycleState::Suspended
        );
        Ok(())
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn closing_a_session_stops_its_engine() -> Result<()> {
        let fixture = Fixture::attached_with(eager_reconnect()).await?;
        let lifecycle = fixture
            .runtime
            .replicas
            .read()
            .await
            .get(&fixture.session_id)
            .map(|remote| Arc::clone(&remote.lifecycle))
            .expect("session lifecycle");

        fixture.kill_host();
        fixture
            .wait_for_state(RemoteLifecycleState::Reconnecting)
            .await?;
        assert!(lifecycle.has_engine());

        assert!(fixture.runtime.close_session(&fixture.session_id).await);
        assert!(lifecycle.is_ended());
        assert!(!lifecycle.has_engine(), "the engine outlived its session");

        // An abort cannot recall a dial already in flight, so let the last
        // attempt land; what must stop is the schedule behind it.
        tokio::time::sleep(Duration::from_millis(150)).await;
        let settled = fixture.transport.dials();
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert_eq!(
            fixture.transport.dials(),
            settled,
            "a closed session kept dialing"
        );
        Ok(())
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_zombie_reader_moves_no_state_after_its_generation_is_retired() -> Result<()> {
        let fixture = Fixture::attached().await?;
        fixture.await_first_snapshot().await?;
        let remote = fixture
            .runtime
            .replicas
            .read()
            .await
            .get(&fixture.session_id)
            .cloned()
            .expect("open remote session");
        let lifecycle = Arc::clone(&remote.lifecycle);
        let session = fixture
            .registry
            .read()
            .unwrap()
            .get(&fixture.remote_session_id)
            .cloned()
            .expect("host session");

        // Orphan the reader without cancelling it: this is exactly a reader
        // stranded by a resume, still holding a live stream.
        fixture
            .runtime
            .views
            .lock()
            .await
            .remove(&(fixture.session_id.clone(), "pane-1".to_owned()));
        lifecycle.advance_generation();

        let mut controls = fixture.runtime.subscribe_control();
        let mut activities = fixture.runtime.subscribe_activity();
        let contact_before = lifecycle
            .state
            .lock()
            .unwrap()
            .last_contact
            .expect("contact recorded while live");

        // Drive all three dispatch kinds from the host. Claiming control at a
        // new size produces a ControlChanged and a resized snapshot; the
        // activity announcement produces an ActivityChanged.
        session.claim_control("r:pane-1#g1", "truffle:peer:1", 100, 30)?;
        session.announce_activity();
        session.refresh()?;
        tokio::time::sleep(Duration::from_millis(100)).await;

        // A zombie that only had its frames gated could still overwrite
        // controller or activity state after recovery.
        assert!(
            controls.try_recv().is_err(),
            "zombie moved controller state"
        );
        assert!(
            activities.try_recv().is_err(),
            "zombie moved activity state"
        );
        let summary = remote.replica.summary();
        assert_eq!(
            (summary.cols, summary.rows),
            (80, 24),
            "zombie published a snapshot into the replica"
        );
        // Late traffic must not vouch for the current connection's liveness.
        assert_eq!(
            lifecycle.state.lock().unwrap().last_contact,
            Some(contact_before),
            "zombie refreshed the current connection's contact clock"
        );
        Ok(())
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_delayed_old_reader_cannot_retire_the_resumed_view() -> Result<()> {
        let mut fixture = Fixture::attached().await?;
        let original = fixture
            .runtime
            .views
            .lock()
            .await
            .get(&(fixture.session_id.clone(), "pane-1".to_owned()))
            .cloned()
            .expect("attached view");

        fixture.kill_host();
        fixture
            .wait_for_state(RemoteLifecycleState::Suspended)
            .await?;
        fixture.arm_host("host-1").await?;
        let resumed = fixture
            .runtime
            .reconnect_session(&fixture.session_id)
            .await?;
        assert_eq!(resumed.state, RemoteLifecycleState::Live);
        let epoch = fixture
            .runtime
            .current_attachment(&fixture.session_id, "pane-1")
            .await
            .expect("resumed epoch")
            .0;

        // The old connection's cleanup lands late. It must not remove the
        // replacement's entry, nor push the session back to Suspended.
        original.state_cancel.send_replace(true);
        assert!(
            !fixture
                .runtime
                .replicas
                .read()
                .await
                .get(&fixture.session_id)
                .expect("session")
                .lifecycle
                .commit_disconnect(original.state_generation, original.incarnation)
        );
        tokio::time::sleep(Duration::from_millis(50)).await;

        assert_eq!(fixture.lifecycle().await.state, RemoteLifecycleState::Live);
        assert_eq!(
            fixture
                .runtime
                .current_attachment(&fixture.session_id, "pane-1")
                .await
                .map(|(epoch, _)| epoch),
            Some(epoch)
        );
        Ok(())
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_probe_reaches_the_cached_connection_with_an_expired_advertisement() -> Result<()> {
        let fixture = Fixture::attached().await?;
        // The probe matters exactly when discovery has gone quiet, so it must
        // not route through advertisement validation.
        fixture.transport.advertise(None);
        assert!(
            fixture
                .runtime
                .remote_connection(TEST_DEVICE)
                .await
                .is_err()
        );
        fixture.runtime.probe_connection(TEST_DEVICE).await?;
        assert_eq!(fixture.lifecycle().await.state, RemoteLifecycleState::Live);

        fixture.kill_host();
        assert!(fixture.runtime.probe_connection(TEST_DEVICE).await.is_err());
        fixture
            .wait_for_state(RemoteLifecycleState::Suspended)
            .await?;
        Ok(())
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn lifecycle_and_view_sequences_are_monotonic_across_a_resume() -> Result<()> {
        let mut fixture = Fixture::attached().await?;
        let mut lifecycles = fixture.runtime.subscribe_lifecycle();
        let mut view_states = fixture.runtime.subscribe_view_state();

        fixture.kill_host();
        fixture
            .wait_for_state(RemoteLifecycleState::Suspended)
            .await?;
        fixture.arm_host("host-1").await?;
        fixture
            .runtime
            .reconnect_session(&fixture.session_id)
            .await?;

        let mut last_lifecycle = 0;
        while let Ok(event) = lifecycles.try_recv() {
            assert!(
                event.lifecycle_seq > last_lifecycle,
                "lifecycle sequence regressed at {event:?}"
            );
            last_lifecycle = event.lifecycle_seq;
        }
        assert!(last_lifecycle > 0);

        let mut last_view = 0;
        while let Ok(event) = view_states.try_recv() {
            assert!(
                event.view_state_seq > last_view,
                "view sequence regressed at {event:?}"
            );
            last_view = event.view_state_seq;
            if event.view_state != RemoteViewState::Attached {
                assert_eq!(event.attachment_epoch, None);
                assert_eq!(event.read_write, None);
            }
        }
        assert!(last_view > 0);
        Ok(())
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn selection_text_is_answered_locally_while_frozen() -> Result<()> {
        let fixture = Fixture::attached().await?;
        // Let the host's post-attach refresh land in the replica.
        fixture.await_first_snapshot().await?;
        fixture.kill_host();
        fixture
            .wait_for_state(RemoteLifecycleState::Suspended)
            .await?;

        // The frozen viewport stays readable with no host to ask.
        let text = fixture
            .runtime
            .offline_selection_text(
                &fixture.session_id,
                RemoteSelection {
                    attachment_epoch: 0,
                    start_column: 0,
                    start_row: 0,
                    end_column: 0,
                    end_row: 0,
                    select_all: true,
                },
            )
            .await?;
        assert!(text.lines().count() >= 1);
        Ok(())
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    #[ignore = "requires TRUFFLE_TEST_AUTHKEY and a reachable Tailscale control plane"]
    async fn latest_truffle_quic_round_trip() -> Result<()> {
        let _ = dotenvy::dotenv();
        let auth_key = env::var("TRUFFLE_TEST_AUTHKEY")
            .context("TRUFFLE_TEST_AUTHKEY is required for this ignored test")?;
        let sidecar_path = env::var("TRUFFLE_SIDECAR_PATH")
            .context("TRUFFLE_SIDECAR_PATH is required for this ignored test")?;
        let a_state = tempfile::tempdir()?;
        let b_state = tempfile::tempdir()?;
        let suffix = &Uuid::new_v4().simple().to_string()[..8];
        let build_a = Node::<TailscaleProvider>::builder()
            .app_id("ghosttea-test")?
            .device_name(format!("terminal-a-{suffix}"))
            .state_dir(a_state.path().to_string_lossy().as_ref())
            .sidecar_path(&sidecar_path)
            .auth_key(&auth_key)
            .ephemeral(true)
            .build();
        let build_b = Node::<TailscaleProvider>::builder()
            .app_id("ghosttea-test")?
            .device_name(format!("terminal-b-{suffix}"))
            .state_dir(b_state.path().to_string_lossy().as_ref())
            .sidecar_path(&sidecar_path)
            .auth_key(&auth_key)
            .ephemeral(true)
            .build();
        let (node_a, node_b) = tokio::time::timeout(Duration::from_secs(60), async {
            tokio::try_join!(build_a, build_b)
        })
        .await
        .context("timed out starting the two Truffle 0.7.8 nodes")??;
        let node_a = Arc::new(node_a);
        let node_b = Arc::new(node_b);
        let b_id = node_b.local_info().device_id;
        tokio::time::timeout(Duration::from_secs(35), node_a.peer(&b_id, Some(30_000)))
            .await
            .context("timed out discovering the second Truffle node")??
            .context("node B did not appear in node A's peer registry")?;

        let listener = node_b.listen_quic(19_420).await?;
        let accept = listener.accept();
        let connect = node_a.connect_quic(&b_id, 19_420);
        let (accepted, client) = tokio::time::timeout(Duration::from_secs(30), async {
            tokio::join!(accept, connect)
        })
        .await
        .context("timed out establishing the Truffle QUIC connection")?;
        let server = accepted.context("QUIC listener closed")?;
        let client = client?;
        let mut client_stream = client.open_stream().await?;
        client_stream.write(b"truffle-0.7.1").await?;
        client_stream.finish();
        let mut server_stream =
            tokio::time::timeout(Duration::from_secs(10), server.accept_stream())
                .await
                .context("timed out accepting the Truffle QUIC stream")??
                .context("client stream was not accepted")?;
        assert_eq!(
            server_stream.read(64).await?.as_deref(),
            Some(b"truffle-0.7.1".as_slice())
        );
        client.close();
        server.close();
        listener.close();
        tokio::time::timeout(Duration::from_secs(10), node_a.stop())
            .await
            .context("timed out stopping Truffle node A")?;
        tokio::time::timeout(Duration::from_secs(10), node_b.stop())
            .await
            .context("timed out stopping Truffle node B")?;
        Ok(())
    }
}
