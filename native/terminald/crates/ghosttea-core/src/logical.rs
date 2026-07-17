use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LogicalTerminalSnapshot {
    pub session_epoch: u64,
    pub layout_epoch: u64,
    pub terminal_revision: u64,
    pub cols: u16,
    pub rows: Vec<LogicalRow>,
    pub cursor: LogicalCursor,
    pub mouse_tracking: bool,
    pub scrollbar: LogicalScrollbar,
    pub title: Option<String>,
    pub cwd: Option<String>,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LogicalScrollbar {
    pub total: u64,
    pub offset: u64,
    pub len: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LogicalRow {
    pub text: String,
    pub cells: Vec<LogicalCell>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LogicalCell {
    pub column: u16,
    pub span: u16,
    pub text: String,
    pub style: LogicalCellStyle,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LogicalCellStyle {
    pub bold: bool,
    pub italic: bool,
    pub faint: bool,
    pub inverse: bool,
    pub invisible: bool,
    pub strikethrough: bool,
    pub underline: bool,
    pub foreground: Option<[u8; 3]>,
    pub background: Option<[u8; 3]>,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LogicalCursor {
    pub x: u16,
    pub y: u16,
    pub visible: bool,
    pub style: u8,
    pub blinking: bool,
}
