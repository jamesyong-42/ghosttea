use std::{
    collections::{BTreeMap, HashSet},
    sync::Arc,
    time::Instant,
};

use anyhow::{Context, Result, bail, ensure};
use ghosttea_text::{FontStyle, GlyphDefinition, ShapedRow, StyleSpan};
use ghosttea_vt::{CellStyle, TerminalCell, TerminalScrollbar};

use crate::{
    FrameCursor, LogicalCellStyle, LogicalRow, LogicalTerminalPatch, LogicalTerminalSnapshot,
    TerminalEffect, TerminalRuntime, TerminalUpdate, TextEnginePerformanceSnapshot, TextSnapshot,
    encode_text_snapshot,
};

#[derive(Default)]
struct ReplicaRenderCache {
    rows: Vec<String>,
    cells: Vec<Vec<TerminalCell>>,
    shaped_rows: Vec<ShapedRow>,
    sent_glyphs: HashSet<u32>,
}

/// Reconstructs and renders logical terminal state received from another host.
pub struct LogicalReplicaModel {
    runtime: Arc<TerminalRuntime>,
    session_handle: u64,
    frame_sequence: u64,
    latest: Option<LogicalTerminalSnapshot>,
    patch_sequence: u64,
    render_cache: ReplicaRenderCache,
    text_engine_performance: TextEnginePerformanceSnapshot,
}

impl LogicalReplicaModel {
    pub fn new(runtime: Arc<TerminalRuntime>, session_handle: u64) -> Self {
        Self {
            runtime,
            session_handle,
            frame_sequence: 0,
            latest: None,
            patch_sequence: 0,
            render_cache: ReplicaRenderCache::default(),
            text_engine_performance: TextEnginePerformanceSnapshot::default(),
        }
    }

    pub fn latest(&self) -> Option<LogicalTerminalSnapshot> {
        self.latest.clone()
    }

    pub fn text_engine_performance(&self) -> TextEnginePerformanceSnapshot {
        self.text_engine_performance
    }

    pub fn publish(&mut self, snapshot: LogicalTerminalSnapshot) -> Result<TerminalUpdate> {
        if snapshot.rows.len() > u16::MAX as usize {
            bail!("remote terminal snapshot has too many rows");
        }
        let updated_rows = (0..snapshot.rows.len())
            .map(u16::try_from)
            .collect::<std::result::Result<Vec<_>, _>>()?;
        let frame = self.render(&snapshot, &updated_rows, true)?;
        self.latest = Some(snapshot);
        self.patch_sequence = 0;
        Ok([TerminalEffect::FrameReady(frame)].into_iter().collect())
    }

    pub fn publish_patch(&mut self, patch: LogicalTerminalPatch) -> Result<TerminalUpdate> {
        let expected_sequence = self.patch_sequence.saturating_add(1);
        ensure!(
            patch.patch_sequence == expected_sequence,
            "remote terminal patch sequence gap"
        );
        let mut snapshot = self
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

        let frame = self.render(&snapshot, &updated_rows, false)?;
        self.latest = Some(snapshot);
        self.patch_sequence = patch.patch_sequence;
        Ok([TerminalEffect::FrameReady(frame)].into_iter().collect())
    }

    pub fn refresh(&mut self) -> Result<TerminalUpdate> {
        let snapshot = self
            .latest
            .clone()
            .ok_or_else(|| anyhow::anyhow!("remote terminal has not published a snapshot yet"))?;
        self.publish(snapshot)
    }

