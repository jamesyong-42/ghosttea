use std::{
    collections::BTreeMap,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
};

use anyhow::{Result, bail};
use ghosttea_text::{FontStyle, GlyphDefinition, StyleSpan, TextEngine};
use ghosttea_vt::{CellStyle, TerminalCell, TerminalScrollbar};
use tokio::sync::broadcast;
use uuid::Uuid;

use crate::{
    frame::{FrameCursor, TextSnapshot, encode_text_snapshot},
    session::SessionSummary,
    tunnel_protocol::{LogicalCellStyle, LogicalTerminalSnapshot},
};

pub struct RemoteReplica {
    summary: Mutex<SessionSummary>,
    sequence: AtomicU64,
    latest: Mutex<Option<LogicalTerminalSnapshot>>,
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
            latest: Mutex::new(None),
            frames,
            text_engine,
        })
    }

    pub fn summary(&self) -> SessionSummary {
        self.summary.lock().unwrap().clone()
    }

    pub fn publish(&self, snapshot: LogicalTerminalSnapshot) -> Result<()> {
        *self.latest.lock().unwrap() = Some(snapshot.clone());
        if snapshot.rows.len() > u16::MAX as usize {
            bail!("remote terminal snapshot has too many rows");
        }
        let rows = snapshot
            .rows
            .iter()
            .map(|row| row.text.clone())
            .collect::<Vec<_>>();
        let cells = snapshot
            .rows
            .iter()
            .map(|row| {
                row.cells
                    .iter()
                    .map(|cell| TerminalCell {
                        column: cell.column,
                        span: cell.span,
                        text: cell.text.clone(),
                        style: cell_style(cell.style),
                    })
                    .collect::<Vec<_>>()
            })
            .collect::<Vec<_>>();
        let mut engine = self.text_engine.lock().unwrap();
        let mut definitions = BTreeMap::<u32, GlyphDefinition>::new();
        let mut shaped_rows = Vec::with_capacity(rows.len());
        for (text, row_cells) in rows.iter().zip(&cells) {
            let mut byte_offset = 0;
            let spans = row_cells
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
            let shaped = engine.shape_styled_row(text, &spans)?;
            for definition in &shaped.definitions {
                definitions
                    .entry(definition.id)
                    .or_insert_with(|| definition.clone());
            }
            shaped_rows.push(shaped);
        }
        drop(engine);

        let row_count = u16::try_from(rows.len())?;
        let updated_rows = (0..row_count).collect::<Vec<_>>();
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
            rows: &rows,
            shaped_rows: &shaped_rows,
            cells: &cells,
            updated_rows: &updated_rows,
            full_snapshot: true,
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
            self.latest.lock().unwrap().clone().ok_or_else(|| {
                anyhow::anyhow!("remote terminal has not published a snapshot yet")
            })?;
        self.publish(snapshot)
    }
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
    use crate::tunnel_protocol::{LogicalCell, LogicalCursor, LogicalRow};

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
}
