mod frame;
mod session;

use std::{
    collections::{HashMap, HashSet},
    env,
    path::Path,
    sync::{Arc, Mutex, RwLock},
};

use anyhow::{Context, Result, bail};
use serde::Deserialize;
use serde_json::{Value, json};
use session::{ExitCallback, KeyInput, MouseInput, Persistence, Session, SpawnOptions};
use text_engine::TextEngine;
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt},
    net::{UnixListener, UnixStream},
    sync::broadcast,
};

const MAX_CONTROL_BYTES: usize = 1024 * 1024;
const MAX_FRAME_BYTES: usize = 16 * 1024 * 1024;
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
    GetSession {
        session_id: String,
    },
    RefreshSession {
        session_id: String,
    },
    AttachSession {
        session_id: String,
    },
    DetachSession {
        session_id: String,
    },
    SendText {
        session_id: String,
        text: String,
    },
    Paste {
        session_id: String,
        text: String,
    },
    SendKey {
        session_id: String,
        event: KeyInput,
    },
    SendMouse {
        session_id: String,
        event: MouseInput,
    },
    Scroll {
        session_id: String,
        rows: i64,
    },
    Focus {
        session_id: String,
        focused: bool,
    },
    Resize {
        session_id: String,
        cols: u64,
        rows: u64,
    },
    SetColors {
        session_id: String,
        foreground: [u8; 3],
        background: [u8; 3],
        cursor: [u8; 3],
    },
    Interrupt {
        session_id: String,
    },
    Terminate {
        session_id: String,
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
    Ok,
    Error {
        message: String,
    },
}

type Registry = Arc<RwLock<HashMap<String, Arc<Session>>>>;

