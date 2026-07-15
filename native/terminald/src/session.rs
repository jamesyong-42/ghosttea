use std::{
    collections::{BTreeMap, BTreeSet, HashMap, HashSet},
    io::{Read, Write},
    sync::{atomic::{AtomicBool, AtomicU64, Ordering}, mpsc, Arc, Mutex},
    time::{Duration, Instant},
};

use anyhow::{Context, Result};
use ghostty_adapter::{GhosttyTerminalCore, TerminalSnapshot};
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use tokio::sync::broadcast;
use text_engine::{FontStyle, GlyphDefinition, ShapedRow, StyleSpan, TextEngine};
use uuid::Uuid;

use crate::frame::{encode_text_snapshot, FrameCursor};

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
    master: Mutex<Box<dyn MasterPty + Send>>,
    writer: Mutex<Box<dyn Write + Send>>,
    child: Mutex<Box<dyn Child + Send + Sync>>,
    terminal: Mutex<GhosttyTerminalCore>,
    sequence: AtomicU64,
    revision: AtomicU64,
    layout_epoch: AtomicU64,
    exited: AtomicBool,
    frames: broadcast::Sender<Vec<u8>>,
    text_engine: Arc<Mutex<TextEngine>>,
    render_cache: Mutex<RenderCache>,
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
        Self { rows: Vec::new(), sent_glyphs: HashSet::new(), force_full: true, reset_catalog: true }
    }
}

