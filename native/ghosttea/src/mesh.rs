use std::{
    sync::{Arc, Mutex},
    time::Duration,
};

use anyhow::{Result, bail};
use async_trait::async_trait;
use ghosttea_text::TextEngine;
use serde::Serialize;
use tokio::sync::broadcast;

use crate::{
    FrameHub, TerminalPresentationConfig,
    service::Registry,
    session::{SessionActivity, SessionSummary},
    tunnel_protocol::{SharedSessionSummary, TunnelInput},
};

#[derive(Clone, Debug)]
pub struct RemoteControlClaim {
    pub controller_view_id: String,
    pub control_epoch: u64,
    pub cols: u16,
    pub rows: u16,
    pub layout_epoch: u64,
}

#[derive(Clone, Debug)]
pub struct RemoteControlChanged {
    pub session_id: String,
    pub controller_view_id: String,
    pub control_epoch: u64,
    pub cols: u16,
    pub rows: u16,
    pub layout_epoch: u64,
}

#[derive(Clone, Debug)]
pub struct RemoteActivityChanged {
    pub session_id: String,
    pub activity: SessionActivity,
}

pub struct RemoteResize {
    pub attachment_epoch: u64,
    pub control_epoch: u64,
    pub resize_sequence: u64,
    pub cols: u16,
    pub rows: u16,
}

pub struct RemoteSelection {
    pub attachment_epoch: u64,
    pub start_column: u16,
    pub start_row: u32,
    pub end_column: u16,
    pub end_row: u32,
    pub select_all: bool,
}

pub struct RemoteAttachment {
    pub attachment_epoch: u64,
    pub read_write: bool,
}

/// Lifecycle of one open remote session, owned by the mesh runtime.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum RemoteLifecycleState {
    Opening,
    Live,
    Synchronizing,
    Reconnecting,
    Suspended,
    Ended,
}

impl RemoteLifecycleState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Opening => "opening",
            Self::Live => "live",
            Self::Synchronizing => "synchronizing",
            Self::Reconnecting => "reconnecting",
            Self::Suspended => "suspended",
            Self::Ended => "ended",
        }
    }
}

/// Terminal lifecycle reasons. Each is claimed only on the evidence defined by
/// the reconnect design, so a viewer never reports a cause it did not observe.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum RemoteEndedReason {
    SessionClosed,
    SessionExited,
    SessionUnavailable,
    HostRestarted,
    HostShutdown,
    ClosedLocally,
}

impl RemoteEndedReason {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::SessionClosed => "session-closed",
            Self::SessionExited => "session-exited",
            Self::SessionUnavailable => "session-unavailable",
            Self::HostRestarted => "host-restarted",
            Self::HostShutdown => "host-shutdown",
            Self::ClosedLocally => "closed-locally",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteExitInfo {
    pub code: Option<i32>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum RemoteViewState {
    Pending,
    Attached,
    Failed,
}

impl RemoteViewState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Attached => "attached",
            Self::Failed => "failed",
        }
    }
}

#[derive(Clone, Debug)]
pub struct RemoteLifecycleChanged {
    pub session_id: String,
    pub lifecycle_seq: u64,
    pub device_id: String,
    pub device_name: String,
    pub state: RemoteLifecycleState,
    pub reason: Option<RemoteEndedReason>,
    pub exit: Option<RemoteExitInfo>,
    pub attempt: u32,
    pub next_retry_ms: Option<u64>,
    pub last_contact_ms: Option<u64>,
}

/// Per-view attachment readiness. `attachment_epoch` and `read_write` are
/// populated only while `view_state` is `Attached`; inventing either for a
/// pending or failed view would recreate the stale-epoch bug this replaces.
#[derive(Clone, Debug)]
pub struct RemoteViewStateChanged {
    pub session_id: String,
    pub local_view_id: String,
    pub view_state_seq: u64,
    pub view_state: RemoteViewState,
    pub attachment_epoch: Option<u64>,
    pub read_write: Option<bool>,
    pub error: Option<String>,
    pub retryable: Option<bool>,
}

#[derive(Clone, Debug)]
pub struct RemoteViewRecord {
    pub local_view_id: String,
    pub view_state_seq: u64,
    pub view_state: RemoteViewState,
    pub attachment_epoch: Option<u64>,
    pub read_write: Option<bool>,
    pub error: Option<String>,
    pub retryable: Option<bool>,
}