#[tokio::main]
async fn main() -> Result<()> {
    let control_path =
        env::var("TERMINALD_CONTROL_SOCKET").context("TERMINALD_CONTROL_SOCKET is required")?;
    let frame_path =
        env::var("TERMINALD_FRAME_SOCKET").context("TERMINALD_FRAME_SOCKET is required")?;
    let auth_token =
        env::var("TERMINALD_AUTH_TOKEN").context("TERMINALD_AUTH_TOKEN is required")?;
    remove_stale_socket(&control_path)?;
    remove_stale_socket(&frame_path)?;
    let control = UnixListener::bind(&control_path)?;
    let frames = UnixListener::bind(&frame_path)?;
    let (frame_tx, _) = broadcast::channel::<Vec<u8>>(32);
    let (event_tx, _) = broadcast::channel::<Value>(64);
    let registry: Registry = Arc::new(RwLock::new(HashMap::new()));
    let text_engine = Arc::new(Mutex::new(
        TextEngine::discover().context("system font discovery failed")?,
    ));

    println!(
        "terminald ready ({})",
        text_engine.lock().unwrap().primary_family()
    );
    let control_task = serve_control(
        control,
        auth_token.clone(),
        Arc::clone(&registry),
        frame_tx.clone(),
        event_tx,
        text_engine,
    );
    let frame_task = serve_frames(frames, auth_token, frame_tx);
    tokio::try_join!(control_task, frame_task)?;
    Ok(())
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
    registry: Registry,
    frame_tx: broadcast::Sender<Vec<u8>>,
    event_tx: broadcast::Sender<Value>,
    text_engine: Arc<Mutex<TextEngine>>,
) -> Result<()> {
    loop {
        let (mut socket, _) = listener.accept().await?;
        let token = token.clone();
        let registry = Arc::clone(&registry);
        let frame_tx = frame_tx.clone();
        let event_tx = event_tx.clone();
        let text_engine = Arc::clone(&text_engine);
        tokio::spawn(async move {
            if authenticate(&mut socket, &token).await.is_err() {
                return;
            }
            let mut events = event_tx.subscribe();
            let (mut reader, mut writer) = socket.into_split();
            let mut attached = HashSet::new();
            loop {
                tokio::select! {
                    packet = read_packet(&mut reader, MAX_CONTROL_BYTES) => {
                        let Ok(packet) = packet else { break; };
                        let Ok(command) = serde_json::from_slice::<Envelope>(&packet) else { break; };
                        let notification = command.request_id == 0;
                        let response = handle_command(command, &registry, &mut attached, frame_tx.clone(), event_tx.clone(), Arc::clone(&text_engine)).await;
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
            for session_id in attached {
                if let Some(session) = registry.read().unwrap().get(&session_id).cloned() {
                    session.detach_view();
                }
            }
        });
    }
}

async fn handle_command(
    command: Envelope,
    registry: &Registry,
    attached: &mut HashSet<String>,
    frame_tx: broadcast::Sender<Vec<u8>>,
    event_tx: broadcast::Sender<Value>,
    text_engine: Arc<Mutex<TextEngine>>,
) -> ResponseEnvelope {
    let request_id = command.request_id;
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
                    protocol_minor: 0,
                    server_build: env!("CARGO_PKG_VERSION").to_owned(),
                })
            }
            Command::CreateSession { options } => {
                validate_grid(options.cols, options.rows)?;
                let registry_on_exit = Arc::clone(registry);
                let events_on_exit = event_tx.clone();
                let on_exit: ExitCallback = Arc::new(move |session_id, exit_code, persistence| {
                    if persistence != Persistence::KeepUntilExplicitClose {
                        registry_on_exit.write().unwrap().remove(&session_id);
                    }
                    let _ = events_on_exit.send(json!({
                        "requestId": 0,
                        "type": "session-exited",
                        "sessionId": session_id,
                        "exitCode": exit_code,
                    }));
                });
                let session = Session::spawn(options, frame_tx, text_engine, on_exit)?;
                let summary = session.summary();
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
                let sessions: Vec<_> = registry
                    .read()
                    .unwrap()
                    .values()
                    .map(|session| session.summary())
                    .collect();
                Ok(ResponseBody::Sessions { sessions })
            }
            Command::GetSession { session_id } => {
                let session = find_session(registry, &session_id)?;
                Ok(ResponseBody::Session {
                    session: session.summary(),
                })
            }
            Command::RefreshSession { session_id } => {
                let session = find_session(registry, &session_id)?;
                session.refresh()?;
                Ok(ResponseBody::Ok)
            }
            Command::AttachSession { session_id } => {
                let session = find_session(registry, &session_id)?;
                if attached.insert(session_id) {
                    session.attach_view();
                    session.refresh()?;
                }
                Ok(ResponseBody::Ok)
            }
            Command::DetachSession { session_id } => {
                if attached.remove(&session_id)
                    && let Some(session) = registry.read().unwrap().get(&session_id).cloned()
                {
                    session.detach_view();
                }
                Ok(ResponseBody::Ok)
            }
            Command::SendText { session_id, text } => {
                find_session(registry, &session_id)?.write(&text)?;
                Ok(ResponseBody::Ok)
            }
            Command::Paste { session_id, text } => {
                find_session(registry, &session_id)?.paste(&text)?;
                Ok(ResponseBody::Ok)
            }
            Command::SendKey { session_id, event } => {
                find_session(registry, &session_id)?.key(&event)?;
                Ok(ResponseBody::Ok)
            }
            Command::SendMouse { session_id, event } => {
                if event.screen_width > 32_768
                    || event.screen_height > 32_768
                    || event.cell_width == 0
                    || event.cell_height == 0
                    || !event.x.is_finite()
                    || !event.y.is_finite()
                {
                    bail!("invalid mouse geometry");
                }
                find_session(registry, &session_id)?.mouse(&event)?;
                Ok(ResponseBody::Ok)
            }
            Command::Scroll { session_id, rows } => {
                find_session(registry, &session_id)?
                    .scroll(isize::try_from(rows.clamp(-10_000, 10_000))?)?;
                Ok(ResponseBody::Ok)
            }
            Command::Focus {
                session_id,
                focused,
            } => {
                find_session(registry, &session_id)?.focus(focused)?;
                Ok(ResponseBody::Ok)
            }
            Command::Resize {
                session_id,
                cols,
                rows,
            } => {
                let cols = checked_dimension(cols, "cols", 2, MAX_TERMINAL_COLS)?;
                let rows = checked_dimension(rows, "rows", 1, MAX_TERMINAL_ROWS)?;
                find_session(registry, &session_id)?.resize(cols, rows)?;
                Ok(ResponseBody::Ok)
            }
            Command::SetColors {
                session_id,
                foreground,
                background,
                cursor,
            } => {
                find_session(registry, &session_id)?.set_colors(foreground, background, cursor)?;
                Ok(ResponseBody::Ok)
            }
            Command::Interrupt { session_id } => {
                find_session(registry, &session_id)?.interrupt()?;
                Ok(ResponseBody::Ok)
            }
            Command::Terminate { session_id } => {
                find_session(registry, &session_id)?.terminate()?;
                registry.write().unwrap().remove(&session_id);
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

fn find_session(registry: &Registry, session_id: &str) -> Result<Arc<Session>> {
    registry
        .read()
        .unwrap()
        .get(session_id)
        .cloned()
        .context("unknown session")
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
            loop {
                match rx.recv().await {
                    Ok(frame) if frame.len() <= MAX_FRAME_BYTES => {
                        if write_packet(&mut socket, &frame).await.is_err() {
                            break;
                        }
                    }
                    Ok(_) => break,
                    Err(broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(_) => break,
                }
            }
        });
    }
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
            } => {
                assert_eq!(session_id, "session");
                assert_eq!((cols, rows), (120, 40));
            }
            _ => panic!("expected resize command"),
        }
    }

    #[test]
    fn serializes_typed_responses() {
        let value = serde_json::to_value(ResponseEnvelope {
            request_id: 7,
            body: ResponseBody::Hello {
                protocol_major: 1,
                protocol_minor: 0,
                server_build: "test".to_owned(),
            },
        })
        .unwrap();
        assert_eq!(value["requestId"], 7);
        assert_eq!(value["type"], "hello");
        assert_eq!(value["protocolMajor"], 1);
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
