use std::{
    collections::{BTreeMap, HashSet},
    sync::Arc,
    time::{Duration, Instant},
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
    shape_spans: Vec<Vec<(usize, usize, FontStyle)>>,
    shaped_rows: Vec<ShapedRow>,
    sent_glyphs: HashSet<u32>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct ReplicaRenderPerformanceSnapshot {
    pub sequence: u64,
    pub row_prepare_nanoseconds: u64,
    pub frame_encode_nanoseconds: u64,
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
    render_performance: ReplicaRenderPerformanceSnapshot,
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
            render_performance: ReplicaRenderPerformanceSnapshot::default(),
        }
    }

    pub fn latest(&self) -> Option<&LogicalTerminalSnapshot> {
        self.latest.as_ref()
    }

    pub fn text_engine_performance(&self) -> TextEnginePerformanceSnapshot {
        self.text_engine_performance
    }

    pub fn render_performance(&self) -> ReplicaRenderPerformanceSnapshot {
        self.render_performance
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

    pub fn publish_patch(&mut self, mut patch: LogicalTerminalPatch) -> Result<TerminalUpdate> {
        let expected_sequence = self.patch_sequence.saturating_add(1);
        ensure!(
            patch.patch_sequence == expected_sequence,
            "remote terminal patch sequence gap"
        );
        let current = self
            .latest
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("remote terminal patch arrived before a snapshot"))?;
        ensure!(
            patch.session_epoch == current.session_epoch,
            "remote terminal session epoch changed"
        );
        ensure!(
            patch.layout_epoch == current.layout_epoch,
            "remote terminal layout epoch changed"
        );
        ensure!(
            patch.terminal_revision > current.terminal_revision,
            "stale remote terminal patch"
        );
        for replacement in &patch.row_replacements {
            ensure!(
                replacement.row_revision == patch.terminal_revision,
                "remote terminal row revision does not match its patch"
            );
            ensure!(
                current.rows.get(replacement.row_index as usize).is_some(),
                "remote terminal patch row is outside the snapshot"
            );
        }

        let mut snapshot = self.latest.take().unwrap();
        let previous_revision = snapshot.terminal_revision;
        let previous_cursor = snapshot.cursor;
        let previous_mouse_tracking = snapshot.mouse_tracking;
        let previous_scrollbar = snapshot.scrollbar;
        let updated_rows = patch
            .row_replacements
            .iter()
            .map(|replacement| replacement.row_index)
            .collect::<Vec<_>>();
        for replacement in &mut patch.row_replacements {
            std::mem::swap(
                &mut snapshot.rows[replacement.row_index as usize],
                &mut replacement.row,
            );
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

        match self.render(&snapshot, &updated_rows, false) {
            Ok(frame) => {
                self.latest = Some(snapshot);
                self.patch_sequence = patch.patch_sequence;
                Ok([TerminalEffect::FrameReady(frame)].into_iter().collect())
            }
            Err(error) => {
                for replacement in patch.row_replacements.iter_mut().rev() {
                    std::mem::swap(
                        &mut snapshot.rows[replacement.row_index as usize],
                        &mut replacement.row,
                    );
                }
                snapshot.terminal_revision = previous_revision;
                snapshot.cursor = previous_cursor;
                snapshot.mouse_tracking = previous_mouse_tracking;
                snapshot.scrollbar = previous_scrollbar;
                self.latest = Some(snapshot);
                Err(error)
            }
        }
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
            cache.shape_spans = vec![Vec::new(); snapshot.rows.len()];
            cache.shaped_rows = vec![ShapedRow::default(); snapshot.rows.len()];
            cache.sent_glyphs.clear();
        } else {
            ensure!(
                cache.rows.len() == snapshot.rows.len(),
                "remote terminal patch changed row count"
            );
        }

        let prepare_started = Instant::now();
        let mut prepared = Vec::with_capacity(updated_rows.len());
        for row_index in updated_rows.iter().copied() {
            let logical = snapshot
                .rows
                .get(row_index as usize)
                .context("remote terminal updated row is outside the snapshot")?;
            let index = row_index as usize;
            let needs_shape = cache.rows[index] != logical.text
                || !shape_spans_match(logical, &cache.shape_spans[index]);
            prepared.push(prepare_logical_row(index, logical, needs_shape));
        }
        let mut prepare_duration = prepare_started.elapsed();

        let mut shaped_updates = Vec::new();
        if prepared.iter().any(|row| row.shape_spans.is_some()) {
            let wait_started = Instant::now();
            let mut engine = self.runtime.text_engine().lock().unwrap();
            let wait = wait_started.elapsed();
            let hold_started = Instant::now();
            for row in prepared.iter().filter(|row| row.shape_spans.is_some()) {
                let spans = row
                    .shape_spans
                    .as_ref()
                    .unwrap()
                    .iter()
                    .map(|&(byte_start, byte_end, style)| StyleSpan {
                        byte_start,
                        byte_end,
                        style,
                    })
                    .collect::<Vec<_>>();
                shaped_updates.push((row.index, engine.shape_styled_row(&row.text, &spans)?));
            }
            drop(engine);
            self.text_engine_performance
                .record(wait, hold_started.elapsed());
        } else {
            self.text_engine_performance.record_no_acquisition();
        }

        let cache_started = Instant::now();
        for row in prepared {
            cache.rows[row.index] = row.text;
            cache.cells[row.index] = row.cells;
            if let Some(shape_spans) = row.shape_spans {
                cache.shape_spans[row.index] = shape_spans;
            }
        }
        for (index, shaped) in shaped_updates {
            cache.shaped_rows[index] = shaped;
        }

        let mut definitions = BTreeMap::<u32, GlyphDefinition>::new();
        for row_index in updated_rows.iter().copied() {
            for definition in &cache.shaped_rows[row_index as usize].definitions {
                if cache.sent_glyphs.insert(definition.id) {
                    definitions
                        .entry(definition.id)
                        .or_insert_with(|| definition.clone());
                }
            }
        }
        prepare_duration += cache_started.elapsed();

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
        let encode_started = Instant::now();
        let frame = encode_text_snapshot(TextSnapshot {
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
        });
        self.render_performance.sequence = self.render_performance.sequence.saturating_add(1);
        self.render_performance.row_prepare_nanoseconds = duration_nanoseconds(prepare_duration);
        self.render_performance.frame_encode_nanoseconds =
            duration_nanoseconds(encode_started.elapsed());
        frame
    }
}