/// Recovery tunables. These belong to the mesh rather than the local IPC
/// config: they describe how this viewer treats a host that has gone quiet,
/// not how clients reach this daemon.
#[derive(Clone, Copy, Debug)]
pub struct MeshReconnectConfig {
    /// Full jitter, AWS definition:
    /// `delay(n) = max(floor, uniform(0, min(cap, base · 2ⁿ)))`, `n` 0-based.
    pub backoff_base: Duration,
    pub backoff_cap: Duration,
    pub backoff_floor: Duration,
    /// How long a host may stay absent before the engine stops burning dials
    /// and the session comes to rest in Suspended, still watching.
    pub suspend_after: Duration,
    /// How long a synchronizing session waits for its feed's first snapshot
    /// before abandoning the attempt.
    pub synchronize_timeout: Duration,
    /// Whether a fresh advertisement short-circuits the backoff timer.
    pub advertisement_fast_path: bool,
    /// Whether a resumed session purges the attachments it stranded. Purely an
    /// acceleration: the host reaps them itself once it notices the abandoned
    /// connection died.
    pub zombie_purge: bool,
}

impl Default for MeshReconnectConfig {
    fn default() -> Self {
        Self {
            backoff_base: Duration::from_millis(500),
            backoff_cap: Duration::from_secs(10),
            backoff_floor: Duration::from_millis(250),
            suspend_after: Duration::from_secs(10 * 60),
            synchronize_timeout: Duration::from_secs(10),
            advertisement_fast_path: true,
            zombie_purge: true,
        }
    }
}

/// The authoritative reconciliation snapshot for one remote session.
#[derive(Clone, Debug)]
pub struct RemoteSessionLifecycle {
    pub session_id: String,
    pub lifecycle_seq: u64,
    pub device_id: String,
    pub device_name: String,
    pub state: RemoteLifecycleState,
    pub reason: Option<RemoteEndedReason>,
    pub exit: Option<RemoteExitInfo>,
    pub attempt: u32,
    pub next_retry_ms: Option<u64>,
    pub last_contact_ms: Option<u64>,
    pub views: Vec<RemoteViewRecord>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteHostSummary {
    pub device_id: String,
    pub device_name: String,
    pub online: bool,
    pub protocol_major: u16,
    pub protocol_minor: u16,
    pub host_instance_id: String,
    pub sessions: Vec<SharedSessionSummary>,
}

pub struct RemoteSessionOpen {
    pub device_id: String,
    pub remote_session_id: String,
    pub cols: u16,
    pub rows: u16,
    pub owner_id: Option<String>,
    pub frames: FrameHub,
    pub text_engine: Arc<Mutex<TextEngine>>,
}

#[async_trait]
pub trait RemoteTerminalRuntime: Send + Sync {
    fn subscribe_control(&self) -> broadcast::Receiver<RemoteControlChanged>;
    fn subscribe_activity(&self) -> broadcast::Receiver<RemoteActivityChanged>;
    async fn hosts(&self) -> Result<Vec<RemoteHostSummary>>;
    async fn list_sessions(&self, device_id: &str) -> Result<Vec<SharedSessionSummary>>;
    async fn open_session(&self, request: RemoteSessionOpen) -> Result<SessionSummary>;
    async fn summaries(&self) -> Vec<SessionSummary>;
    async fn summary(&self, session_id: &str) -> Option<SessionSummary>;
    async fn attach_view(&self, session_id: &str, view_id: &str) -> Result<RemoteAttachment>;
    async fn send_input(
        &self,
        session_id: &str,
        view_id: &str,
        attachment_epoch: u64,
        input_sequence: u64,
        operation: TunnelInput,
    ) -> Result<()>;
    async fn claim_control(
        &self,
        session_id: &str,
        view_id: &str,
        attachment_epoch: u64,
        cols: u16,
        rows: u16,
    ) -> Result<RemoteControlClaim>;
    async fn resize(&self, session_id: &str, view_id: &str, request: RemoteResize) -> Result<()>;
    async fn selection_text(
        &self,
        session_id: &str,
        view_id: &str,
        request: RemoteSelection,
    ) -> Result<String>;
    async fn refresh(&self, session_id: &str) -> Result<()>;
    async fn detach_view(&self, session_id: &str, view_id: &str, attachment_epoch: u64);
    async fn close_session(&self, session_id: &str) -> bool;

    fn subscribe_lifecycle(&self) -> broadcast::Receiver<RemoteLifecycleChanged> {
        closed_channel()
    }

    fn subscribe_view_state(&self) -> broadcast::Receiver<RemoteViewStateChanged> {
        closed_channel()
    }

