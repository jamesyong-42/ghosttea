use std::sync::{Arc, Mutex};

use anyhow::{Result, bail};
use ghosttea_core::{
    LogicalReplicaModel, LogicalTerminalPatch, LogicalTerminalSnapshot,
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
}
