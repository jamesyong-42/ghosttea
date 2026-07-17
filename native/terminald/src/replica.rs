use std::{
    collections::{BTreeMap, HashSet},
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
};

use anyhow::{Context, Result, bail, ensure};
use ghosttea_text::{FontStyle, GlyphDefinition, ShapedRow, StyleSpan, TextEngine};
use ghosttea_vt::{CellStyle, TerminalCell, TerminalScrollbar};
use tokio::sync::broadcast;
use uuid::Uuid;

use crate::{
    frame::{FrameCursor, TextSnapshot, encode_text_snapshot},
    session::SessionSummary,
    tunnel_protocol::{
        LogicalCellStyle, LogicalRow, LogicalTerminalPatch, LogicalTerminalSnapshot,
    },
};

#[derive(Default)]
struct ReplicaState {
    latest: Option<LogicalTerminalSnapshot>,
    patch_sequence: u64,
}

#[derive(Default)]
struct ReplicaRenderCache {
    rows: Vec<String>,
    cells: Vec<Vec<TerminalCell>>,
    shaped_rows: Vec<ShapedRow>,
    sent_glyphs: HashSet<u32>,
}

pub struct RemoteReplica {
    summary: Mutex<SessionSummary>,
    sequence: AtomicU64,
    state: Mutex<ReplicaState>,
    render_cache: Mutex<ReplicaRenderCache>,
    frames: broadcast::Sender<Vec<u8>>,
    text_engine: Arc<Mutex<TextEngine>>,
}

impl RemoteReplica {
    pub fn new(
        title: String,
        cwd: Option<String>,
        cols: u16,
        rows: u16,
        frames: broadcast::Sender<Vec<u8>>,
        text_engine: Arc<Mutex<TextEngine>>,
    ) -> Arc<Self> {
        let id = Uuid::new_v4();
        let bytes = *id.as_bytes();
        let handle = u64::from_le_bytes(bytes[..8].try_into().unwrap());
        Arc::new(Self {
            summary: Mutex::new(SessionSummary {
                id: id.to_string(),
                handle: handle.to_string(),
                executable: "remote-terminal".into(),
                cols,
                rows,
                exited: false,
                read_write: false,
                title: Some(title),
                cwd,
                bell_count: 0,
                pid: None,
                created_at_ms: 0,
                exit_code: None,
                exit_signal: None,
                requested_termination: None,
                exit_outcome: None,
            }),
            sequence: AtomicU64::new(0),
            state: Mutex::new(ReplicaState::default()),
            render_cache: Mutex::new(ReplicaRenderCache::default()),
            frames,
            text_engine,
        })
    }

    pub fn summary(&self) -> SessionSummary {
        self.summary.lock().unwrap().clone()
    }

    pub fn set_read_write(&self, read_write: bool) {
        self.summary.lock().unwrap().read_write = read_write;
    }

    pub fn publish(&self, snapshot: LogicalTerminalSnapshot) -> Result<()> {
        if snapshot.rows.len() > u16::MAX as usize {
            bail!("remote terminal snapshot has too many rows");
        }
        let updated_rows = (0..snapshot.rows.len())
            .map(u16::try_from)
            .collect::<std::result::Result<Vec<_>, _>>()?;
        self.render(&snapshot, &updated_rows, true)?;
        let mut state = self.state.lock().unwrap();
        state.latest = Some(snapshot);
        state.patch_sequence = 0;
        Ok(())
    }

    pub fn publish_patch(&self, patch: LogicalTerminalPatch) -> Result<()> {
        let mut state = self.state.lock().unwrap();
        let expected_sequence = state.patch_sequence.saturating_add(1);
        ensure!(
            patch.patch_sequence == expected_sequence,
            "remote terminal patch sequence gap"
        );
        let mut snapshot = state
            .latest
            .clone()
            .ok_or_else(|| anyhow::anyhow!("remote terminal patch arrived before a snapshot"))?;
        ensure!(
            patch.session_epoch == snapshot.session_epoch,
            "remote terminal session epoch changed"
        );
        ensure!(
            patch.layout_epoch == snapshot.layout_epoch,
            "remote terminal layout epoch changed"
        );
        ensure!(
            patch.terminal_revision > snapshot.terminal_revision,
            "stale remote terminal patch"
        );

        let mut updated_rows = Vec::with_capacity(patch.row_replacements.len());
        for replacement in patch.row_replacements {
            ensure!(
                replacement.row_revision == patch.terminal_revision,
                "remote terminal row revision does not match its patch"
            );
            let row = snapshot
                .rows
                .get_mut(replacement.row_index as usize)
                .context("remote terminal patch row is outside the snapshot")?;
            *row = replacement.row;
            updated_rows.push(replacement.row_index);
        }
        if let Some(cursor) = patch.cursor {
            snapshot.cursor = cursor;
        }
        if let Some(mouse_tracking) = patch.mouse_tracking {
            snapshot.mouse_tracking = mouse_tracking;
        }
        if let Some(scrollbar) = patch.scrollbar {
            snapshot.scrollbar = scrollbar;
        }
        snapshot.terminal_revision = patch.terminal_revision;
        state.latest = Some(snapshot.clone());
        state.patch_sequence = patch.patch_sequence;
        drop(state);
        self.render(&snapshot, &updated_rows, false)
    }