    fn render(
        &mut self,
        snapshot: &LogicalTerminalSnapshot,
        updated_rows: &[u16],
        full_snapshot: bool,
    ) -> Result<Vec<u8>> {
        let cache = &mut self.render_cache;
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
        let wait_started = Instant::now();
        let mut engine = self.runtime.text_engine().lock().unwrap();
        let wait = wait_started.elapsed();
        let hold_started = Instant::now();
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
        self.text_engine_performance
            .record(wait, hold_started.elapsed());

        self.frame_sequence = self.frame_sequence.saturating_add(1);
        let definitions = definitions.into_values().collect::<Vec<_>>();
        let cursor = FrameCursor {
            x: snapshot.cursor.x,
            y: snapshot.cursor.y,
            visible: snapshot.cursor.visible,
            style: snapshot.cursor.style,
            blinking: snapshot.cursor.blinking,
        };
        let scrollbar = TerminalScrollbar {
            total: snapshot.scrollbar.total,
            offset: snapshot.scrollbar.offset,
            len: snapshot.scrollbar.len,
        };
        encode_text_snapshot(TextSnapshot {
            session_handle: self.session_handle,
            session_epoch: snapshot.session_epoch,
            layout_epoch: snapshot.layout_epoch,
            sequence: self.frame_sequence,
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
        })
    }
}

fn shape_logical_row(
    engine: &mut ghosttea_text::TextEngine,
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
    use crate::{LogicalCell, LogicalCursor, LogicalScrollbar, RowReplacement};

    fn snapshot(text: &str) -> LogicalTerminalSnapshot {
        LogicalTerminalSnapshot {
            session_epoch: 7,
            layout_epoch: 3,
            terminal_revision: 11,
            cols: 20,
            rows: vec![LogicalRow {
                text: text.into(),
                cells: vec![LogicalCell {
                    column: 0,
                    span: text.len() as u16,
                    text: text.into(),
                    style: LogicalCellStyle::default(),
                }],
            }],
            cursor: LogicalCursor::default(),
            mouse_tracking: false,
            scrollbar: LogicalScrollbar::default(),
            title: Some("remote".into()),
            cwd: None,
        }
    }

    fn frame(update: TerminalUpdate) -> Vec<u8> {
        update
            .into_effects()
            .into_iter()
            .find_map(|effect| match effect {
                TerminalEffect::FrameReady(frame) => Some(frame),
                _ => None,
            })
            .expect("replica update must contain a frame")
    }

    #[test]
    fn logical_snapshot_is_shaped_into_a_full_frame() {
        let runtime = Arc::new(TerminalRuntime::discover().unwrap());
        let mut replica = LogicalReplicaModel::new(runtime, 42);
        let frame = frame(replica.publish(snapshot("hello")).unwrap());

        assert_eq!(u64::from_le_bytes(frame[16..24].try_into().unwrap()), 42);
        assert_eq!(u64::from_le_bytes(frame[24..32].try_into().unwrap()), 7);
        assert_eq!(u64::from_le_bytes(frame[32..40].try_into().unwrap()), 3);
        let performance = replica.text_engine_performance();
        assert_eq!(performance.sequence, 1);
        assert_eq!(performance.acquisition_count, 1);
        assert!(performance.hold_nanoseconds > 0);
    }

    #[test]
    fn logical_patch_updates_only_changed_rows() {
        let runtime = Arc::new(TerminalRuntime::discover().unwrap());
        let mut replica = LogicalReplicaModel::new(runtime, 42);
        replica.publish(snapshot("hello")).unwrap();
        let frame = frame(
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
                .unwrap(),
        );

        assert_eq!(u16::from_le_bytes(frame[6..8].try_into().unwrap()) & 1, 0);
        assert_eq!(u64::from_le_bytes(frame[48..56].try_into().unwrap()), 12);
        assert_eq!(u32::from_le_bytes(frame[108..112].try_into().unwrap()), 1);
    }

    #[test]
    fn rejects_patch_gaps_without_advancing_state() {
        let runtime = Arc::new(TerminalRuntime::discover().unwrap());
        let mut replica = LogicalReplicaModel::new(runtime, 42);
        replica.publish(snapshot("hello")).unwrap();
        let patch = LogicalTerminalPatch {
            session_epoch: 7,
            layout_epoch: 3,
            patch_sequence: 2,
            terminal_revision: 12,
            row_replacements: vec![],
            cursor: None,
            mouse_tracking: None,
            scrollbar: None,
        };

        assert!(replica.publish_patch(patch).is_err());
        assert_eq!(replica.latest().unwrap().terminal_revision, 11);
    }
}
