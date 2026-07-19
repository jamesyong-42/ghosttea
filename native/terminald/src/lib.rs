//! Reusable, transport-neutral Ghosttea terminal service.

pub mod mesh;
pub mod replica;
mod service;
pub mod session;
pub mod tunnel_protocol;

pub use ghosttea_core::ViewAccess;
pub use ghosttea_text::{
    FontMode, FontResource, FontResources, RASTER_SCALE, TextEngine, TextMetrics,
};
pub use mesh::{
    RemoteAttachment, RemoteControlChanged, RemoteControlClaim, RemoteHostSummary, RemoteResize,
    RemoteSelection, RemoteSessionOpen, RemoteTerminalRuntime, TerminalMesh,
};
pub use replica::RemoteReplica;
pub use service::Registry as SessionRegistry;
pub use service::{TerminalService, TerminalServiceConfig, TerminalServiceListeners};
pub use session::{
    AutomationInputOperation, AutomationInputResult, ExitOutcome, Session, SessionEnvironment,
    SessionExit, SessionSummary, TerminationSource,
};
