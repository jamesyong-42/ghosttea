mod frame;
mod session;

use std::{collections::HashMap, env, path::Path, sync::{Arc, Mutex}};

use anyhow::{bail, Context, Result};
use serde::Deserialize;
use serde_json::{json, Value};
use session::Session;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{UnixListener, UnixStream},
    sync::{broadcast, RwLock},
};
use text_engine::TextEngine;

const MAX_CONTROL_BYTES: usize = 1024 * 1024;
const MAX_FRAME_BYTES: usize = 16 * 1024 * 1024;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Envelope {
    request_id: u64,
    #[serde(rename = "type")]
    kind: String,
    #[serde(flatten)]
    body: HashMap<String, Value>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateOptions {
    executable: String,
    #[serde(default)]
    args: Vec<String>,
    cwd: Option<String>,
    #[serde(default)]
    env: HashMap<String, String>,
    cols: u16,
    rows: u16,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct KeyEvent {
    #[serde(rename = "type")]
    action: String,
    key: String,
    code: String,
    repeat: bool,
    shift: bool,
    control: bool,
    alt: bool,
    meta: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MouseEvent {
    action: String,
    button: u8,
    x: f32,
    y: f32,
    screen_width: u32,
    screen_height: u32,
    cell_width: u32,
    cell_height: u32,
    padding_left: u32,
    padding_top: u32,
    shift: bool,
    control: bool,
    alt: bool,
    meta: bool,
}

type Registry = Arc<RwLock<HashMap<String, Arc<Session>>>>;

#[tokio::main]
async fn main() -> Result<()> {
    let control_path = env::var("TERMINALD_CONTROL_SOCKET").context("TERMINALD_CONTROL_SOCKET is required")?;
    let frame_path = env::var("TERMINALD_FRAME_SOCKET").context("TERMINALD_FRAME_SOCKET is required")?;
    let auth_token = env::var("TERMINALD_AUTH_TOKEN").context("TERMINALD_AUTH_TOKEN is required")?;
    remove_stale_socket(&control_path)?;
    remove_stale_socket(&frame_path)?;
    let control = UnixListener::bind(&control_path)?;
    let frames = UnixListener::bind(&frame_path)?;
    let (frame_tx, _) = broadcast::channel::<Vec<u8>>(32);
    let registry: Registry = Arc::new(RwLock::new(HashMap::new()));
    let text_engine = Arc::new(Mutex::new(TextEngine::discover().context("system font discovery failed")?));

    println!("terminald ready ({})", text_engine.lock().unwrap().primary_family());
    let control_task = serve_control(control, auth_token.clone(), Arc::clone(&registry), frame_tx.clone(), text_engine);
    let frame_task = serve_frames(frames, auth_token, frame_tx);
    tokio::try_join!(control_task, frame_task)?;
    Ok(())
}

fn remove_stale_socket(path: &str) -> Result<()> {
    if Path::new(path).exists() { std::fs::remove_file(path)?; }
    Ok(())
}

async fn read_packet(stream: &mut UnixStream, limit: usize) -> Result<Vec<u8>> {
    let length = stream.read_u32_le().await? as usize;
    if length > limit { bail!("packet exceeds limit"); }
    let mut bytes = vec![0; length];
    stream.read_exact(&mut bytes).await?;
    Ok(bytes)
}

async fn write_packet(stream: &mut UnixStream, bytes: &[u8]) -> Result<()> {
    stream.write_u32_le(bytes.len() as u32).await?;
    stream.write_all(bytes).await?;
    Ok(())
}

async fn authenticate(stream: &mut UnixStream, expected: &str) -> Result<()> {
    let token = read_packet(stream, 1024).await?;
    if token != expected.as_bytes() { bail!("authentication failed"); }
    write_packet(stream, b"ok").await
}

async fn serve_control(listener: UnixListener, token: String, registry: Registry, frame_tx: broadcast::Sender<Vec<u8>>, text_engine: Arc<Mutex<TextEngine>>) -> Result<()> {
    loop {
        let (mut socket, _) = listener.accept().await?;
        let token = token.clone();
        let registry = Arc::clone(&registry);
        let frame_tx = frame_tx.clone();
        let text_engine = Arc::clone(&text_engine);
        tokio::spawn(async move {
            if authenticate(&mut socket, &token).await.is_err() { return; }
            while let Ok(packet) = read_packet(&mut socket, MAX_CONTROL_BYTES).await {
                let response = match serde_json::from_slice::<Envelope>(&packet) {
                    Ok(command) => handle_command(command, &registry, frame_tx.clone(), Arc::clone(&text_engine)).await,
                    Err(error) => json!({ "requestId": 0, "type": "error", "message": error.to_string() }),
                };
                if write_packet(&mut socket, &serde_json::to_vec(&response).unwrap()).await.is_err() { break; }
            }
        });
    }
}

async fn handle_command(command: Envelope, registry: &Registry, frame_tx: broadcast::Sender<Vec<u8>>, text_engine: Arc<Mutex<TextEngine>>) -> Value {
    let request_id = command.request_id;
    let result: Result<Value> = async {
        match command.kind.as_str() {
            "hello" => Ok(json!({ "requestId": request_id, "type": "hello", "protocolMajor": 1, "protocolMinor": 0, "serverBuild": env!("CARGO_PKG_VERSION") })),
            "create-session" => {
                let options: CreateOptions = serde_json::from_value(command.body.get("options").cloned().context("missing options")?)?;
                let session = Session::spawn(options.executable, options.args, options.cwd, options.env, options.cols, options.rows, frame_tx, text_engine)?;
                let summary = session.summary();
                registry.write().await.insert(summary.id.clone(), session);
                Ok(json!({ "requestId": request_id, "type": "session-created", "session": summary }))
            }
            "list-sessions" => {
                let active: Vec<_> = registry.read().await.values().cloned().collect();
                let sessions: Vec<_> = active.iter().map(|session| session.summary()).collect();
                for session in active { session.refresh()?; }
                Ok(json!({ "requestId": request_id, "type": "sessions", "sessions": sessions }))
            }
            "get-session" => {
                let session_id = command.body.get("sessionId").and_then(Value::as_str).context("missing sessionId")?;
                let session = registry.read().await.get(session_id).cloned().context("unknown session")?;
                Ok(json!({ "requestId": request_id, "type": "session", "session": session.summary() }))
            }
            "send-text" | "send-key" | "send-mouse" | "scroll" | "focus" | "resize" | "set-colors" | "interrupt" | "terminate" => {
                let session_id = command.body.get("sessionId").and_then(Value::as_str).context("missing sessionId")?;
                let session = registry.read().await.get(session_id).cloned().context("unknown session")?;
                match command.kind.as_str() {
                    "send-text" => session.write(command.body.get("text").and_then(Value::as_str).context("missing text")?)?,
                    "send-key" => {
                        let event: KeyEvent = serde_json::from_value(
                            command.body.get("event").cloned().context("missing key event")?,
                        )?;
                        session.key(
                            &event.code,
                            &event.key,
                            &event.action,
                            event.repeat,
                            event.shift,
                            event.control,
                            event.alt,
                            event.meta,
                        )?;
                    }
                    "send-mouse" => {
                        let event: MouseEvent = serde_json::from_value(
                            command.body.get("event").cloned().context("missing mouse event")?,
                        )?;
                        if event.screen_width > 32_768 || event.screen_height > 32_768 ||
                            event.cell_width == 0 || event.cell_height == 0 ||
                            !event.x.is_finite() || !event.y.is_finite() {
                            bail!("invalid mouse geometry");
                        }
                        session.mouse(
                            &event.action, event.button, event.x, event.y,
                            event.screen_width, event.screen_height,
                            event.cell_width, event.cell_height,
                            event.padding_left, event.padding_top,
                            event.shift, event.control, event.alt, event.meta,
                        )?;
                    }
                    "scroll" => {
                        let rows = command.body.get("rows").and_then(Value::as_i64).context("missing rows")?;
                        session.scroll(isize::try_from(rows.clamp(-10_000, 10_000))?)?;
                    }
                    "focus" => session.focus(
                        command.body.get("focused").and_then(Value::as_bool).context("missing focused")?,
                    )?,
                    "resize" => session.resize(command.body.get("cols").and_then(Value::as_u64).context("missing cols")? as u16, command.body.get("rows").and_then(Value::as_u64).context("missing rows")? as u16)?,
                    "set-colors" => session.set_colors(
                        serde_json::from_value(command.body.get("foreground").cloned().context("missing foreground")?)?,
                        serde_json::from_value(command.body.get("background").cloned().context("missing background")?)?,
                        serde_json::from_value(command.body.get("cursor").cloned().context("missing cursor")?)?,
                    )?,
                    "interrupt" => session.interrupt()?,
                    "terminate" => session.terminate()?,
                    _ => unreachable!(),
                }
                Ok(json!({ "requestId": request_id, "type": "ok" }))
            }
            _ => bail!("unknown command {}", command.kind),
        }
    }.await;
    result.unwrap_or_else(|error| json!({ "requestId": request_id, "type": "error", "message": error.to_string() }))
}

async fn serve_frames(listener: UnixListener, token: String, frame_tx: broadcast::Sender<Vec<u8>>) -> Result<()> {
    loop {
        let (mut socket, _) = listener.accept().await?;
        let token = token.clone();
        let mut rx = frame_tx.subscribe();
        tokio::spawn(async move {
            if authenticate(&mut socket, &token).await.is_err() { return; }
            loop {
                match rx.recv().await {
                    Ok(frame) if frame.len() <= MAX_FRAME_BYTES => {
                        if write_packet(&mut socket, &frame).await.is_err() { break; }
                    }
                    Ok(_) => break,
                    Err(broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(_) => break,
                }
            }
        });
    }
}
