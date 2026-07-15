use std::{
    collections::{BTreeMap, BTreeSet, HashMap, HashSet},
    io::{Read, Write},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering},
        mpsc,
    },
    time::{Duration, Instant},
};

use anyhow::{Context, Result};
use ghostty_adapter::{GhosttyTerminalCore, TerminalSnapshot};
use portable_pty::{Child, CommandBuilder, MasterPty, PtySize, native_pty_system};
use serde::{Deserialize, Serialize};
use text_engine::{FontStyle, GlyphDefinition, ShapedRow, StyleSpan, TextEngine};
use tokio::sync::broadcast;
use uuid::Uuid;

use crate::frame::{FrameCursor, TextSnapshot, encode_text_snapshot};

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum Persistence {
    TerminateWithApp,
    KeepUntilExit,
    KeepUntilExplicitClose,
}

pub type ExitCallback = Arc<dyn Fn(String, Option<i32>, Persistence) + Send + Sync>;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpawnOptions {
    pub executable: String,
    #[serde(default)]
    pub args: Vec<String>,
    pub cwd: Option<String>,
    #[serde(default)]
    pub env: HashMap<String, String>,
    pub cols: u16,
    pub rows: u16,
    pub persistence: Persistence,
}

#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum KeyAction {
    Down,
    Up,
}

#[derive(Deserialize)]
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
}

#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MouseAction {
    Press,
    Release,
    Motion,
}

#[derive(Deserialize)]
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
}

pub struct Session {
    summary: Mutex<SessionSummary>,
    handle: u64,
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
    active_views: AtomicUsize,
}

struct PtyProcess {
    master: Mutex<Box<dyn MasterPty + Send>>,
    writer: Mutex<Box<dyn Write + Send>>,
    child: Mutex<Box<dyn Child + Send + Sync>>,
}

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

    fn wait(&self) -> Option<i32> {
        self.child
            .lock()
            .unwrap()
            .wait()
            .ok()
            .and_then(|status| i32::try_from(status.exit_code()).ok())
    }

    fn terminate(&self) -> Result<()> {
        let mut child = self.child.lock().unwrap();
        if child.try_wait()?.is_none() {
            child.kill()?;
        }
        Ok(())
    }
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
        for (key, value) in env {
            command.env(key, value);
        }
        command.env("TERM", "xterm-256color");
        let child = pair
            .slave
            .spawn_command(command)
            .context("failed to spawn PTY command")?;
        drop(pair.slave);
        let reader = pair.master.try_clone_reader()?;
        let writer = pair.master.take_writer()?;
        let id = Uuid::new_v4().to_string();
        let handle = u64::from_le_bytes(Uuid::parse_str(&id)?.as_bytes()[..8].try_into().unwrap());
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
            }),
            handle,
            process: PtyProcess {
                master: Mutex::new(pair.master),
                writer: Mutex::new(writer),
                child: Mutex::new(child),
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
            active_views: AtomicUsize::new(0),
        });
        Self::start_reader(&session, reader);
        Ok(session)
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
                session.summary.lock().unwrap().exited = true;
                let exit_code = session.process.wait();
                if session.has_active_views()
                    && let Ok(snapshot) = session.terminal.lock().unwrap().snapshot()
                {
                    session.publish_snapshot(snapshot);
                }
                (session.on_exit)(session.id(), exit_code, session.persistence);
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
            session_epoch: 1,
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
    pub fn has_exited(&self) -> bool {
        self.exited.load(Ordering::Acquire)
    }
    pub fn persistence(&self) -> Persistence {
        self.persistence
    }
    pub fn attach_view(&self) {
        self.active_views.fetch_add(1, Ordering::AcqRel);
    }
    pub fn detach_view(&self) {
        let _ = self
            .active_views
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |count| {
                Some(count.saturating_sub(1))
            });
    }
    pub fn has_active_views(&self) -> bool {
        self.active_views.load(Ordering::Acquire) > 0
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

    pub fn write(&self, text: &str) -> Result<()> {
        self.process.write(text.as_bytes())
    }

    pub fn paste(&self, text: &str) -> Result<()> {
        let bytes = self.terminal.lock().unwrap().encode_paste(text)?;
        self.process.write(&bytes)
    }

    pub fn key(&self, input: &KeyInput) -> Result<()> {
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
        let text = if input.key.chars().count() == 1 && !input.key.chars().any(char::is_control) {
            input.key.as_str()
        } else {
            ""
        };
        let bytes = self
            .terminal
            .lock()
            .unwrap()
            .encode_key(&input.code, text, mods, action)?;
        self.process.write(&bytes)
    }

    pub fn mouse(&self, input: &MouseInput) -> Result<()> {
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

    pub fn scroll(&self, rows: isize) -> Result<()> {
        if rows == 0 {
            return Ok(());
        }
        let (snapshot, alternate_input) = {
            let mut terminal = self.terminal.lock().unwrap();
            if terminal.alternate_scroll() {
                let code = if rows < 0 { "ArrowUp" } else { "ArrowDown" };
                let mut input = Vec::new();
                for _ in 0..rows.unsigned_abs().min(100) {
                    input.extend_from_slice(&terminal.encode_key(code, "", 0, 1)?);
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

    pub fn focus(&self, focused: bool) -> Result<()> {
        let bytes = self.terminal.lock().unwrap().encode_focus(focused)?;
        self.process.write(&bytes)
    }

    pub fn resize(&self, cols: u16, rows: u16) -> Result<()> {
        self.process.resize(cols, rows)?;
        let snapshot = {
            let mut terminal = self.terminal.lock().unwrap();
            terminal.resize(cols, rows)?;
            terminal.snapshot()?
        };
        self.layout_epoch.fetch_add(1, Ordering::AcqRel);
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

    pub fn interrupt(&self) -> Result<()> {
        self.write("\u{3}")
    }

    pub fn terminate(&self) -> Result<()> {
        if self.has_exited() {
            return Ok(());
        }
        self.process.terminate()
    }
}
