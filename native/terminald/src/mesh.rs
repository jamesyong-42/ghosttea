use std::sync::{Arc, Mutex};

use anyhow::{Result, bail};
use async_trait::async_trait;
use ghosttea_text::TextEngine;
use serde::Serialize;
use tokio::sync::broadcast;

use crate::{
    service::Registry,
    session::SessionSummary,
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

pub struct RemoteResize {
    pub attachment_epoch: u64,
    pub control_epoch: u64,
    pub resize_sequence: u64,
    pub cols: u16,
    pub rows: u16,
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

#[async_trait]
pub trait RemoteTerminalRuntime: Send + Sync {
    async fn hosts(&self) -> Result<Vec<RemoteHostSummary>>;
    async fn list_sessions(&self, device_id: &str) -> Result<Vec<SharedSessionSummary>>;
    async fn open_session(
        &self,
        device_id: &str,
        remote_session_id: &str,
        cols: u16,
        rows: u16,
        frames: broadcast::Sender<Vec<u8>>,
        text_engine: Arc<Mutex<TextEngine>>,
    ) -> Result<SessionSummary>;
    async fn summaries(&self) -> Vec<SessionSummary>;
    async fn summary(&self, session_id: &str) -> Option<SessionSummary>;
    async fn attach_view(&self, session_id: &str, view_id: &str) -> Result<u64>;
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
    async fn refresh(&self, session_id: &str) -> Result<()>;
    async fn detach_view(&self, session_id: &str, view_id: &str, attachment_epoch: u64);
    async fn close_session(&self, session_id: &str) -> bool;
}

#[async_trait]
pub trait TerminalMesh: Send {
    fn runtime(&self) -> Arc<dyn RemoteTerminalRuntime>;
    async fn serve(self: Box<Self>, registry: Registry) -> Result<()>;
}

#[derive(Default)]
pub(crate) struct NoRemoteRuntime;

fn unavailable<T>() -> Result<T> {
    bail!("remote terminal transport is not configured")
}

#[async_trait]
impl RemoteTerminalRuntime for NoRemoteRuntime {
    async fn hosts(&self) -> Result<Vec<RemoteHostSummary>> {
        Ok(Vec::new())
    }

    async fn list_sessions(&self, _device_id: &str) -> Result<Vec<SharedSessionSummary>> {
        unavailable()
    }

    async fn open_session(
        &self,
        _device_id: &str,
        _remote_session_id: &str,
        _cols: u16,
        _rows: u16,
        _frames: broadcast::Sender<Vec<u8>>,
        _text_engine: Arc<Mutex<TextEngine>>,
    ) -> Result<SessionSummary> {
        unavailable()
    }

    async fn summaries(&self) -> Vec<SessionSummary> {
        Vec::new()
    }

    async fn summary(&self, _session_id: &str) -> Option<SessionSummary> {
        None
    }

    async fn attach_view(&self, _session_id: &str, _view_id: &str) -> Result<u64> {
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

    async fn refresh(&self, _session_id: &str) -> Result<()> {
        unavailable()
    }

    async fn detach_view(&self, _session_id: &str, _view_id: &str, _attachment_epoch: u64) {}

    async fn close_session(&self, _session_id: &str) -> bool {
        false
    }
}
