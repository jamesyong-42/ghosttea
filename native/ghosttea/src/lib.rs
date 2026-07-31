//! Reusable, transport-neutral Ghosttea terminal service.

mod frame_hub;
pub mod ipc;
pub mod mesh;
pub mod replica;
mod service;
pub mod session;
pub mod tunnel_protocol;

pub use frame_hub::{FrameHub, FramePacket};
pub use ghosttea_config::{
    CONFIG_DOCUMENT_SCHEMA_VERSION, ConfigCompatibility, ConfigDiagnostic, ConfigDocument,
    ConfigDocumentError, ConfigDocumentUpdate, ConfigDocumentValidation, ConfigLoadOptions,
    ConfigManager, ConfigSnapshot, ConfigSource, ConfigSourceKind, ConfigSupport, ConfiguredKey,
    DiagnosticSeverity, GHOSTTEA_BETTER_CRT_SHADER, GHOSTTY_COMPAT_COMMIT, GHOSTTY_COMPAT_VERSION,
    GHOSTTY_CONFIG_COMPAT_COMMIT, GHOSTTY_CONFIG_COMPAT_VERSION, KeybindingConfig,
    MAX_CONFIG_DOCUMENT_BYTES, RendererConfig, RendererPostProcess, TerminalConfig,
    TerminalPresentationConfig, WorkspaceConfig,
};
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
pub use service::{
    DrainReport, ReadyInfo, ServiceHandle, TerminalService, TerminalServiceConfig,
    TerminalServiceListeners,
};
pub use session::{
    AutomationInputOperation, AutomationInputResult, ExitOutcome, Session, SessionActivity,
    SessionActivityConfidence, SessionActivityKind, SessionActivitySource, SessionEnvironment,
    SessionExit, SessionProgramKind, SessionSummary, TerminationSource,
};
