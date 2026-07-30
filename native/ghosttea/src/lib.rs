//! Reusable, transport-neutral Ghosttea terminal service.

mod frame_hub;
pub mod ipc;
pub mod mesh;
pub mod replica;
mod service;
pub mod session;
pub mod tunnel_protocol;

pub use frame_hub::{FrameHub, FramePacket};
pub use ghosttea_core::ViewAccess;
pub use ghosttea_text::{
    FontMode, FontResource, FontResources, RASTER_SCALE, TextEngine, TextMetrics,
};
pub use mesh::{
    RemoteActivityChanged, RemoteAttachment, RemoteControlChanged, RemoteControlClaim,
    RemoteHostSummary, RemoteResize, RemoteSelection, RemoteSessionOpen, RemoteTerminalRuntime,
    TerminalMesh,
};
pub use replica::RemoteReplica;
pub use service::Registry as SessionRegistry;
pub use service::{ReadyInfo, TerminalService, TerminalServiceConfig, TerminalServiceListeners};
pub use session::{
    AutomationInputOperation, AutomationInputResult, ExitOutcome, Session, SessionActivity,
    SessionActivityConfidence, SessionActivityKind, SessionActivitySource, SessionEnvironment,
    SessionExit, SessionProgramKind, SessionSummary, TerminationSource,
};