fn duration_nanoseconds(duration: Duration) -> u64 {
    u64::try_from(duration.as_nanos()).unwrap_or(u64::MAX)
}

struct PreparedReplicaRow {
    index: usize,
    text: String,
    cells: Vec<TerminalCell>,
    shape_spans: Option<Vec<(usize, usize, FontStyle)>>,
}

fn prepare_logical_row(index: usize, row: &LogicalRow, needs_shape: bool) -> PreparedReplicaRow {
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
    let shape_spans = needs_shape.then(|| logical_shape_spans(row));
    PreparedReplicaRow {
        index,
        text,
        cells,
        shape_spans,
    }
}

fn logical_shape_spans(row: &LogicalRow) -> Vec<(usize, usize, FontStyle)> {
    let mut byte_offset = 0;
    row.cells
        .iter()
        .filter_map(|cell| {
            if byte_offset >= row.text.len() {
                return None;
            }
            let byte_start = byte_offset;
            byte_offset = (byte_offset + cell.text.len()).min(row.text.len());
            Some((
                byte_start,
                byte_offset,
                FontStyle {
                    bold: cell.style.bold,
                    italic: cell.style.italic,
                },
            ))
        })
        .collect()
}

fn shape_spans_match(row: &LogicalRow, cached: &[(usize, usize, FontStyle)]) -> bool {
    let mut byte_offset = 0;
    let mut span_index = 0;
    for cell in &row.cells {
        if byte_offset >= row.text.len() {
            break;
        }
        let byte_start = byte_offset;
        byte_offset = (byte_offset + cell.text.len()).min(row.text.len());
        let span = (
            byte_start,
            byte_offset,
            FontStyle {
                bold: cell.style.bold,
                italic: cell.style.italic,
            },
        );
        if cached.get(span_index) != Some(&span) {
            return false;
        }
        span_index += 1;
    }
    span_index == cached.len()
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
    fn color_only_patch_reuses_the_existing_row_shape() {
        let runtime = Arc::new(TerminalRuntime::discover().unwrap());
        let mut replica = LogicalReplicaModel::new(runtime, 42);
        let initial = snapshot("hello");
        replica.publish(initial.clone()).unwrap();
        let mut replacement = initial.rows[0].clone();
        replacement.cells[0].style.foreground = Some([1, 2, 3]);

        replica
            .publish_patch(LogicalTerminalPatch {
                session_epoch: 7,
                layout_epoch: 3,
                patch_sequence: 1,
                terminal_revision: 12,
                row_replacements: vec![RowReplacement {
                    row_index: 0,
                    row_revision: 12,
                    row: replacement,
                }],
                cursor: None,
                mouse_tracking: None,
                scrollbar: None,
            })
            .unwrap();

        let performance = replica.text_engine_performance();
        assert_eq!(performance.acquisition_count, 0);
        assert_eq!(performance.wait_nanoseconds, 0);
        assert_eq!(performance.hold_nanoseconds, 0);
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

    #[test]
    fn validates_every_replacement_before_mutating_state() {
        let runtime = Arc::new(TerminalRuntime::discover().unwrap());
        let mut replica = LogicalReplicaModel::new(runtime, 42);
        replica.publish(snapshot("hello")).unwrap();
        let replacement = |row_index| RowReplacement {
            row_index,
            row_revision: 12,
            row: LogicalRow {
                text: "world".into(),
                cells: vec![],
            },
        };
        let patch = |row_replacements| LogicalTerminalPatch {
            session_epoch: 7,
            layout_epoch: 3,
            patch_sequence: 1,
            terminal_revision: 12,
            row_replacements,
            cursor: None,
            mouse_tracking: None,
            scrollbar: None,
        };

        assert!(
            replica
                .publish_patch(patch(vec![replacement(0), replacement(1)]))
                .is_err()
        );
        assert_eq!(replica.latest().unwrap().terminal_revision, 11);
        assert_eq!(replica.latest().unwrap().rows[0].text, "hello");

        replica.publish_patch(patch(vec![replacement(0)])).unwrap();
        assert_eq!(replica.latest().unwrap().terminal_revision, 12);
        assert_eq!(replica.latest().unwrap().rows[0].text, "world");
    }
}