    /// The full reconciliation snapshot for a session, including every view's
    /// current state. Clients rebuild from this rather than from the lossy
    /// event broadcast.
    async fn session_lifecycle(&self, _session_id: &str) -> Option<RemoteSessionLifecycle> {
        None
    }

    /// The authoritative attachment lookup. Callers must consult this at use
    /// time instead of caching an epoch, so a dead view re-dials rather than
    /// answering with a stale epoch.
    async fn current_attachment(&self, _session_id: &str, _view_id: &str) -> Option<(u64, bool)> {
        None
    }

    /// One-shot resume: invalidate the cached connection, dial exactly once,
    /// and re-attach this session's views under an advanced generation.
    async fn reconnect_session(&self, _session_id: &str) -> Result<RemoteSessionLifecycle> {
        unavailable()
    }

    /// A true remote refresh of a live session: a generation-advanced
    /// re-attach of its feed. Errors when the session is not live — there is
    /// no host to ask, and a local re-render is `refresh`'s job.
    async fn refresh_remote(&self, _session_id: &str) -> Result<()> {
        unavailable()
    }

    /// Liveness round-trip on a device's cached connection, bypassing
    /// advertisement validation. Used as a probe, never as a teardown trigger.
    async fn probe_connection(&self, _device_id: &str) -> Result<()> {
        unavailable()
    }

    /// Selection text extracted from the retained replica viewport, for use
    /// while the session is not live. `request.attachment_epoch` is ignored:
    /// there is no live attachment to fence against.
    async fn offline_selection_text(
        &self,
        _session_id: &str,
        _request: RemoteSelection,
    ) -> Result<String> {
        unavailable()
    }
}

fn closed_channel<T: Clone>() -> broadcast::Receiver<T> {
    let (sender, receiver) = broadcast::channel(1);
    drop(sender);
    receiver
}

#[async_trait]
pub trait TerminalMesh: Send {
    fn runtime(&self) -> Arc<dyn RemoteTerminalRuntime>;
    async fn serve(
        self: Box<Self>,
        registry: Registry,
        host_config: tokio::sync::watch::Receiver<Arc<TerminalPresentationConfig>>,
    ) -> Result<()>;
}

#[derive(Default)]
pub(crate) struct NoRemoteRuntime;

fn unavailable<T>() -> Result<T> {
    bail!("remote terminal transport is not configured")
}

#[async_trait]
impl RemoteTerminalRuntime for NoRemoteRuntime {
    fn subscribe_control(&self) -> broadcast::Receiver<RemoteControlChanged> {
        let (sender, receiver) = broadcast::channel(1);
        drop(sender);
        receiver
    }

    fn subscribe_activity(&self) -> broadcast::Receiver<RemoteActivityChanged> {
        let (sender, receiver) = broadcast::channel(1);
        drop(sender);
        receiver
    }

    async fn hosts(&self) -> Result<Vec<RemoteHostSummary>> {
        Ok(Vec::new())
    }

    async fn list_sessions(&self, _device_id: &str) -> Result<Vec<SharedSessionSummary>> {
        unavailable()
    }

    async fn open_session(&self, _request: RemoteSessionOpen) -> Result<SessionSummary> {
        unavailable()
    }

    async fn summaries(&self) -> Vec<SessionSummary> {
        Vec::new()
    }

    async fn summary(&self, _session_id: &str) -> Option<SessionSummary> {
        None
    }

    async fn attach_view(&self, _session_id: &str, _view_id: &str) -> Result<RemoteAttachment> {
        unavailable()
    }

    async fn send_input(
        &self,
        _session_id: &str,
        _view_id: &str,
        _attachment_epoch: u64,
        _input_sequence: u64,
        _operation: TunnelInput,
    ) -> Result<()> {
        unavailable()
    }

    async fn claim_control(
        &self,
        _session_id: &str,
        _view_id: &str,
        _attachment_epoch: u64,
        _cols: u16,
        _rows: u16,
    ) -> Result<RemoteControlClaim> {
        unavailable()
    }

    async fn resize(
        &self,
        _session_id: &str,
        _view_id: &str,
        _request: RemoteResize,
    ) -> Result<()> {
        unavailable()
    }

    async fn selection_text(
        &self,
        _session_id: &str,
        _view_id: &str,
        _request: RemoteSelection,
    ) -> Result<String> {
        unavailable()
    }

    async fn refresh(&self, _session_id: &str) -> Result<()> {
        unavailable()
    }

    async fn detach_view(&self, _session_id: &str, _view_id: &str, _attachment_epoch: u64) {}

    async fn close_session(&self, _session_id: &str) -> bool {
        false
    }
}