    fn render(
        &self,
        snapshot: &LogicalTerminalSnapshot,
        updated_rows: &[u16],
        full_snapshot: bool,
    ) -> Result<()> {
        let mut cache = self.render_cache.lock().unwrap();
        if full_snapshot {
            cache.rows = vec![String::new(); snapshot.rows.len()];
            cache.cells = vec![Vec::new(); snapshot.rows.len()];
            cache.shaped_rows = vec![ShapedRow::default(); snapshot.rows.len()];
            cache.sent_glyphs.clear();
        } else {
            ensure!(
                cache.rows.len() == snapshot.rows.len(),
                "remote terminal patch changed row count"
            );
        }

        let mut definitions = BTreeMap::<u32, GlyphDefinition>::new();
        let mut engine = self.text_engine.lock().unwrap();
        for row_index in updated_rows.iter().copied() {
            let logical = snapshot
                .rows
                .get(row_index as usize)
                .context("remote terminal updated row is outside the snapshot")?;
            let (text, cells, shaped) = shape_logical_row(&mut engine, logical)?;
            for definition in &shaped.definitions {
                if cache.sent_glyphs.insert(definition.id) {
                    definitions
                        .entry(definition.id)
                        .or_insert_with(|| definition.clone());
                }
            }
            cache.rows[row_index as usize] = text;
            cache.cells[row_index as usize] = cells;
            cache.shaped_rows[row_index as usize] = shaped;
        }
        drop(engine);

        let row_count = u16::try_from(cache.rows.len())?;
        let cursor = FrameCursor {
            x: snapshot.cursor.x,
            y: snapshot.cursor.y,
            visible: snapshot.cursor.visible,
            style: snapshot.cursor.style,
            blinking: snapshot.cursor.blinking,
        };
        let mut summary = self.summary.lock().unwrap();
        summary.cols = snapshot.cols;
        summary.rows = row_count;
        summary.title = snapshot.title.clone().or_else(|| summary.title.clone());
        summary.cwd = snapshot.cwd.clone();
        let handle = summary.handle.parse::<u64>()?;
        drop(summary);
        let sequence = self.sequence.fetch_add(1, Ordering::AcqRel) + 1;
        let definitions = definitions.into_values().collect::<Vec<_>>();
        let scrollbar = TerminalScrollbar {
            total: snapshot.scrollbar.total,
            offset: snapshot.scrollbar.offset,
            len: snapshot.scrollbar.len,
        };
        let frame = encode_text_snapshot(TextSnapshot {
            session_handle: handle,
            session_epoch: snapshot.session_epoch,
            layout_epoch: snapshot.layout_epoch,
            sequence,
            revision: snapshot.terminal_revision,
            cols: snapshot.cols,
            rows: &cache.rows,
            shaped_rows: &cache.shaped_rows,
            cells: &cache.cells,
            updated_rows,
            full_snapshot,
            mouse_tracking: snapshot.mouse_tracking,
            scrollbar: &scrollbar,
            new_glyph_definitions: &definitions,
            clipboard: None,
            cursor: &cursor,
        })?;
        let _ = self.frames.send(frame);
        Ok(())
    }

    pub fn refresh(&self) -> Result<()> {
        let snapshot =
            self.state.lock().unwrap().latest.clone().ok_or_else(|| {
                anyhow::anyhow!("remote terminal has not published a snapshot yet")
            })?;
        self.publish(snapshot)
    }
}

