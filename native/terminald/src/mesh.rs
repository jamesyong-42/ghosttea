use std::{
    collections::{HashMap, VecDeque},
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

#[cfg(test)]
use std::env;

use anyhow::{Context, Result, bail};
use serde::Serialize;
use subtle::ConstantTimeEq;
use text_engine::TextEngine;
use tokio::sync::broadcast;
use tokio::time::MissedTickBehavior;
use truffle_core as truffle;
use truffle_core::{Node, network::tailscale::TailscaleProvider, transport::quic::QuicStream};
use uuid::Uuid;

use crate::{
    Registry,
    authority::ViewAccess,
    replica::RemoteReplica,
    session::SessionSummary,
    tunnel_protocol::{
        ConnectionMessage, MAX_CONTROL_MESSAGE_BYTES, MAX_STATE_MESSAGE_BYTES, PROTOCOL_MAJOR,
        PROTOCOL_MINOR, SessionControlMessage, SharedSessionSummary, StateMessage, StreamKind,
        StreamPreface, TerminalHostAdvertisement, TunnelInput, decode_message, decode_preface,
        encode_message, encode_preface,
    },
};

pub const DEFAULT_QUIC_PORT: u16 = 9420;
const ADVERTISEMENT_INTERVAL: Duration = Duration::from_secs(5);
const ADVERTISEMENT_TTL: Duration = Duration::from_secs(15);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(20);
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);

type HostStore = truffle::synced_store::SyncedStore<TerminalHostAdvertisement>;
type RemoteViews = Arc<tokio::sync::Mutex<HashMap<(String, String), Arc<RemoteView>>>>;
type RemoteConnections = Arc<tokio::sync::Mutex<HashMap<String, Arc<RemoteHostConnection>>>>;

#[derive(Clone, Default)]
pub struct MeshRuntime {
    ready: Arc<tokio::sync::RwLock<Option<MeshReady>>>,
    replicas: Arc<tokio::sync::RwLock<HashMap<String, RemoteSession>>>,
    views: RemoteViews,
    connections: RemoteConnections,
}

#[derive(Clone)]
struct MeshReady {
    node: Arc<Node<TailscaleProvider>>,
    store: Arc<HostStore>,
    host_instance_id: String,
    capability: Option<String>,
}

#[derive(Clone)]
struct RemoteSession {
    device_id: String,
    remote_session_id: String,
    access_token: Option<String>,
    replica: Arc<RemoteReplica>,
}

struct RemoteView {
    session_control: tokio::sync::Mutex<ProtocolStream>,
    attachment_epoch: u64,
    read_write: bool,
}

struct RemoteHostConnection {
    connection: Arc<truffle::transport::quic::QuicConnection>,
    control: tokio::sync::Mutex<ProtocolStream>,
    incoming: tokio::sync::Mutex<()>,
    host_instance_id: String,
}

#[derive(Clone, Debug)]
pub struct RemoteControlClaim {
    pub controller_view_id: String,
    pub control_epoch: u64,
    pub cols: u16,
    pub rows: u16,
    pub layout_epoch: u64,
}

