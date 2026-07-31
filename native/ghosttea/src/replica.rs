use std::sync::{Arc, Mutex};

use anyhow::{Context, Result, bail};
use ghosttea_core::{
    LogicalReplicaModel, LogicalRow, LogicalTerminalPatch, LogicalTerminalSnapshot,
    ReplicaRenderPerformanceSnapshot, TerminalEffect, TerminalRuntime, TerminalUpdate,
    TextEnginePerformanceSnapshot,
};
use ghosttea_text::TextEngine;
use uuid::Uuid;

use crate::{
    FrameHub,
    session::{SessionActivity, SessionSummary},
};

/// Desktop host wrapper for the platform-neutral logical replica model.
pub struct RemoteReplica {
    summary: Mutex<SessionSummary>,
    model: Mutex<LogicalReplicaModel>,
    frames: FrameHub,
}

impl RemoteReplica {
    pub fn new(
        title: String,
        cwd: Option<String>,
        cols: u16,
        rows: u16,
        owner_id: Option<String>,
        frames: FrameHub,
        text_engine: Arc<Mutex<TextEngine>>,
    ) -> Arc<Self> {
        let id = Uuid::new_v4();
        let bytes = *id.as_bytes();
        let handle = u64::from_le_bytes(bytes[..8].try_into().unwrap());
        let runtime = Arc::new(TerminalRuntime::from_shared_text_engine(text_engine));
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
                owner_id,
                // The owning host governs this session's retention; claiming a
                // class here would assert a governance this host does not hold.
                persistence: None,
                activity: SessionActivity::default(),
            }),
            model: Mutex::new(LogicalReplicaModel::new(runtime, handle)),
            frames,
        })
    }

    pub fn summary(&self) -> SessionSummary {
        self.summary.lock().unwrap().clone()
    }

    pub fn set_read_write(&self, read_write: bool) {
        self.summary.lock().unwrap().read_write = read_write;
    }

    pub fn set_activity(&self, activity: SessionActivity) {
        self.summary.lock().unwrap().activity = activity;
    }

    pub fn publish(&self, snapshot: LogicalTerminalSnapshot) -> Result<()> {
        let mut model = self.model.lock().unwrap();
        let update = model.publish(snapshot)?;
        self.update_summary(model.latest());
        self.execute_update(update)
    }

    pub fn publish_patch(&self, patch: LogicalTerminalPatch) -> Result<()> {
        let mut model = self.model.lock().unwrap();
        let update = model.publish_patch(patch)?;
        self.update_summary(model.latest());
        self.execute_update(update)
    }

    pub fn refresh(&self) -> Result<()> {
        let mut model = self.model.lock().unwrap();
        let update = model.refresh()?;
        self.update_summary(model.latest());
        self.execute_update(update)
    }

    /// The last applied viewport, retained so a frozen session stays readable
    /// and copyable after its host is gone.
    pub fn retained_snapshot(&self) -> Option<LogicalTerminalSnapshot> {
        self.model.lock().unwrap().latest().cloned()
    }

    /// Extract selection text from the retained viewport without reaching the
    /// host. Rows are addressed in the same screen-absolute space the host RPC
    /// uses, so a request that predates the outage resolves identically as long
    /// as it lands inside the retained viewport; scrollback is not replicated
    /// and is therefore out of range.
    pub fn viewport_selection_text(
        &self,
        start_column: u16,
        start_row: u32,
        end_column: u16,
        end_row: u32,
        select_all: bool,
    ) -> Result<String> {
        let model = self.model.lock().unwrap();
        let snapshot = model
            .latest()
            .context("remote replica has no retained viewport")?;
        let rows = &snapshot.rows;
        if rows.is_empty() {
            return Ok(String::new());
        }
        if select_all {
            return Ok(join_rows(
                rows.iter().map(|row| row_columns(row, 0, u16::MAX)),
            ));
        }

        let viewport_start = snapshot.scrollbar.offset;
        let (start, end) = if (start_row, start_column) <= (end_row, end_column) {
            ((start_row, start_column), (end_row, end_column))
        } else {
            ((end_row, end_column), (start_row, start_column))
        };
        let first = usize::try_from(u64::from(start.0).checked_sub(viewport_start).context(
            "selection starts above the retained viewport; offline copy covers the visible screen",
        )?)?;
        let last = usize::try_from(u64::from(end.0).checked_sub(viewport_start).context(
            "selection starts above the retained viewport; offline copy covers the visible screen",
        )?)?;
        if first >= rows.len() {
            bail!("selection is outside the retained viewport");
        }
        let last = last.min(rows.len() - 1);

        Ok(join_rows(rows[first..=last].iter().enumerate().map(
            |(offset, row)| {
                let index = first + offset;
                let from = if index == first { start.1 } else { 0 };
                let to = if index == last { end.1 } else { u16::MAX };
                row_columns(row, from, to)
            },
        )))
    }

    pub fn text_engine_performance(&self) -> TextEnginePerformanceSnapshot {
        self.model.lock().unwrap().text_engine_performance()
    }

    pub fn render_performance(&self) -> ReplicaRenderPerformanceSnapshot {
        self.model.lock().unwrap().render_performance()
    }

    fn update_summary(&self, snapshot: Option<&LogicalTerminalSnapshot>) {
        let Some(snapshot) = snapshot else {
            return;
        };
        let mut summary = self.summary.lock().unwrap();
        summary.cols = snapshot.cols;
        summary.rows = snapshot.rows.len() as u16;
        if let Some(title) = &snapshot.title {
            if let Some(current) = &mut summary.title {
                current.clone_from(title);
            } else {
                summary.title = Some(title.clone());
            }
        }
        summary.cwd.clone_from(&snapshot.cwd);
    }

    fn execute_update(&self, update: TerminalUpdate) -> Result<()> {
        for effect in update {
            match effect {
                TerminalEffect::FrameReady(frame) => {
                    self.frames.publish(frame);
                }
                _ => bail!("logical replica produced an unsupported host effect"),
            }
        }
        Ok(())
    }
}

