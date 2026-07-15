//! Reusable, transport-neutral Ghosttea terminal service.

pub mod authority;
mod frame;
pub mod mesh;
pub mod replica;
mod service;
pub mod session;
pub mod tunnel_protocol;

pub use authority::ViewAccess;
pub use mesh::{
    RemoteControlClaim, RemoteHostSummary, RemoteResize, RemoteTerminalRuntime, TerminalMesh,
};
pub use replica::RemoteReplica;
pub use service::Registry as SessionRegistry;
pub use service::{TerminalService, TerminalServiceConfig};
pub use session::{Session, SessionSummary};
