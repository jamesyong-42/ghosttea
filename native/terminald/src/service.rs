use std::{
    collections::{HashMap, HashSet},
    path::Path,
    sync::{Arc, Mutex, RwLock},
};

use anyhow::{Context, Result, bail};
use ghosttea_text::TextEngine;
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt},
    net::{UnixListener, UnixStream},
    sync::broadcast,
};

use crate::{
    mesh, session,
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
const MAX_TERMINAL_COLS: u16 = 1_000;
const MAX_TERMINAL_ROWS: u16 = 1_000;

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
    session_handles: Vec<u64>,
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
    frame_tx: broadcast::Sender<Vec<u8>>,
    event_tx: broadcast::Sender<Value>,
    text_engine: Arc<Mutex<TextEngine>>,
    mesh_runtime: Arc<dyn mesh::RemoteTerminalRuntime>,
}

/// Local IPC endpoints and bearer token owned by the embedding application.
pub struct TerminalServiceConfig {
    pub control_socket: String,
    pub frame_socket: String,
    pub auth_token: String,
}

/// A terminal session service that can run locally or expose sessions through
/// an injected remote transport.
pub struct TerminalService {
    config: TerminalServiceConfig,
    mesh: Option<Box<dyn mesh::TerminalMesh>>,
}

impl TerminalService {
    pub fn new(config: TerminalServiceConfig) -> Self {
        Self { config, mesh: None }
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

    pub async fn run(self) -> Result<()> {
        let TerminalServiceConfig {
            control_socket,
            frame_socket,
            auth_token,
        } = self.config;
        remove_stale_socket(&control_socket)?;
        remove_stale_socket(&frame_socket)?;
        let control = UnixListener::bind(&control_socket)?;
        let frames = UnixListener::bind(&frame_socket)?;
        let (frame_tx, _) = broadcast::channel::<Vec<u8>>(32);
        let (event_tx, _) = broadcast::channel::<Value>(64);
        let registry: Registry = Arc::new(RwLock::new(HashMap::new()));
        let mesh_runtime = self
            .mesh
            .as_ref()
            .map(|mesh| mesh.runtime())
            .unwrap_or_else(|| Arc::new(mesh::NoRemoteRuntime));
        let mut remote_controls = mesh_runtime.subscribe_control();
        let remote_events = event_tx.clone();
        tokio::spawn(async move {
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
        });
        let text_engine = Arc::new(Mutex::new(
            TextEngine::discover().context("system font discovery failed")?,
        ));

        println!(
            "ghosttead ready ({})",
            text_engine.lock().unwrap().primary_family()
        );
        let mesh_task = self.mesh.map(|mesh| {
            let mesh_registry = Arc::clone(&registry);
            tokio::spawn(async move {
                if let Err(error) = mesh.serve(mesh_registry).await {
                    eprintln!("[terminal-mesh] stopped: {error:#}");
                }
            })
        });
        let control_task = serve_control(
            control,
            auth_token.clone(),
            ControlContext {
                registry: Arc::clone(&registry),
                frame_tx: frame_tx.clone(),
                event_tx,
                text_engine,
                mesh_runtime,
            },
        );
        let frame_task = serve_frames(frames, auth_token, frame_tx);
        let result = tokio::try_join!(control_task, frame_task).map(|_| ());
        if let Some(task) = mesh_task {
            task.abort();
        }
        result
    }
}

fn remove_stale_socket(path: &str) -> Result<()> {
    if Path::new(path).exists() {
        std::fs::remove_file(path)?;
    }
    Ok(())
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

async fn authenticate(stream: &mut UnixStream, expected: &str) -> Result<()> {
    let token = read_packet(stream, 1024).await?;
    if token != expected.as_bytes() {
        bail!("authentication failed");
    }
    write_packet(stream, b"ok").await
}

async fn serve_control(
    listener: UnixListener,
    token: String,
    context: ControlContext,
) -> Result<()> {
    loop {
        let (mut socket, _) = listener.accept().await?;
        let token = token.clone();
        let context = context.clone();
        tokio::spawn(async move {
            if authenticate(&mut socket, &token).await.is_err() {
                return;
            }
            let mut events = context.event_tx.subscribe();
            let (mut reader, mut writer) = socket.into_split();
            let client_id = uuid::Uuid::new_v4().to_string();
            let mut attached = HashMap::<(String, String), u64>::new();
            loop {
                tokio::select! {
                    packet = read_packet(&mut reader, MAX_CONTROL_BYTES) => {
                        let Ok(packet) = packet else { break; };
                        let Ok(command) = serde_json::from_slice::<Envelope>(&packet) else { break; };
                        let notification = command.request_id == 0;
                        let response = handle_command(command, &client_id, &mut attached, &context).await;
                        if !notification && write_packet(&mut writer, &serde_json::to_vec(&response).unwrap()).await.is_err() { break; }
                    }
                    event = events.recv() => match event {
                        Ok(event) => {
                            if write_packet(&mut writer, &serde_json::to_vec(&event).unwrap()).await.is_err() { break; }
                        }
                        Err(broadcast::error::RecvError::Lagged(_)) => continue,
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
                    protocol_major: 1,
                    protocol_minor: 4,
                    server_build: env!("CARGO_PKG_VERSION").to_owned(),
                })
            }
            Command::CreateSession { options } => {
                validate_grid(options.cols, options.rows)?;
                let registry_on_exit = Arc::clone(registry);
                let events_on_exit = event_tx.clone();
                let on_exit: ExitCallback = Arc::new(move |session_id, exit, persistence| {
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
                let session = Session::spawn(
                    options,
                    context.frame_tx.clone(),
                    Arc::clone(&context.text_engine),
                    on_exit,
                )?;
                let summary = session.summary();
                let mut controls = session.subscribe_control();
                let control_session_id = summary.id.clone();
                let control_events = event_tx.clone();
                tokio::spawn(async move {
                    loop {
                        match controls.recv().await {
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
                            Err(broadcast::error::RecvError::Lagged(_)) => continue,
                            Err(broadcast::error::RecvError::Closed) => break,
                        }
                    }
                });
                registry
                    .write()
                    .unwrap()
                    .insert(summary.id.clone(), Arc::clone(&session));
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
            } => {
                let cols = checked_dimension(cols, "cols", 2, MAX_TERMINAL_COLS)?;
                let rows = checked_dimension(rows, "rows", 1, MAX_TERMINAL_ROWS)?;
                let session = context
                    .mesh_runtime
                    .open_session(
                        &device_id,
                        &remote_session_id,
                        cols,
                        rows,
                        context.frame_tx.clone(),
                        Arc::clone(&context.text_engine),
                    )
                    .await?;
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
                            session.refresh()?;
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
                    session.terminate(source)?;
                    registry.write().unwrap().remove(&session_id);
                } else if !context.mesh_runtime.close_session(&session_id).await {
                    bail!("unknown session");
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

async fn serve_frames(
    listener: UnixListener,
    token: String,
    frame_tx: broadcast::Sender<Vec<u8>>,
) -> Result<()> {
    loop {
        let (mut socket, _) = listener.accept().await?;
        let token = token.clone();
        let mut rx = frame_tx.subscribe();
        tokio::spawn(async move {
            if authenticate(&mut socket, &token).await.is_err() {
                return;
            }
            let (mut reader, mut writer) = socket.into_split();
            let mut subscriptions = HashSet::<u64>::new();
            loop {
                tokio::select! {
                    packet = read_packet(&mut reader, MAX_FRAME_SUBSCRIPTION_BYTES) => {
                        let Ok(packet) = packet else { break; };
                        let Ok(subscription) = serde_json::from_slice::<FrameSubscription>(&packet) else { break; };
                        if subscription.session_handles.len() > MAX_FRAME_SUBSCRIPTIONS {
                            break;
                        }
                        subscriptions = subscription.session_handles.into_iter().collect();
                    }
                    frame = rx.recv() => match frame {
                        Ok(frame) if frame.len() <= MAX_FRAME_BYTES => {
                            let Some(handle) = frame_session_handle(&frame) else { continue; };
                            if subscriptions.contains(&handle)
                                && write_packet(&mut writer, &frame).await.is_err()
                            {
                                break;
                            }
                        }
                        Ok(_) => break,
                        Err(broadcast::error::RecvError::Lagged(_)) => continue,
                        Err(_) => break,
                    }
                }
            }
        });
    }
}

fn frame_session_handle(frame: &[u8]) -> Option<u64> {
    Some(u64::from_le_bytes(frame.get(8..16)?.try_into().ok()?))
}

#[cfg(test)]
mod protocol_tests {
    use super::*;

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
            "sessionHandles": [7, 11]
        }))
        .unwrap();
        assert_eq!(subscription.session_handles, vec![7, 11]);

        let mut frame = vec![0_u8; 16];
        frame[8..16].copy_from_slice(&11_u64.to_le_bytes());
        assert_eq!(frame_session_handle(&frame), Some(11));
        assert_eq!(frame_session_handle(&frame[..15]), None);
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
                protocol_major: 1,
                protocol_minor: 4,
                server_build: "test".to_owned(),
            },
        })
        .unwrap();
        assert_eq!(value["requestId"], 7);
        assert_eq!(value["type"], "hello");
        assert_eq!(value["protocolMajor"], 1);
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
    fn preserves_unknown_commands_as_typed_errors() {
        let envelope: Envelope = serde_json::from_value(json!({
            "requestId": 20,
            "type": "future-command",
        }))
        .unwrap();
        assert!(matches!(envelope.command, Command::Unknown));
    }
}
