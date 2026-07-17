//! Platform-neutral Ghosttea terminal model contracts.

mod authority;
mod effects;
pub mod frame;
mod input_order;
mod logical;
mod model;
mod replica;

pub use authority::{ControlChanged, ControllerState, PreparedResize, ViewAccess, ViewAuthority};
pub use effects::{ClipboardRequest, TerminalEffect, TerminalMetadata, TerminalUpdate};
pub use frame::{FrameCursor, TextSnapshot, encode_text_snapshot};
pub use input_order::InputOrderState;
pub use logical::{
    AccessibilityRow, LogicalCell, LogicalCellStyle, LogicalCursor, LogicalRow, LogicalScrollbar,
    LogicalTerminalPatch, LogicalTerminalSnapshot, RowReplacement,
};
pub use model::{RenderRequest, TerminalModel, TerminalModelOptions, TerminalRuntime};
pub use replica::LogicalReplicaModel;