fn shape_logical_row(
    engine: &mut TextEngine,
    row: &LogicalRow,
) -> Result<(String, Vec<TerminalCell>, ShapedRow)> {
    let text = row.text.clone();
    let cells = row
        .cells
        .iter()
        .map(|cell| TerminalCell {
            column: cell.column,
            span: cell.span,
            text: cell.text.clone(),
            style: cell_style(cell.style),
        })
        .collect::<Vec<_>>();
    let mut byte_offset = 0;
    let spans = cells
        .iter()
        .filter_map(|cell| {
            if byte_offset >= text.len() {
                return None;
            }
            let byte_start = byte_offset;
            byte_offset = (byte_offset + cell.text.len()).min(text.len());
            Some(StyleSpan {
                byte_start,
                byte_end: byte_offset,
                style: FontStyle {
                    bold: cell.style.bold,
                    italic: cell.style.italic,
                },
            })
        })
        .collect::<Vec<_>>();
    let shaped = engine.shape_styled_row(&text, &spans)?;
    Ok((text, cells, shaped))
}

fn cell_style(style: LogicalCellStyle) -> CellStyle {
    CellStyle {
        bold: style.bold,
        italic: style.italic,
        faint: style.faint,
        inverse: style.inverse,
        invisible: style.invisible,
        strikethrough: style.strikethrough,
        underline: style.underline,
        foreground: style.foreground,
        background: style.background,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tunnel_protocol::{
        LogicalCell, LogicalCursor, LogicalRow, LogicalScrollbar, LogicalTerminalPatch,
        RowReplacement,
    };

    #[test]
    fn logical_snapshot_is_shaped_into_a_local_full_frame() {
        let (frames, mut receiver) = broadcast::channel(2);
        let engine = Arc::new(Mutex::new(TextEngine::discover().unwrap()));
        let replica = RemoteReplica::new("remote".into(), None, 20, 1, frames, engine);
        replica
            .publish(LogicalTerminalSnapshot {
                session_epoch: 7,
                layout_epoch: 3,
                terminal_revision: 11,
                cols: 20,
                rows: vec![LogicalRow {
                    text: "hello".into(),
                    cells: vec![LogicalCell {
                        column: 0,
                        span: 5,
                        text: "hello".into(),
                        style: LogicalCellStyle::default(),
                    }],
                }],
                cursor: LogicalCursor {
                    x: 5,
                    y: 0,
                    visible: true,
                    style: 0,
                    blinking: true,
                },
                mouse_tracking: false,
                scrollbar: crate::tunnel_protocol::LogicalScrollbar {
                    total: 12,
                    offset: 11,
                    len: 1,
                },
                title: Some("remote title".into()),
                cwd: Some("/remote".into()),
            })
            .unwrap();
        let frame = receiver.try_recv().unwrap();
        assert_eq!(u64::from_le_bytes(frame[24..32].try_into().unwrap()), 7);
        assert_eq!(u64::from_le_bytes(frame[32..40].try_into().unwrap()), 3);
        assert_eq!(replica.summary().title.as_deref(), Some("remote title"));
    }

    #[test]
    fn logical_patch_updates_only_changed_rows_in_the_local_frame() {
        let (frames, mut receiver) = broadcast::channel(2);
        let engine = Arc::new(Mutex::new(TextEngine::discover().unwrap()));
        let replica = RemoteReplica::new("remote".into(), None, 20, 1, frames, engine);
        replica
            .publish(LogicalTerminalSnapshot {
                session_epoch: 7,
                layout_epoch: 3,
                terminal_revision: 11,
                cols: 20,
                rows: vec![LogicalRow {
                    text: "hello".into(),
                    cells: vec![],
                }],
                cursor: LogicalCursor::default(),
                mouse_tracking: false,
                scrollbar: LogicalScrollbar::default(),
                title: Some("remote".into()),
                cwd: None,
            })
            .unwrap();
        let _ = receiver.try_recv().unwrap();

        replica
            .publish_patch(LogicalTerminalPatch {
                session_epoch: 7,
                layout_epoch: 3,
                patch_sequence: 1,
                terminal_revision: 12,
                row_replacements: vec![RowReplacement {
                    row_index: 0,
                    row_revision: 12,
                    row: LogicalRow {
                        text: "world".into(),
                        cells: vec![],
                    },
                }],
                cursor: Some(LogicalCursor {
                    x: 5,
                    ..LogicalCursor::default()
                }),
                mouse_tracking: None,
                scrollbar: None,
            })
            .unwrap();

        let frame = receiver.try_recv().unwrap();
        assert_eq!(u16::from_le_bytes(frame[6..8].try_into().unwrap()) & 1, 0);
        assert_eq!(u64::from_le_bytes(frame[48..56].try_into().unwrap()), 12);
        assert_eq!(u32::from_le_bytes(frame[108..112].try_into().unwrap()), 1);
    }
}