pub struct RemoteResize {
    pub attachment_epoch: u64,
    pub control_epoch: u64,
    pub resize_sequence: u64,
    pub cols: u16,
    pub rows: u16,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteHostSummary {
    pub device_id: String,
    pub device_name: String,
    pub online: bool,
    pub protocol_major: u16,
    pub protocol_minor: u16,
    pub host_instance_id: String,
    pub sessions: Vec<SharedSessionSummary>,
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
        let remote = self.remote_connection(device_id).await?;
        let mut control = remote.control.lock().await;
        let request_id = Uuid::new_v4().to_string();
        control
            .write_message(
                &ConnectionMessage::ListSessions {
                    request_id: request_id.clone(),
                },
                MAX_CONTROL_MESSAGE_BYTES,
            )
            .await?;
        let sessions = match tokio::time::timeout(
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
            } if response_id == request_id => sessions,
            ConnectionMessage::Error { message, .. } => {
                bail!("remote host rejected request: {message}")
            }
            _ => bail!("remote host returned an invalid session list"),
        };
        Ok(sessions)
    }

    pub async fn open_session(
        &self,
        device_id: &str,
        remote_session_id: &str,
        cols: u16,
        rows: u16,
        frames: broadcast::Sender<Vec<u8>>,
        text_engine: Arc<std::sync::Mutex<TextEngine>>,
    ) -> Result<SessionSummary> {
        let ready = self.ready().await?;
        // Advertised sessions are discovery hints and may lag registry
        // changes. Resolve the selected session against the host's live
        // registry before creating a local replica.
        let sessions = self.list_sessions(device_id).await?;
        let remote = sessions
            .iter()
            .find(|session| session.session_id == remote_session_id && session.attachable)
            .context("remote terminal session is no longer attachable")?;
        let replica = RemoteReplica::new(
            remote.title.clone(),
            remote.cwd_label.clone(),
            cols,
            rows,
            frames,
            text_engine,
        );
        let summary = replica.summary();
        self.replicas.write().await.insert(
            summary.id.clone(),
            RemoteSession {
                device_id: device_id.to_owned(),
                remote_session_id: remote_session_id.to_owned(),
                access_token: ready.capability,
                replica,
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

    pub async fn attach_view(&self, session_id: &str, view_id: &str) -> Result<u64> {
        let key = (session_id.to_owned(), view_id.to_owned());
        if let Some(view) = self.views.lock().await.get(&key) {
            return Ok(view.attachment_epoch);
        }
        let remote = self
            .replicas
            .read()
            .await
            .get(session_id)
            .cloned()
            .context("unknown remote session")?;
        let summary = remote.replica.summary();
        let host = self.remote_connection(&remote.device_id).await?;
        // A connection carries multiple view streams, but their LiveState
        // streams arrive on one connection-wide accept queue. Serialize the
        // attach handshake so concurrent panes cannot consume each other's
        // state stream.
        let _incoming = host.incoming.lock().await;
        let connection = Arc::clone(&host.connection);
        let mut session_control = ProtocolStream::new(connection.open_stream().await?);
        session_control
            .write_preface(&StreamPreface {
                stream_kind: StreamKind::SessionControl,
                session_id: Some(remote.remote_session_id.clone()),
                view_id: Some(view_id.to_owned()),
            })
            .await?;
        let request_id = Uuid::new_v4().to_string();
        session_control
            .write_message(
                &SessionControlMessage::AttachView {
                    request_id: request_id.clone(),
                    session_id: remote.remote_session_id.clone(),
                    view_id: view_id.to_owned(),
                    access_token: remote.access_token,
                    cols: summary.cols,
                    rows: summary.rows,
                },
                MAX_CONTROL_MESSAGE_BYTES,
            )
            .await?;
        let attach_response = tokio::time::timeout(
            HANDSHAKE_TIMEOUT,
            session_control.read_message::<SessionControlMessage>(MAX_CONTROL_MESSAGE_BYTES),
        )
        .await
        .context("timed out attaching remote terminal view")?
        .context("read remote terminal attach response")?
        .context("remote terminal closed before attaching view")?;
        let (attachment_epoch, read_write) = match attach_response {
            SessionControlMessage::ViewAttached {
                request_id: response_id,
                attachment_epoch,
                read_write,
                ..
            } if response_id == request_id => (attachment_epoch, read_write),
            _ => bail!("remote terminal returned an invalid attach response"),
        };
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
            || preface.view_id.as_deref() != Some(view_id)
        {
            bail!("remote terminal returned a misrouted state stream");
        }
        let view = Arc::new(RemoteView {
            session_control: tokio::sync::Mutex::new(session_control),
            attachment_epoch,
            read_write,
        });
        self.views.lock().await.insert(key, Arc::clone(&view));
        let replica = Arc::clone(&remote.replica);
        tokio::spawn(async move {
            loop {
                match state
                    .read_message::<StateMessage>(MAX_STATE_MESSAGE_BYTES)
                    .await
                {
                    Ok(Some(StateMessage::Snapshot(snapshot))) => {
                        if let Err(error) = replica.publish(snapshot) {
                            eprintln!("[terminal-mesh] failed to render remote state: {error:#}");
                            break;
                        }
                    }
                    Ok(Some(StateMessage::Patch(_))) => {
                        eprintln!("[terminal-mesh] ignored unsupported incremental remote patch");
                    }
                    Ok(None) => break,
                    Err(error) => {
                        eprintln!("[terminal-mesh] remote state stream closed: {error:#}");
                        break;
                    }
                }
            }
        });
        Ok(attachment_epoch)
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
        view.session_control
            .lock()
            .await
            .write_message(
                &SessionControlMessage::Input {
                    view_id: view_id.to_owned(),
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
        let mut control = view.session_control.lock().await;
        control
            .write_message(
                &SessionControlMessage::FocusAndResize {
                    view_id: view_id.to_owned(),
                    attachment_epoch,
                    cols,
                    rows,
                    client_sequence: 0,
                },
                MAX_CONTROL_MESSAGE_BYTES,
            )
            .await?;
        loop {
            match tokio::time::timeout(
                HANDSHAKE_TIMEOUT,
                control.read_message::<SessionControlMessage>(MAX_CONTROL_MESSAGE_BYTES),
            )
            .await
            .context("timed out claiming remote terminal control")??
            .context("remote terminal closed while claiming control")?
            {
                SessionControlMessage::ControlChanged {
                    controller_view_id,
                    control_epoch,
                    cols,
                    rows,
                    layout_epoch,
                } => {
                    return Ok(RemoteControlClaim {
                        controller_view_id,
                        control_epoch,
                        cols,
                        rows,
                        layout_epoch,
                    });
                }
                SessionControlMessage::ResizeRejected { .. } => continue,
                _ => bail!("remote terminal returned an invalid control response"),
            }
        }
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
        view.session_control
            .lock()
            .await
            .write_message(
                &SessionControlMessage::Resize {
                    view_id: view_id.to_owned(),
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

    pub async fn detach_view(&self, session_id: &str, view_id: &str, attachment_epoch: u64) {
        let key = (session_id.to_owned(), view_id.to_owned());
        let Some(view) = self.views.lock().await.remove(&key) else {
            return;
        };
        if view.attachment_epoch == attachment_epoch {
            let _ = view
                .session_control
                .lock()
                .await
                .write_message(
                    &SessionControlMessage::Detach {
                        view_id: view_id.to_owned(),
                        attachment_epoch,
                    },
                    MAX_CONTROL_MESSAGE_BYTES,
                )
                .await;
        }
    }

    pub async fn close_session(&self, session_id: &str) -> bool {
        let removed = self.replicas.write().await.remove(session_id).is_some();
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
        removed
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
        Ok(view)
    }

    async fn remote_connection(&self, device_id: &str) -> Result<Arc<RemoteHostConnection>> {
        let mut connections = self.connections.lock().await;
        let ready = self.ready().await?;
        let advertisement = validated_advertisement(&ready, device_id).await?;
        if let Some(connection) = connections.get(device_id) {
            if connection.host_instance_id == advertisement.host_instance_id {
                return Ok(Arc::clone(connection));
            }
            connection.connection.close();
            connections.remove(device_id);
        }
        let connection = Arc::new(
            tokio::time::timeout(
                CONNECT_TIMEOUT,
                ready.node.connect_quic(device_id, advertisement.quic_port),
            )
            .await
            .context("timed out connecting to remote terminal host")?
            .context("connect to remote terminal host")?,
        );
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
                    host_instance_id: ready.host_instance_id,
                    local_device_id: ready.node.local_info().device_id,
                    nonce: nonce.clone(),
                },
                MAX_CONTROL_MESSAGE_BYTES,
            )
            .await?;
        match tokio::time::timeout(
            HANDSHAKE_TIMEOUT,
            control.read_message::<ConnectionMessage>(MAX_CONTROL_MESSAGE_BYTES),
        )
        .await
        .context("timed out waiting for remote terminal handshake")??
        .context("remote host closed during handshake")?
        {
            ConnectionMessage::ServerHello {
                protocol_major,
                host_instance_id,
                nonce: echoed_nonce,
                ..
            } if protocol_major == PROTOCOL_MAJOR
                && echoed_nonce == nonce
                && host_instance_id == advertisement.host_instance_id => {}
            _ => bail!("remote host returned an invalid server hello"),
        }
        let remote = Arc::new(RemoteHostConnection {
            connection,
            control: tokio::sync::Mutex::new(control),
            incoming: tokio::sync::Mutex::new(()),
            host_instance_id: advertisement.host_instance_id,
        });
        connections.insert(device_id.to_owned(), Arc::clone(&remote));
        Ok(remote)
    }

    async fn ready(&self) -> Result<MeshReady> {
        self.ready
            .read()
            .await
            .clone()
            .context("Truffle terminal networking is disabled or still starting")
    }
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
    Ok(advertisement)
}

#[derive(Clone, Debug)]
/// Terminal-specific routing and authorization layered on a shared Truffle
/// node. Application identity, node state, and sidecar configuration belong to
/// the embedding host instead.
pub struct TruffleTerminalConfig {
    pub service_name: String,
    pub quic_port: u16,
    pub capability: Option<String>,
    pub allow_tailnet_write: bool,
}

impl Default for TruffleTerminalConfig {
    fn default() -> Self {
        Self {
            service_name: "terminal.v1".to_owned(),
            quic_port: DEFAULT_QUIC_PORT,
            capability: None,
            allow_tailnet_write: false,
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
        Ok(Self {
            node,
            config,
            runtime: MeshRuntime::new(),
        })
    }

    pub(crate) fn runtime(&self) -> MeshRuntime {
        self.runtime.clone()
    }

    pub(crate) async fn serve(self, registry: Registry) -> Result<()> {
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
        let store_id = format!("{}.hosts", config.service_name);
        let store_namespace = format!("ss:{store_id}");
        // Profiles keep a stable Truffle device ID, so persist the local store
        // version with it. Otherwise a restarted terminald begins again at
        // version 1 and a still-running peer rejects its advertisements as older
        // than the previous process's slice.
        let store = node.synced_store_with_backend::<TerminalHostAdvertisement>(
            &store_id,
            Arc::new(truffle::FileBackend::new(
                node.state_dir().join("synced-store"),
            )),
        );
        *runtime.ready.write().await = Some(MeshReady {
            node: Arc::clone(&node),
            store: Arc::clone(&store),
            host_instance_id: host_instance_id.clone(),
            capability: config.capability.clone(),
        });
        eprintln!(
            "[terminal-mesh] ready as {} on QUIC port {}",
            node.local_info().device_name,
            listener.port()
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
            registry,
            config,
            host_instance_id,
        );
        let result = tokio::select! {
            result = advertise => result,
            result = accept => result,
        };
        runtime.connections.lock().await.clear();
        *runtime.ready.write().await = None;
        result
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

async fn accept_loop(
    node: Arc<Node<TailscaleProvider>>,
    listener: Arc<truffle::transport::quic::QuicListener>,
    registry: Registry,
    config: TruffleTerminalConfig,
    host_instance_id: String,
) -> Result<()> {
    while let Some(connection) = listener.accept().await {
        let node = Arc::clone(&node);
        let registry = registry.clone();
        let config = config.clone();
        let host_instance_id = host_instance_id.clone();
        tokio::spawn(async move {
            if let Err(error) = handle_connection(
                node,
                Arc::new(connection),
                registry,
                config,
                host_instance_id,
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
) -> Result<()> {
    let remote_ip = connection.remote_address().ip();
    let peer = node
        .peers()
        .await
        .into_iter()
        .find(|peer| peer.ip == remote_ip)
        .context("QUIC source is not a current Truffle peer")?;
    let expected_device_id = peer
        .device_id
        .clone()
        .context("peer identity has not completed its eager hello")?;
    let client_id = format!("truffle:{}", peer.peer_ref);

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
    let client_nonce = match hello {
        ConnectionMessage::ClientHello {
            protocol_major,
            local_device_id,
            nonce,
            ..
        } if protocol_major == PROTOCOL_MAJOR && local_device_id == expected_device_id => nonce,
        ConnectionMessage::ClientHello { .. } => {
            bail!("client hello identity or protocol mismatch")
        }
        _ => bail!("expected client hello"),
    };
    control
        .write_message(
            &ConnectionMessage::ServerHello {
                protocol_major: PROTOCOL_MAJOR,
                protocol_minor: PROTOCOL_MINOR,
                host_instance_id,
                nonce: client_nonce,
            },
            MAX_CONTROL_MESSAGE_BYTES,
        )
        .await?;

    let streams_connection = Arc::clone(&connection);
    let streams_registry = registry.clone();
    let streams_config = config.clone();
    let streams_client_id = client_id.clone();
    let streams = tokio::spawn(async move {
        while let Some(stream) = streams_connection.accept_stream().await? {
            let registry = streams_registry.clone();
            let config = streams_config.clone();
            let client_id = streams_client_id.clone();
            let connection = Arc::clone(&streams_connection);
            tokio::spawn(async move {
                if let Err(error) =
                    handle_application_stream(connection, stream, registry, config, client_id).await
                {
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
    connection: Arc<truffle::transport::quic::QuicConnection>,
    stream: QuicStream,
    registry: Registry,
    config: TruffleTerminalConfig,
    client_id: String,
) -> Result<()> {
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
            },
            MAX_CONTROL_MESSAGE_BYTES,
        )
        .await?;
    spawn_state_stream(Arc::clone(&connection), Arc::clone(&session), &view_id).await?;

    let result = session_control_loop(
        &mut control,
        Arc::clone(&connection),
        Arc::clone(&session),
        &client_id,
        &view_id,
        attachment_epoch,
    )
    .await;
    session.detach_view(&view_id, &client_id);
    result
}

async fn session_control_loop(
    control: &mut ProtocolStream,
    connection: Arc<truffle::transport::quic::QuicConnection>,
    session: Arc<crate::session::Session>,
    client_id: &str,
    attached_view_id: &str,
    attachment_epoch: u64,
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
                let changed = session.claim_control(&view_id, client_id, cols, rows)?;
                control
                    .write_message(
                        &SessionControlMessage::ControlChanged {
                            controller_view_id: changed.controller.view_id,
                            control_epoch: changed.controller.control_epoch,
                            cols: changed.cols,
                            rows: changed.rows,
                            layout_epoch: changed.layout_epoch,
                        },
                        MAX_CONTROL_MESSAGE_BYTES,
                    )
                    .await?;
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
                    let (controller, cols, rows, _) = session.control_state();
                    control
                        .write_message(
                            &SessionControlMessage::ResizeRejected {
                                current_controller_view_id: controller
                                    .as_ref()
                                    .map(|value| value.view_id.clone()),
                                current_control_epoch: controller.map(|value| value.control_epoch),
                                cols,
                                rows,
                            },
                            MAX_CONTROL_MESSAGE_BYTES,
                        )
                        .await?;
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
                )
                .await?;
            }
            SessionControlMessage::StateAck { .. } => {}
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
    connection: Arc<truffle::transport::quic::QuicConnection>,
    session: Arc<crate::session::Session>,
    view_id: &str,
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
    if let Some(snapshot) = session.logical_snapshot() {
        state
            .write_message(&StateMessage::Snapshot(snapshot), MAX_STATE_MESSAGE_BYTES)
            .await?;
    }
    let mut snapshots = session.subscribe_logical();
    tokio::spawn(async move {
        loop {
            match snapshots.recv().await {
                Ok(snapshot) => {
                    if state
                        .write_message(&StateMessage::Snapshot(snapshot), MAX_STATE_MESSAGE_BYTES)
                        .await
                        .is_err()
                    {
                        break;
                    }
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                    // A later snapshot is absolute and supersedes every missed update.
                    continue;
                }
                Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
            }
        }
    });
    Ok(())
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

struct ProtocolStream {
    stream: QuicStream,
    buffered: VecDeque<u8>,
}

impl ProtocolStream {
    fn new(stream: QuicStream) -> Self {
        Self {
            stream,
            buffered: VecDeque::new(),
        }
    }

    async fn write_preface(&mut self, preface: &StreamPreface) -> Result<()> {
        self.stream.write(&encode_preface(preface)?).await?;
        Ok(())
    }

    async fn read_preface(&mut self) -> Result<StreamPreface> {
        let header = self
            .read_exact(16)
            .await?
            .context("EOF before stream preface")?;
        let metadata_len = u32::from_be_bytes(header[12..16].try_into().unwrap()) as usize;
        if metadata_len > crate::tunnel_protocol::MAX_PREFACE_METADATA_BYTES {
            bail!("stream preface metadata exceeds limit");
        }
        let metadata = self
            .read_exact(metadata_len)
            .await?
            .context("EOF in stream preface metadata")?;
        let mut encoded = header;
        encoded.extend_from_slice(&metadata);
        Ok(decode_preface(&encoded)?.0)
    }

    async fn write_message<T: serde::Serialize>(
        &mut self,
        message: &T,
        limit: usize,
    ) -> Result<()> {
        self.stream.write(&encode_message(message, limit)?).await?;
        Ok(())
    }

    async fn read_message<T: serde::de::DeserializeOwned>(
        &mut self,
        limit: usize,
    ) -> Result<Option<T>> {
        let Some(header) = self.read_exact(4).await? else {
            return Ok(None);
        };
        let payload_len = u32::from_be_bytes(header[..4].try_into().unwrap()) as usize;
        if payload_len > limit {
            bail!("terminal protocol message exceeds limit");
        }
        let payload = self
            .read_exact(payload_len)
            .await?
            .context("EOF in terminal protocol message")?;
        let mut encoded = header;
        encoded.extend_from_slice(&payload);
        Ok(Some(decode_message(&encoded, limit)?.0))
    }

    async fn read_exact(&mut self, length: usize) -> Result<Option<Vec<u8>>> {
        while self.buffered.len() < length {
            match self.stream.read(64 * 1024).await? {
                Some(chunk) => self.buffered.extend(chunk),
                None if self.buffered.is_empty() => return Ok(None),
                None => bail!("truncated QUIC stream"),
            }
        }
        Ok(Some(self.buffered.drain(..length).collect()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn terminal_access_policy_requires_an_explicit_write_grant() {
        let config = TruffleTerminalConfig {
            service_name: "terminal.test".into(),
            quic_port: DEFAULT_QUIC_PORT,
            capability: Some("secret".into()),
            allow_tailnet_write: false,
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
            .app_id("electron-ghostty-test")?
            .device_name(format!("terminal-a-{suffix}"))
            .state_dir(a_state.path().to_string_lossy().as_ref())
            .sidecar_path(&sidecar_path)
            .auth_key(&auth_key)
            .ephemeral(true)
            .build();
        let build_b = Node::<TailscaleProvider>::builder()
            .app_id("electron-ghostty-test")?
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
        .context("timed out starting the two Truffle 0.7.1 nodes")??;
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