fn join_rows(rows: impl Iterator<Item = String>) -> String {
    rows.map(|row| row.trim_end().to_owned())
        .collect::<Vec<_>>()
        .join("\n")
}

/// Column-accurate slice of one logical row, end inclusive to match the host
/// selection RPC. Cell spans carry the authoritative column geometry; rows
/// published without them fall back to character offsets.
fn row_columns(row: &LogicalRow, from: u16, to: u16) -> String {
    if row.cells.is_empty() {
        return row
            .text
            .chars()
            .skip(usize::from(from))
            .take(usize::from(to.saturating_sub(from)).saturating_add(1))
            .collect();
    }
    row.cells
        .iter()
        .filter(|cell| {
            let last = cell
                .column
                .saturating_add(cell.span.max(1))
                .saturating_sub(1);
            cell.column <= to && last >= from
        })
        .map(|cell| cell.text.as_str())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use ghosttea_core::{LogicalCursor, LogicalRow, LogicalScrollbar};

    #[test]
    fn desktop_wrapper_publishes_core_frame_and_updates_summary() {
        let frames = FrameHub::new(2);
        let (mut receiver, _) = frames.subscribe();
        let engine = Arc::new(Mutex::new(TextEngine::discover().unwrap()));
        let replica = RemoteReplica::new("remote".into(), None, 20, 1, None, frames, engine);
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
                title: Some("remote title".into()),
                cwd: Some("/remote".into()),
            })
            .unwrap();

        let frame = receiver.try_recv().unwrap();
        assert_eq!(u64::from_le_bytes(frame[24..32].try_into().unwrap()), 7);
        assert_eq!(replica.summary().title.as_deref(), Some("remote title"));
        assert_eq!(replica.summary().cwd.as_deref(), Some("/remote"));
    }

    fn frozen_replica(offset: u64) -> Arc<RemoteReplica> {
        let engine = Arc::new(Mutex::new(TextEngine::discover().unwrap()));
        let replica =
            RemoteReplica::new("remote".into(), None, 12, 3, None, FrameHub::new(2), engine);
        let row = |text: &str| LogicalRow {
            text: text.into(),
            cells: text
                .chars()
                .enumerate()
                .map(|(column, character)| ghosttea_core::LogicalCell {
                    column: column as u16,
                    span: 1,
                    text: character.to_string(),
                    style: ghosttea_core::LogicalCellStyle::default(),
                })
                .collect(),
        };
        replica
            .publish(LogicalTerminalSnapshot {
                session_epoch: 1,
                layout_epoch: 1,
                terminal_revision: 4,
                cols: 12,
                rows: vec![row("first"), row("second"), row("third")],
                cursor: LogicalCursor::default(),
                mouse_tracking: false,
                scrollbar: LogicalScrollbar {
                    total: offset + 3,
                    offset,
                    len: 3,
                },
                title: None,
                cwd: None,
            })
            .unwrap();
        replica
    }

    #[test]
    fn frozen_viewport_answers_selections_without_the_host() {
        let replica = frozen_replica(0);
        // End column is inclusive, matching the host selection RPC.
        assert_eq!(
            replica.viewport_selection_text(0, 1, 5, 1, false).unwrap(),
            "second"
        );
        assert_eq!(
            replica.viewport_selection_text(2, 1, 3, 1, false).unwrap(),
            "co"
        );
        assert_eq!(
            replica.viewport_selection_text(0, 0, 0, 0, true).unwrap(),
            "first\nsecond\nthird"
        );
        // A reversed drag selects the same span.
        assert_eq!(
            replica.viewport_selection_text(3, 1, 2, 1, false).unwrap(),
            "co"
        );
        assert_eq!(
            replica.viewport_selection_text(3, 0, 4, 1, false).unwrap(),
            "st\nsecon"
        );
    }

    #[test]
    fn frozen_selections_are_addressed_in_screen_absolute_rows() {
        // Rows are addressed as the host addresses them, so a request made
        // before the outage resolves identically inside the retained viewport.
        let replica = frozen_replica(40);
        assert_eq!(
            replica
                .viewport_selection_text(0, 41, 5, 41, false)
                .unwrap(),
            "second"
        );
        // Scrollback is not replicated, so anything above the viewport is
        // honestly out of range rather than silently wrong.
        assert!(replica.viewport_selection_text(0, 3, 5, 3, false).is_err());
        assert!(
            replica
                .viewport_selection_text(0, 99, 5, 99, false)
                .is_err()
        );
    }
}