impl Session {
    pub fn spawn(executable: String, args: Vec<String>, cwd: Option<String>, env: HashMap<String, String>, cols: u16, rows: u16, frames: broadcast::Sender<Vec<u8>>, text_engine: Arc<Mutex<TextEngine>>) -> Result<Arc<Self>> {
        let pair = native_pty_system().openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })?;
        let mut command = CommandBuilder::new(&executable);
        command.args(args);
        if let Some(cwd) = cwd { command.cwd(cwd); }
        for (key, value) in env { command.env(key, value); }
        command.env("TERM", "xterm-256color");
        let child = pair.slave.spawn_command(command).context("failed to spawn PTY command")?;
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
            master: Mutex::new(pair.master),
            writer: Mutex::new(writer),
            child: Mutex::new(child),
            terminal: Mutex::new(GhosttyTerminalCore::new(cols, rows, 10_000)?),
            sequence: AtomicU64::new(0),
            revision: AtomicU64::new(0),
            layout_epoch: AtomicU64::new(1),
            exited: AtomicBool::new(false),
            frames,
            text_engine,
            render_cache: Mutex::new(RenderCache::new()),
        });
        Self::start_reader(&session, reader);
        Ok(session)
    }

    fn start_reader(session: &Arc<Self>, mut reader: Box<dyn Read + Send>) {
        const FRAME_INTERVAL: Duration = Duration::from_millis(8);
        const MAX_BATCH_BYTES: usize = 256 * 1024;
        let (output_tx, output_rx) = mpsc::sync_channel::<Vec<u8>>(32);
        let reader_id = session.id();
        std::thread::Builder::new().name(format!("pty-read-{reader_id}")).spawn(move || {
            let mut bytes = [0_u8; 16 * 1024];
            while let Ok(count) = reader.read(&mut bytes) {
                if count == 0 { break; }
                if output_tx.send(bytes[..count].to_vec()).is_err() { break; }
            }
        }).expect("PTY read thread");

        let session = Arc::clone(session);
        std::thread::Builder::new().name(format!("pty-frame-{}", session.id())).spawn(move || {
            while let Ok(first) = output_rx.recv() {
                let deadline = Instant::now() + FRAME_INTERVAL;
                let mut batch = first;
                while batch.len() < MAX_BATCH_BYTES {
                    let now = Instant::now();
                    if now >= deadline { break; }
                    match output_rx.recv_timeout(deadline.saturating_duration_since(now)) {
                        Ok(bytes) => batch.extend_from_slice(&bytes),
                        Err(mpsc::RecvTimeoutError::Timeout) => break,
                        Err(mpsc::RecvTimeoutError::Disconnected) => break,
                    }
                }
                let snapshot = {
                    let mut terminal = session.terminal.lock().unwrap();
                    terminal.feed(&batch);
                    terminal.snapshot()
                };
                match snapshot {
                    Ok(snapshot) => session.publish_snapshot(snapshot),
                    Err(error) => eprintln!("ghostty snapshot failed for {}: {error}", session.id()),
                }
            }
            session.exited.store(true, Ordering::Release);
            session.summary.lock().unwrap().exited = true;
            if let Ok(snapshot) = session.terminal.lock().unwrap().snapshot() {
                session.publish_snapshot(snapshot);
            }
        }).expect("PTY reader thread");
    }

    fn publish_snapshot(&self, snapshot: TerminalSnapshot) {
        if !snapshot.pty_response.is_empty() {
            let mut writer = self.writer.lock().unwrap();
            let _ = writer.write_all(&snapshot.pty_response);
            let _ = writer.flush();
        }
        let mut summary = self.summary.lock().unwrap();
        summary.cols = snapshot.cols;
        summary.rows = snapshot.rows.len() as u16;
        summary.title = snapshot.title.clone();
        summary.cwd = snapshot.cwd.clone();
        if snapshot.bell { summary.bell_count = summary.bell_count.saturating_add(1); }
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
            if cache_resized { cache.rows.resize_with(row_count, || None); }
            let full_snapshot = snapshot.damage.full || cache.force_full || cache_resized;
            let mut updated: BTreeSet<u16> = if full_snapshot {
                (0..row_count.min(u16::MAX as usize)).map(|row| row as u16).collect()
            } else {
                snapshot.damage.dirty_rows.iter().copied().filter(|row| (*row as usize) < row_count).collect()
            };
            for (row, cached) in cache.rows.iter().enumerate() {
                if cached.is_none() { updated.insert(row as u16); }
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
                let span_tuples: Vec<_> = cells.iter().filter_map(|cell| {
                    if byte_offset >= row.len() { return None; }
                    let byte_start = byte_offset;
                    byte_offset = (byte_offset + cell.text.len()).min(row.len());
                    Some((byte_start, byte_offset, FontStyle { bold: cell.style.bold, italic: cell.style.italic }))
                }).collect();
                let key = RowShapeKey { text: row.clone(), spans: span_tuples.clone() };
                if cache.rows[row_index as usize].as_ref().is_some_and(|cached| cached.key == key) { continue; }
                let spans: Vec<_> = span_tuples.into_iter().map(|(byte_start, byte_end, style)| StyleSpan { byte_start, byte_end, style }).collect();
                match engine.shape_styled_row(row, &spans) {
                    Ok(shaped) => cache.rows[row_index as usize] = Some(CachedRow { key, shaped }),
                    Err(error) => {
                        eprintln!("native text shaping failed for {} row {row_index}: {error}", self.id());
                        return;
                    }
                }
            }
            cache.force_full = false;
            let shaped_rows: Vec<_> = cache.rows.iter().map(|row| row.as_ref().map(|cached| cached.shaped.clone()).unwrap_or_default()).collect();
            let mut new_definitions = BTreeMap::<u32, GlyphDefinition>::new();
            for row_index in &updated {
                for definition in &shaped_rows[*row_index as usize].definitions {
                    if cache.sent_glyphs.insert(definition.id) {
                        new_definitions.insert(definition.id, definition.clone());
                    }
                }
            }
            (shaped_rows, updated.into_iter().collect::<Vec<_>>(), full_snapshot, new_definitions.into_values().collect::<Vec<_>>())
        };
        if let Ok(frame) = encode_text_snapshot(
            self.handle,
            1,
            self.layout_epoch.load(Ordering::Acquire),
            sequence,
            revision,
            cols,
            &snapshot.rows,
            &shaped_rows,
            &snapshot.cells,
            &updated_rows,
            full_snapshot,
            snapshot.mouse_tracking,
            &new_definitions,
            snapshot.clipboard.as_deref(),
            &cursor,
        ) {
            let _ = self.frames.send(frame);
        }
    }

    pub fn id(&self) -> String { self.summary.lock().unwrap().id.clone() }
    pub fn summary(&self) -> SessionSummary { self.summary.lock().unwrap().clone() }

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
        let mut writer = self.writer.lock().unwrap();
        writer.write_all(text.as_bytes())?;
        writer.flush()?;
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    pub fn key(
        &self,
        code: &str,
        key: &str,
        action: &str,
        repeat: bool,
        shift: bool,
        control: bool,
        alt: bool,
        meta: bool,
    ) -> Result<()> {
        let mut mods = 0_u16;
        if shift { mods |= 1 << 0; }
        if control { mods |= 1 << 1; }
        if alt { mods |= 1 << 2; }
        if meta { mods |= 1 << 3; }
        let action = match action {
            "up" => 0,
            "down" if repeat => 2,
            "down" => 1,
            _ => anyhow::bail!("invalid key action"),
        };
        let text = if key.chars().count() == 1 && !key.chars().any(char::is_control) { key } else { "" };
        let bytes = self.terminal.lock().unwrap().encode_key(code, text, mods, action)?;
        if !bytes.is_empty() {
            let mut writer = self.writer.lock().unwrap();
            writer.write_all(&bytes)?;
            writer.flush()?;
        }
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    pub fn mouse(
        &self,
        action: &str,
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
    ) -> Result<()> {
        let action = match action {
            "press" => 0,
            "release" => 1,
            "motion" => 2,
            _ => anyhow::bail!("invalid mouse action"),
        };
        let mut mods = 0_u16;
        if shift { mods |= 1 << 0; }
        if control { mods |= 1 << 1; }
        if alt { mods |= 1 << 2; }
        if meta { mods |= 1 << 3; }
        let bytes = self.terminal.lock().unwrap().encode_mouse(
            action, button, mods, x, y, screen_width, screen_height,
            cell_width, cell_height, padding_left, padding_top,
        )?;
        if !bytes.is_empty() {
            let mut writer = self.writer.lock().unwrap();
            writer.write_all(&bytes)?;
            writer.flush()?;
        }
        Ok(())
    }

    pub fn scroll(&self, rows: isize) -> Result<()> {
        if rows == 0 { return Ok(()); }
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
            let mut writer = self.writer.lock().unwrap();
            writer.write_all(&alternate_input)?;
            writer.flush()?;
        }
        if let Some(snapshot) = snapshot { self.publish_snapshot(snapshot); }
        Ok(())
    }

    pub fn focus(&self, focused: bool) -> Result<()> {
        let bytes = self.terminal.lock().unwrap().encode_focus(focused)?;
        if !bytes.is_empty() {
            let mut writer = self.writer.lock().unwrap();
            writer.write_all(&bytes)?;
            writer.flush()?;
        }
        Ok(())
    }

    pub fn resize(&self, cols: u16, rows: u16) -> Result<()> {
        self.master.lock().unwrap().resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })?;
        let snapshot = {
            let mut terminal = self.terminal.lock().unwrap();
            terminal.resize(cols, rows)?;
            terminal.snapshot()?
        };
        self.layout_epoch.fetch_add(1, Ordering::AcqRel);
        self.publish_snapshot(snapshot);
        Ok(())
    }

    pub fn set_colors(&self, foreground: [u8; 3], background: [u8; 3], cursor: [u8; 3]) -> Result<()> {
        let snapshot = {
            let mut terminal = self.terminal.lock().unwrap();
            terminal.set_colors(foreground, background, cursor)?;
            terminal.snapshot()?
        };
        self.publish_snapshot(snapshot);
        Ok(())
    }

    pub fn interrupt(&self) -> Result<()> { self.write("\u{3}") }

    pub fn terminate(&self) -> Result<()> {
        self.child.lock().unwrap().kill()?;
        Ok(())
    }
}
