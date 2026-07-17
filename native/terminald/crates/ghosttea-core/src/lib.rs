//! Platform-neutral Ghosttea terminal model contracts.

mod effects;
pub mod frame;
mod logical;
mod model;

pub use effects::{ClipboardRequest, TerminalEffect, TerminalMetadata, TerminalUpdate};
pub use frame::{FrameCursor, TextSnapshot, encode_text_snapshot};
pub use logical::{
    LogicalCell, LogicalCellStyle, LogicalCursor, LogicalRow, LogicalScrollbar,
    LogicalTerminalSnapshot,
};
pub use model::{RenderRequest, TerminalModel, TerminalModelOptions, TerminalRuntime};
