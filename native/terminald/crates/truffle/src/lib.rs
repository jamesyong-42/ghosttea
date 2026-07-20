use std::{
    collections::HashMap,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};

#[cfg(test)]
use std::env;

use anyhow::{Context, Result, bail};
use async_trait::async_trait;
use subtle::ConstantTimeEq;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::sync::broadcast;
use tokio::time::MissedTickBehavior;
use truffle_core as truffle;
use truffle_core::{Node, network::tailscale::TailscaleProvider, transport::quic::QuicStream};
use uuid::Uuid;

use ghosttea::{
    RemoteAttachment, RemoteControlChanged, RemoteControlClaim, RemoteHostSummary, RemoteReplica,
    RemoteResize, RemoteSelection, RemoteSessionOpen, RemoteTerminalRuntime, Session,
    SessionRegistry as Registry, SessionSummary, TerminalMesh, ViewAccess,
    tunnel_protocol::{
        CompactChannel, ConnectionMessage, LogicalTerminalPatch, LogicalTerminalSnapshot,
        MAX_CONTROL_MESSAGE_BYTES, MAX_STATE_MESSAGE_BYTES, PROTOCOL_MAJOR, PROTOCOL_MINOR,
        RowReplacement, SessionControlMessage, SharedSessionSummary, StateCodec, StateMessage,
        StreamKind, StreamPreface, TerminalHostAdvertisement, TunnelInput, decode_compact_message,
        decode_message, decode_preface, decode_state_message, encode_compact_message,
        encode_message, encode_preface, encode_state_message,
    },
};

pub const DEFAULT_QUIC_PORT: u16 = 9420;
pub const DEFAULT_COMPACT_PORT: u16 = 9421;
const ADVERTISEMENT_INTERVAL: Duration = Duration::from_secs(5);
const ADVERTISEMENT_TTL: Duration = Duration::from_secs(15);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(20);
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);

type HostStore = truffle::synced_store::SyncedStore<TerminalHostAdvertisement>;
type RemoteViews = Arc<tokio::sync::Mutex<HashMap<(String, String), Arc<RemoteView>>>>;
type RemoteConnections = Arc<tokio::sync::Mutex<HashMap<String, Arc<RemoteHostConnection>>>>;

#[derive(Clone)]
pub struct MeshRuntime {
    ready: Arc<tokio::sync::RwLock<Option<MeshReady>>>,
    replicas: Arc<tokio::sync::RwLock<HashMap<String, RemoteSession>>>,
    views: RemoteViews,
    connections: RemoteConnections,
    control_tx: broadcast::Sender<RemoteControlChanged>,
}

