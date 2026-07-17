//! Platform-neutral Ghosttea terminal model contracts.

mod effects;
mod logical;

pub use effects::{ClipboardRequest, TerminalEffect, TerminalMetadata, TerminalUpdate};
pub use logical::{
    LogicalCell, LogicalCellStyle, LogicalCursor, LogicalRow, LogicalScrollbar,
    LogicalTerminalSnapshot,
};