impl Default for MeshRuntime {
    fn default() -> Self {
        let (control_tx, _) = broadcast::channel(64);
        Self {
            ready: Arc::default(),
            replicas: Arc::default(),
            views: Arc::default(),
            connections: Arc::default(),
            control_tx,
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

#[derive(Clone)]
struct RemoteSession {
    device_id: String,
    remote_session_id: String,
    access_token: Option<String>,
    replica: Arc<RemoteReplica>,
}

struct RemoteView {
    session_control: tokio::sync::Mutex<ProtocolStream>,
    control: tokio::sync::watch::Receiver<Option<RemoteControlClaim>>,
    state_cancel: tokio::sync::watch::Sender<bool>,
    attachment_epoch: u64,
    read_write: bool,
}

struct RemoteHostConnection {
    connection: Arc<truffle::transport::quic::QuicConnection>,
    control: tokio::sync::Mutex<ProtocolStream>,
    incoming: tokio::sync::Mutex<()>,
    host_instance_id: String,
    state_codec: StateCodec,
    healthy: AtomicBool,
}

fn connection_is_reusable(
    cached_host_instance_id: &str,
    healthy: bool,
    advertised_host_instance_id: &str,
) -> bool {
    healthy && cached_host_instance_id == advertised_host_instance_id
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
        match self.list_sessions_once(device_id).await {
            Ok(sessions) => Ok(sessions),
            Err(first_error) => {
                self.invalidate_connection(device_id, None).await;
                self.list_sessions_once(device_id).await.with_context(|| {
                    format!("remote session listing failed after reconnect: {first_error:#}")
                })
            }
        }
    }

    async fn list_sessions_once(&self, device_id: &str) -> Result<Vec<SharedSessionSummary>> {
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
        let ready = self.ready().await?;
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
        let summary = replica.summary();
        self.replicas.write().await.insert(
            summary.id.clone(),
            RemoteSession {
                device_id,
                remote_session_id,
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

    pub async fn attach_view(&self, session_id: &str, view_id: &str) -> Result<RemoteAttachment> {
        let device_id = self
            .replicas
            .read()
            .await
            .get(session_id)
            .map(|remote| remote.device_id.clone())
            .context("unknown remote session")?;
        match self.attach_view_once(session_id, view_id).await {
            Ok(epoch) => Ok(epoch),
            Err(first_error) => {
                self.invalidate_connection(&device_id, None).await;
                self.attach_view_once(session_id, view_id)
                    .await
                    .with_context(|| {
                        format!("remote view attach failed after reconnect: {first_error:#}")
                    })
            }
        }
    }

    async fn attach_view_once(&self, session_id: &str, view_id: &str) -> Result<RemoteAttachment> {
        let key = (session_id.to_owned(), view_id.to_owned());
        if let Some(view) = self.views.lock().await.get(&key) {
            return Ok(RemoteAttachment {
                attachment_epoch: view.attachment_epoch,
                read_write: view.read_write,
            });
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
        let (control_sender, control) = tokio::sync::watch::channel(None);
        let (state_cancel, mut state_cancelled) = tokio::sync::watch::channel(false);
        let view = Arc::new(RemoteView {
            session_control: tokio::sync::Mutex::new(session_control),
            control,
            state_cancel,
            attachment_epoch,
            read_write,
        });
        let local_view_key = key.clone();
        self.views.lock().await.insert(key, Arc::clone(&view));
        let replica = Arc::clone(&remote.replica);
        let local_session_id = session_id.to_owned();
        let remote_device_id = remote.device_id.clone();
        let remote_view = Arc::clone(&view);
        let remote_host = Arc::clone(&host);
        let views = Arc::clone(&self.views);
        let connections = Arc::clone(&self.connections);
        let remote_control_tx = self.control_tx.clone();
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
                match message {
                    Ok(Some(StateMessage::Snapshot(snapshot))) => {
                        if let Err(error) = replica.publish(snapshot) {
                            eprintln!("[terminal-mesh] failed to render remote state: {error:#}");
                            break;
                        }
                    }
                    Ok(Some(StateMessage::Patch(patch))) => {
                        if let Err(error) = replica.publish_patch(patch) {
                            eprintln!(
                                "[terminal-mesh] failed to apply remote state patch: {error:#}"
                            );
                            break;
                        }
                    }
                    Ok(Some(StateMessage::ControlChanged {
                        controller_view_id,
                        control_epoch,
                        cols,
                        rows,
                        layout_epoch,
                    })) => {
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
                    Ok(None) => break,
                    Err(error) => {
                        eprintln!("[terminal-mesh] remote state stream closed: {error:#}");
                        break;
                    }
                }
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
            }
        });
        remote.replica.set_read_write(read_write);
        Ok(RemoteAttachment {
            attachment_epoch,
            read_write,
        })
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
        let mut state = view.control.clone();
        let previous_epoch = state
            .borrow()
            .as_ref()
            .map_or(0, |current| current.control_epoch);
        view.session_control
            .lock()
            .await
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
        let mut control = view.session_control.lock().await;
        control
            .write_message(
                &SessionControlMessage::SelectionText {
                    request_id: request_id.clone(),
                    view_id: view_id.to_owned(),
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
        view.state_cancel.send_replace(true);
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
            if connection_is_reusable(
                &connection.host_instance_id,
                connection.healthy.load(Ordering::Acquire),
                &advertisement.host_instance_id,
            ) {
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
                && protocol_minor >= PROTOCOL_MINOR
                && echoed_nonce == nonce
                && host_instance_id == advertisement.host_instance_id
                && state_codec.is_none_or(|codec| codec == StateCodec::CompactJsonV1) =>
            {
                state_codec.unwrap_or(StateCodec::Json)
            }
            _ => bail!("remote host returned an invalid server hello"),
        };
        let remote = Arc::new(RemoteHostConnection {
            connection,
            control: tokio::sync::Mutex::new(control),
            incoming: tokio::sync::Mutex::new(()),
            host_instance_id: advertisement.host_instance_id,
            state_codec,
            healthy: AtomicBool::new(true),
        });
        connections.insert(device_id.to_owned(), Arc::clone(&remote));
        Ok(remote)
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
    if advertisement.protocol_minor < PROTOCOL_MINOR {
        bail!("remote terminal protocol minor is too old");
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
}

impl Default for TruffleTerminalConfig {
    fn default() -> Self {
        Self {
            service_name: "terminal.v1".to_owned(),
            quic_port: DEFAULT_QUIC_PORT,
            compact_port: DEFAULT_COMPACT_PORT,
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
        Ok(Self {
            node,
            config,
            runtime: MeshRuntime::new(),
        })
    }

    pub fn runtime(&self) -> MeshRuntime {
        self.runtime.clone()
    }

    pub async fn serve(self, registry: Registry) -> Result<()> {
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
        );
        let compact_accept = compact_accept_loop(
            Arc::clone(&node),
            compact_listener,
            registry,
            config.clone(),
            host_instance_id,
        );
        let result = tokio::select! {
            result = advertise => result,
            result = accept => result,
            result = compact_accept => result,
        };
        if let Err(error) = node.unlisten_tcp(config.compact_port).await {
            eprintln!("[terminal-mesh] compact-stream listener cleanup failed: {error}");
        }
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

async fn compact_accept_loop(
    node: Arc<Node<TailscaleProvider>>,
    mut listener: truffle::transport::RawListener,
    registry: Registry,
    config: TruffleTerminalConfig,
    host_instance_id: String,
) -> Result<()> {
    while let Some(incoming) = listener.accept().await {
        let node = Arc::clone(&node);
        let registry = registry.clone();
        let config = config.clone();
        let host_instance_id = host_instance_id.clone();
        tokio::spawn(async move {
            if let Err(error) =
                handle_compact_connection(node, incoming, registry, config, host_instance_id).await
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
    let client_nonce = match hello {
        ConnectionMessage::ClientHello {
            protocol_major,
            protocol_minor,
            local_device_id,
            nonce,
            ..
        } if protocol_major == PROTOCOL_MAJOR
            && protocol_minor >= PROTOCOL_MINOR
            && !local_device_id.trim().is_empty()
            && expected_device_id
                .as_deref()
                .is_none_or(|expected| expected == local_device_id) =>
        {
            nonce
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
                state_codec: None,
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
            handle_compact_session_protocol(&mut control, preface, registry, config, client_id)
                .await?;
        }
        _ => bail!("compact stream kind is not client-openable"),
    }
    Ok(())
}

async fn handle_compact_session_protocol<S>(
    control: &mut CompactProtocolStream<S>,
    preface: StreamPreface,
    registry: Registry,
    config: TruffleTerminalConfig,
    client_id: String,
) -> Result<()>
where
    S: AsyncRead + AsyncWrite + Unpin + Send,
{
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
            },
            MAX_CONTROL_MESSAGE_BYTES,
        )
        .await
        .context("write compact view-attached response")?;

    let result = async {
        let mut controls = session.subscribe_control();
        let mut snapshots = session.subscribe_logical();
        let mut previous = session.logical_snapshot();
        let mut patch_sequence = 0_u64;
        if let Some(snapshot) = previous.as_ref() {
            control
                .write_compact_message(
                    CompactChannel::State,
                    &StateMessage::Snapshot(snapshot.clone()),
                    MAX_STATE_MESSAGE_BYTES,
                )
                .await?;
        }
        let (controller, cols, rows, layout_epoch) = session.control_state();
        if let Some(controller) = controller {
            control
                .write_compact_message(
                    CompactChannel::State,
                    &StateMessage::ControlChanged {
                        controller_view_id: controller.view_id,
                        control_epoch: controller.control_epoch,
                        cols,
                        rows,
                        layout_epoch,
                    },
                    MAX_STATE_MESSAGE_BYTES,
                )
                .await?;
        }

        loop {
            tokio::select! {
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
                            control.write_compact_message(
                                CompactChannel::State,
                                &StateMessage::Snapshot(snapshot),
                                MAX_STATE_MESSAGE_BYTES,
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
                    control.write_compact_message(
                        CompactChannel::State,
                        &message,
                        MAX_STATE_MESSAGE_BYTES,
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
                    control.write_compact_message(
                        CompactChannel::State,
                        &StateMessage::ControlChanged {
                            controller_view_id: changed.controller.view_id,
                            control_epoch: changed.controller.control_epoch,
                            cols: changed.cols,
                            rows: changed.rows,
                            layout_epoch: changed.layout_epoch,
                        },
                        MAX_STATE_MESSAGE_BYTES,
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
    let (client_nonce, state_codec) = match hello {
        ConnectionMessage::ClientHello {
            protocol_major,
            protocol_minor,
            local_device_id,
            nonce,
            state_codecs,
            ..
        } if protocol_major == PROTOCOL_MAJOR
            && protocol_minor >= PROTOCOL_MINOR
            && local_device_id == expected_device_id =>
        {
            let state_codec = negotiate_state_codec(state_codecs);
            (nonce, state_codec)
        }
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
                state_codec: (state_codec != StateCodec::Json).then_some(state_codec),
            },
            MAX_CONTROL_MESSAGE_BYTES,
        )
        .await?;

    let streams_connection = Arc::clone(&connection);
    let streams_registry = registry.clone();
    let streams_config = config.clone();
    let streams_client_id = client_id.clone();
    let streams_state_codec = state_codec;
    let streams = tokio::spawn(async move {
        while let Some(stream) = streams_connection.accept_stream().await? {
            let registry = streams_registry.clone();
            let config = streams_config.clone();
            let client_id = streams_client_id.clone();
            let state_codec = streams_state_codec;
            let connection = Arc::clone(&streams_connection);
            tokio::spawn(async move {
                if let Err(error) = handle_application_stream(
                    connection,
                    stream,
                    registry,
                    config,
                    client_id,
                    state_codec,
                )
                .await
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
    state_codec: StateCodec,
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
    let (state_cancel, state_cancelled) = tokio::sync::watch::channel(false);
    spawn_state_stream(
        Arc::clone(&connection),
        Arc::clone(&session),
        &view_id,
        state_cancelled.clone(),
        state_codec,
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
}

async fn session_control_loop(
    control: &mut ProtocolStream,
    connection: Arc<truffle::transport::quic::QuicConnection>,
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
    connection: Arc<truffle::transport::quic::QuicConnection>,
    session: Arc<Session>,
    view_id: &str,
    mut cancelled: tokio::sync::watch::Receiver<bool>,
    state_codec: StateCodec,
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
    let mut snapshots = session.subscribe_logical();
    let mut previous = session.logical_snapshot();
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
    tokio::spawn(async move {
        let mut patch_sequence = 0_u64;
        loop {
            let message = tokio::select! {
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
            };
            if let Some(message) = message {
                if state
                    .write_state_message(&message, state_codec)
                    .await
                    .is_err()
                {
                    break;
                }
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

struct ProtocolStream {
    stream: QuicStream,
    buffered: ReadBuffer,
}

impl ProtocolStream {
    fn new(stream: QuicStream) -> Self {
        Self {
            stream,
            buffered: ReadBuffer::default(),
        }
    }

    async fn write_preface(&mut self, preface: &StreamPreface) -> Result<()> {
        self.stream.write(&encode_preface(preface)?).await?;
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
        self.stream.write(&encode_message(message, limit)?).await?;
        Ok(())
    }

    async fn write_state_message(
        &mut self,
        message: &StateMessage,
        codec: StateCodec,
    ) -> Result<()> {
        self.stream
            .write(&encode_state_message(
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
            match self.stream.read(64 * 1024).await? {
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

    async fn detach_view(&self, session_id: &str, view_id: &str, attachment_epoch: u64) {
        MeshRuntime::detach_view(self, session_id, view_id, attachment_epoch).await;
    }

    async fn close_session(&self, session_id: &str) -> bool {
        MeshRuntime::close_session(self, session_id).await
    }
}

#[async_trait]
impl TerminalMesh for TruffleTerminalMesh {
    fn runtime(&self) -> Arc<dyn RemoteTerminalRuntime> {
        Arc::new(self.runtime())
    }

    async fn serve(self: Box<Self>, registry: Registry) -> Result<()> {
        TruffleTerminalMesh::serve(*self, registry).await
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
                    state_codecs: None,
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
                state_codec: None,
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
        .context("timed out starting the two Truffle 0.7.2 nodes")??;
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
