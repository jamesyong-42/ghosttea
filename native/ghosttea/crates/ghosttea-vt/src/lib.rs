// Keep the native-linking crate in the dependency graph. Its build script is
// the single owner of locating and linking the Ghostty VT artifact.
use ghosttea_vt_sys as _;

use std::{ffi::c_void, fmt, ptr::NonNull};

const EFFECT_BELL: u32 = 1 << 0;
const EFFECT_CLIPBOARD: u32 = 1 << 3;

#[repr(C)]
struct RawTerminal {
    _private: [u8; 0],
}

#[repr(C)]
#[derive(Default)]
struct RawSnapshotMeta {
    cols: u16,
    rows: u16,
    cursor_x: u16,
    cursor_y: u16,
    cursor_visible: u8,
    cursor_style: u8,
    cursor_blinking: u8,
    full_dirty: u8,
    dirty_count: u16,
    effects: u32,
}

type RowCallback = unsafe extern "C" fn(*mut c_void, u16, *const u8, usize, bool);

#[repr(C)]
struct RawCellStyle {
    flags: u8,
    fg_kind: u8,
    fg_r: u8,
    fg_g: u8,
    fg_b: u8,
    bg_kind: u8,
    bg_r: u8,
    bg_g: u8,
    bg_b: u8,
}

#[repr(C)]
#[derive(Default)]
struct RawScrollbar {
    total: u64,
    offset: u64,
    len: u64,
}

type CellCallback =
    unsafe extern "C" fn(*mut c_void, u16, u16, u16, *const u8, usize, *const RawCellStyle);

unsafe extern "C" {
    fn eg_terminal_new(cols: u16, rows: u16, max_scrollback: usize) -> *mut RawTerminal;
    fn eg_terminal_free(terminal: *mut RawTerminal);
    fn eg_terminal_write(terminal: *mut RawTerminal, data: *const u8, len: usize);
    fn eg_terminal_resize(terminal: *mut RawTerminal, cols: u16, rows: u16) -> i32;
    fn eg_terminal_set_colors(
        terminal: *mut RawTerminal,
        fg_r: u8,
        fg_g: u8,
        fg_b: u8,
        bg_r: u8,
        bg_g: u8,
        bg_b: u8,
        cursor_r: u8,
        cursor_g: u8,
        cursor_b: u8,
    ) -> i32;
    fn eg_terminal_scroll(terminal: *mut RawTerminal, rows: isize);
    fn eg_terminal_scroll_to(terminal: *mut RawTerminal, row: usize);
    fn eg_terminal_compress_scrollback_full(terminal: *mut RawTerminal) -> i32;
    fn eg_terminal_scrollbar(terminal: *mut RawTerminal, scrollbar: *mut RawScrollbar) -> bool;
    fn eg_terminal_mouse_tracking(terminal: *mut RawTerminal) -> bool;
    fn eg_terminal_alternate_scroll(terminal: *mut RawTerminal) -> bool;
    fn eg_terminal_selection_text(
        terminal: *mut RawTerminal,
        start_column: u16,
        start_row: u32,
        end_column: u16,
        end_row: u32,
        select_all: bool,
        out: *mut u8,
        cap: usize,
    ) -> usize;
    fn eg_terminal_snapshot(
        terminal: *mut RawTerminal,
        meta: *mut RawSnapshotMeta,
        row_fn: RowCallback,
        cell_fn: CellCallback,
        userdata: *mut c_void,
    ) -> i32;
    fn eg_terminal_take_response(terminal: *mut RawTerminal, out: *mut u8, cap: usize) -> usize;
    fn eg_terminal_title(terminal: *mut RawTerminal, out: *mut u8, cap: usize) -> usize;
    fn eg_terminal_pwd(terminal: *mut RawTerminal, out: *mut u8, cap: usize) -> usize;
    fn eg_terminal_take_clipboard(terminal: *mut RawTerminal, out: *mut u8, cap: usize) -> usize;
    fn eg_terminal_encode_key(
        terminal: *mut RawTerminal,
        code: *const u8,
        code_len: usize,
        text: *const u8,
        text_len: usize,
        unshifted_codepoint: u32,
        mods: u16,
        action: u8,
        out: *mut u8,
        cap: usize,
        out_len: *mut usize,
    ) -> i32;
    fn eg_terminal_encode_mouse(
        terminal: *mut RawTerminal,
        action: u8,
        button: u8,
        mods: u16,
        x: f32,
        y: f32,
        screen_width: u32,
        screen_height: u32,
        cell_width: u32,
        cell_height: u32,
        padding_left: u32,
        padding_top: u32,
        out: *mut u8,
        cap: usize,
        out_len: *mut usize,
    ) -> i32;
    fn eg_terminal_encode_focus(
        terminal: *mut RawTerminal,
        focused: bool,
        out: *mut u8,
        cap: usize,
        out_len: *mut usize,
    ) -> i32;
    fn eg_terminal_encode_paste(
        terminal: *mut RawTerminal,
        data: *const u8,
        data_len: usize,
        out: *mut u8,
        cap: usize,
        out_len: *mut usize,
    ) -> i32;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct GhosttyError(i32);

impl fmt::Display for GhosttyError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "libghostty-vt returned error {}", self.0)
    }
}

impl std::error::Error for GhosttyError {}

#[derive(Debug, Clone, Default)]
pub struct TerminalDamage {
    pub full: bool,
    pub dirty_rows: Vec<u16>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct TerminalScrollbar {
    pub total: u64,
    pub offset: u64,
    pub len: u64,
}

#[derive(Debug, Clone, Default)]
pub struct CursorState {
    pub x: u16,
    pub y: u16,
    pub visible: bool,
    pub style: u8,
    pub blinking: bool,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash)]
pub struct CellStyle {
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

#[derive(Debug, Clone, Default)]
pub struct TerminalCell {
    pub column: u16,
    pub span: u16,
    pub text: String,
    pub style: CellStyle,
}

#[derive(Debug, Clone, Default)]
pub struct TerminalSnapshot {
    pub cols: u16,
    pub rows: Vec<String>,
    pub cells: Vec<Vec<TerminalCell>>,
    pub cursor: CursorState,
    pub damage: TerminalDamage,
    pub title: Option<String>,
    pub cwd: Option<String>,
    pub bell: bool,
    pub mouse_tracking: bool,
    pub scrollbar: TerminalScrollbar,
    pub clipboard: Option<Vec<u8>>,
    pub pty_response: Vec<u8>,
}

pub struct GhosttyTerminalCore {
    raw: NonNull<RawTerminal>,
    cached_rows: Vec<String>,
    cached_cells: Vec<Vec<TerminalCell>>,
}

// libghostty-vt access is serialized by the owning session actor. The opaque
// handle never escapes this wrapper or receives concurrent calls.
unsafe impl Send for GhosttyTerminalCore {}

impl GhosttyTerminalCore {
    pub fn new(cols: u16, rows: u16, max_scrollback: usize) -> Result<Self, GhosttyError> {
        let raw = NonNull::new(unsafe { eg_terminal_new(cols, rows, max_scrollback) })
            .ok_or(GhosttyError(-1))?;
        Ok(Self {
            raw,
            cached_rows: Vec::new(),
            cached_cells: Vec::new(),
        })
    }

    pub fn feed(&mut self, bytes: &[u8]) {
        unsafe { eg_terminal_write(self.raw.as_ptr(), bytes.as_ptr(), bytes.len()) };
    }

    pub fn selection_text(
        &mut self,
        start: (u16, u32),
        end: (u16, u32),
        select_all: bool,
    ) -> Result<String, GhosttyError> {
        let required = unsafe {
            eg_terminal_selection_text(
                self.raw.as_ptr(),
                start.0,
                start.1,
                end.0,
                end.1,
                select_all,
                std::ptr::null_mut(),
                0,
            )
        };
        if required == usize::MAX {
            return Err(GhosttyError(-1));
        }
        let mut output = vec![0_u8; required];
        let written = unsafe {
            eg_terminal_selection_text(
                self.raw.as_ptr(),
                start.0,
                start.1,
                end.0,
                end.1,
                select_all,
                output.as_mut_ptr(),
                output.len(),
            )
        };
        if written == usize::MAX || written > output.len() {
            return Err(GhosttyError(-1));
        }
        output.truncate(written);
        String::from_utf8(output).map_err(|_| GhosttyError(-1))
    }

    pub fn selection_row_count(&self) -> Result<u64, GhosttyError> {
        let mut scrollbar = RawScrollbar::default();
        if unsafe { eg_terminal_scrollbar(self.raw.as_ptr(), &mut scrollbar) } {
            Ok(scrollbar.total)
        } else {
            Err(GhosttyError(-1))
        }
    }

    pub fn encode_paste(&mut self, text: &str) -> Result<Vec<u8>, GhosttyError> {
        let bytes = text.as_bytes();
        let mut output = vec![0_u8; bytes.len().saturating_add(16)];
        let mut written = 0;
        check(unsafe {
            eg_terminal_encode_paste(
                self.raw.as_ptr(),
                bytes.as_ptr(),
                bytes.len(),
                output.as_mut_ptr(),
                output.len(),
                &mut written,
            )
        })?;
        output.truncate(written);
        Ok(output)
    }

    pub fn resize(&mut self, cols: u16, rows: u16) -> Result<(), GhosttyError> {
        check(unsafe { eg_terminal_resize(self.raw.as_ptr(), cols, rows) })
    }

    pub fn set_colors(
        &mut self,
        foreground: [u8; 3],
        background: [u8; 3],
        cursor: [u8; 3],
    ) -> Result<(), GhosttyError> {
        check(unsafe {
            eg_terminal_set_colors(
                self.raw.as_ptr(),
                foreground[0],
                foreground[1],
                foreground[2],
                background[0],
                background[1],
                background[2],
                cursor[0],
                cursor[1],
                cursor[2],
            )
        })
    }

    pub fn scroll(&mut self, rows: isize) {
        unsafe { eg_terminal_scroll(self.raw.as_ptr(), rows) };
    }

    pub fn scroll_to(&mut self, row: usize) {
        unsafe { eg_terminal_scroll_to(self.raw.as_ptr(), row) };
    }

    pub fn compress_scrollback_full(&mut self) -> Result<bool, GhosttyError> {
        match unsafe { eg_terminal_compress_scrollback_full(self.raw.as_ptr()) } {
            0 => Ok(false),
            1 => Ok(true),
            status => Err(GhosttyError(status)),
        }
    }

    pub fn alternate_scroll(&self) -> bool {
        unsafe { eg_terminal_alternate_scroll(self.raw.as_ptr()) }
    }

    #[allow(clippy::too_many_arguments)]
    pub fn encode_mouse(
        &mut self,
        action: u8,
        button: u8,
        mods: u16,
        x: f32,
        y: f32,
        screen_width: u32,
        screen_height: u32,
        cell_width: u32,
        cell_height: u32,
        padding_left: u32,
        padding_top: u32,
    ) -> Result<Vec<u8>, GhosttyError> {
        let mut bytes = vec![0_u8; 128];
        let mut written = 0;
        let mut result = unsafe {
            eg_terminal_encode_mouse(
                self.raw.as_ptr(),
                action,
                button,
                mods,
                x,
                y,
                screen_width,
                screen_height,
                cell_width,
                cell_height,
                padding_left,
                padding_top,
                bytes.as_mut_ptr(),
                bytes.len(),
                &mut written,
            )
        };
        if result == -3 {
            bytes.resize(written, 0);
            result = unsafe {
                eg_terminal_encode_mouse(
                    self.raw.as_ptr(),
                    action,
                    button,
                    mods,
                    x,
                    y,
                    screen_width,
                    screen_height,
                    cell_width,
                    cell_height,
                    padding_left,
                    padding_top,
                    bytes.as_mut_ptr(),
                    bytes.len(),
                    &mut written,
                )
            };
        }
        check(result)?;
        bytes.truncate(written);
        Ok(bytes)
    }

    pub fn encode_focus(&mut self, focused: bool) -> Result<Vec<u8>, GhosttyError> {
        let mut bytes = vec![0_u8; 8];
        let mut written = 0;
        check(unsafe {
            eg_terminal_encode_focus(
                self.raw.as_ptr(),
                focused,
                bytes.as_mut_ptr(),
                bytes.len(),
                &mut written,
            )
        })?;
        bytes.truncate(written);
        Ok(bytes)
    }

    pub fn encode_key(
        &mut self,
        code: &str,
        text: &str,
        unshifted_codepoint: u32,
        mods: u16,
        action: u8,
    ) -> Result<Vec<u8>, GhosttyError> {
        let mut bytes = vec![0_u8; 128];
        let mut written = 0;
        let mut result = unsafe {
            eg_terminal_encode_key(
                self.raw.as_ptr(),
                code.as_ptr(),
                code.len(),
                text.as_ptr(),
                text.len(),
                unshifted_codepoint,
                mods,
                action,
                bytes.as_mut_ptr(),
                bytes.len(),
                &mut written,
            )
        };
        if result == -3 {
            bytes.resize(written, 0);
            result = unsafe {
                eg_terminal_encode_key(
                    self.raw.as_ptr(),
                    code.as_ptr(),
                    code.len(),
                    text.as_ptr(),
                    text.len(),
                    unshifted_codepoint,
                    mods,
                    action,
                    bytes.as_mut_ptr(),
                    bytes.len(),
                    &mut written,
                )
            };
        }
        check(result)?;
        bytes.truncate(written);
        Ok(bytes)
    }

    pub fn snapshot(&mut self) -> Result<TerminalSnapshot, GhosttyError> {
        struct Rows {
            text: Vec<String>,
            cells: Vec<Vec<TerminalCell>>,
            present: Vec<bool>,
            dirty: Vec<u16>,
        }
        unsafe extern "C" fn collect_row(
            userdata: *mut c_void,
            row: u16,
            text: *const u8,
            len: usize,
            dirty: bool,
        ) {
            let rows = unsafe { &mut *(userdata.cast::<Rows>()) };
            let bytes = if len == 0 {
                &[]
            } else {
                unsafe { std::slice::from_raw_parts(text, len) }
            };
            rows.text.resize_with(row as usize + 1, String::new);
            rows.present.resize(row as usize + 1, false);
            rows.text[row as usize] = String::from_utf8_lossy(bytes).into_owned();
            rows.present[row as usize] = dirty;
            if dirty {
                rows.dirty.push(row);
            }
        }
        unsafe extern "C" fn collect_cell(
            userdata: *mut c_void,
            row: u16,
            column: u16,
            span: u16,
            text: *const u8,
            len: usize,
            raw_style: *const RawCellStyle,
        ) {
            let rows = unsafe { &mut *(userdata.cast::<Rows>()) };
            rows.cells.resize_with(row as usize + 1, Vec::new);
            let bytes = if len == 0 {
                &[]
            } else {
                unsafe { std::slice::from_raw_parts(text, len) }
            };
            let raw = unsafe { &*raw_style };
            rows.cells[row as usize].push(TerminalCell {
                column,
                span,
                text: String::from_utf8_lossy(bytes).into_owned(),
                style: CellStyle {
                    bold: raw.flags & 1 != 0,
                    italic: raw.flags & 2 != 0,
                    faint: raw.flags & 4 != 0,
                    inverse: raw.flags & 8 != 0,
                    invisible: raw.flags & 16 != 0,
                    strikethrough: raw.flags & 32 != 0,
                    underline: raw.flags & 64 != 0,
                    foreground: (raw.fg_kind == 1).then_some([raw.fg_r, raw.fg_g, raw.fg_b]),
                    background: (raw.bg_kind == 1).then_some([raw.bg_r, raw.bg_g, raw.bg_b]),
                },
            });
        }

        let mut meta = RawSnapshotMeta::default();
        let mut rows = Rows {
            text: Vec::new(),
            cells: Vec::new(),
            present: Vec::new(),
            dirty: Vec::new(),
        };
        check(unsafe {
            eg_terminal_snapshot(
                self.raw.as_ptr(),
                &mut meta,
                collect_row,
                collect_cell,
                (&mut rows as *mut Rows).cast(),
            )
        })?;
        rows.text.resize_with(meta.rows as usize, String::new);
        rows.cells.resize_with(meta.rows as usize, Vec::new);
        rows.present.resize(meta.rows as usize, false);
        for (row_index, (text, cells)) in rows.text.iter().zip(&mut rows.cells).enumerate() {
            if meta.full_dirty == 0 && !rows.present[row_index] {
                continue;
            }
            let mut bytes = 0;
            cells.retain(|cell| {
                let keep = bytes < text.len() || cell.style != CellStyle::default();
                bytes += cell.text.len();
                keep
            });
        }
        self.cached_rows
            .resize_with(meta.rows as usize, String::new);
        self.cached_cells.resize_with(meta.rows as usize, Vec::new);
        for row_index in 0..meta.rows as usize {
            if meta.full_dirty != 0 || rows.present[row_index] {
                self.cached_rows[row_index] = std::mem::take(&mut rows.text[row_index]);
                self.cached_cells[row_index] = std::mem::take(&mut rows.cells[row_index]);
            }
        }
        let mut scrollbar = RawScrollbar::default();
        let has_scrollbar = unsafe { eg_terminal_scrollbar(self.raw.as_ptr(), &mut scrollbar) };
        Ok(TerminalSnapshot {
            cols: meta.cols,
            rows: self.cached_rows.clone(),
            cells: self.cached_cells.clone(),
            cursor: CursorState {
                x: meta.cursor_x,
                y: meta.cursor_y,
                visible: meta.cursor_visible != 0,
                style: meta.cursor_style,
                blinking: meta.cursor_blinking != 0,
            },
            damage: TerminalDamage {
                full: meta.full_dirty != 0,
                dirty_rows: rows.dirty,
            },
            title: self.read_string(eg_terminal_title),
            cwd: self.read_string(eg_terminal_pwd),
            bell: meta.effects & EFFECT_BELL != 0,
            mouse_tracking: unsafe { eg_terminal_mouse_tracking(self.raw.as_ptr()) },
            scrollbar: if has_scrollbar {
                TerminalScrollbar {
                    total: scrollbar.total,
                    offset: scrollbar.offset,
                    len: scrollbar.len,
                }
            } else {
                TerminalScrollbar {
                    total: meta.rows.into(),
                    offset: 0,
                    len: meta.rows.into(),
                }
            },
            clipboard: (meta.effects & EFFECT_CLIPBOARD != 0).then(|| self.take_clipboard()),
            pty_response: self.take_pty_response(),
        })
    }

    fn read_string(
        &self,
        getter: unsafe extern "C" fn(*mut RawTerminal, *mut u8, usize) -> usize,
    ) -> Option<String> {
        let required = unsafe { getter(self.raw.as_ptr(), std::ptr::null_mut(), 0) };
        if required == 0 {
            return None;
        }
        let mut bytes = vec![0_u8; required];
        unsafe { getter(self.raw.as_ptr(), bytes.as_mut_ptr(), bytes.len()) };
        Some(String::from_utf8_lossy(&bytes).into_owned())
    }

    pub fn take_pty_response(&self) -> Vec<u8> {
        let required =
            unsafe { eg_terminal_take_response(self.raw.as_ptr(), std::ptr::null_mut(), 0) };
        let mut bytes = vec![0_u8; required];
        if required != 0 {
            unsafe {
                eg_terminal_take_response(self.raw.as_ptr(), bytes.as_mut_ptr(), bytes.len())
            };
        }
        bytes
    }

    fn take_clipboard(&self) -> Vec<u8> {
        let required =
            unsafe { eg_terminal_take_clipboard(self.raw.as_ptr(), std::ptr::null_mut(), 0) };
        let mut bytes = vec![0_u8; required];
        if required != 0 {
            unsafe {
                eg_terminal_take_clipboard(self.raw.as_ptr(), bytes.as_mut_ptr(), bytes.len())
            };
        }
        bytes
    }
}

impl Drop for GhosttyTerminalCore {
    fn drop(&mut self) {
        unsafe { eg_terminal_free(self.raw.as_ptr()) };
    }
}

fn check(result: i32) -> Result<(), GhosttyError> {
    if result == 0 {
        Ok(())
    } else {
        Err(GhosttyError(result))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_unicode_styles_and_effects() {
        let mut terminal = GhosttyTerminalCore::new(20, 4, 100).unwrap();
        terminal.feed(b"hello \x1b[31mworld\x1b[0m\r\nwide: \xE7\x95\x8C\x07");
        let snapshot = terminal.snapshot().unwrap();
        assert_eq!(snapshot.rows[0], "hello world");
        assert!(snapshot.rows[1].starts_with("wide: \u{754c}"));
        assert!(snapshot.bell);
        assert!(snapshot.damage.full || !snapshot.damage.dirty_rows.is_empty());
        assert_eq!(snapshot.cells[0][6].style.foreground, Some([204, 102, 102]));
    }

    #[test]
    fn encodes_mode_aware_safe_paste() {
        let mut terminal = GhosttyTerminalCore::new(20, 4, 100).unwrap();
        assert_eq!(
            terminal.encode_paste("first\nsecond").unwrap(),
            b"first\rsecond"
        );
        terminal.feed(b"\x1b[?2004h");
        let encoded = terminal.encode_paste("first\nsecond\x1b[201~tail").unwrap();
        assert!(encoded.starts_with(b"\x1b[200~"));
        assert!(encoded.ends_with(b"\x1b[201~"));
        assert_eq!(
            encoded
                .windows(6)
                .filter(|window| *window == b"\x1b[201~")
                .count(),
            1
        );
    }

    #[test]
    fn preserves_font_style_flags_per_cell() {
        let mut terminal = GhosttyTerminalCore::new(20, 2, 100).unwrap();
        terminal.feed(b"a\x1b[1mb\x1b[3mc\x1b[0md");
        let snapshot = terminal.snapshot().unwrap();
        assert!(!snapshot.cells[0][0].style.bold);
        assert!(snapshot.cells[0][1].style.bold);
        assert!(snapshot.cells[0][2].style.bold && snapshot.cells[0][2].style.italic);
        assert!(!snapshot.cells[0][3].style.bold && !snapshot.cells[0][3].style.italic);
    }

    #[test]
    fn preserves_styled_blank_cells_after_trimmed_text() {
        let mut terminal = GhosttyTerminalCore::new(8, 2, 100).unwrap();
        terminal.feed(b"\x1b[44m   \x1b[0m");
        let snapshot = terminal.snapshot().unwrap();
        assert_eq!(snapshot.rows[0], "");
        assert!(
            snapshot.cells[0]
                .iter()
                .take(3)
                .all(|cell| cell.style.background.is_some())
        );
    }

    #[test]
    fn preserves_background_when_erasing_the_rest_of_a_row() {
        let mut terminal = GhosttyTerminalCore::new(8, 2, 100).unwrap();
        terminal.feed(b"\x1b[44m> go\x1b[K\x1b[0m");
        let snapshot = terminal.snapshot().unwrap();
        assert_eq!(snapshot.rows[0], "> go");
        assert_eq!(snapshot.cells[0].len(), 8);
        assert!(
            snapshot.cells[0]
                .iter()
                .all(|cell| cell.style.background.is_some())
        );
    }

    #[test]
    fn captures_title_and_device_response() {
        let mut terminal = GhosttyTerminalCore::new(20, 4, 100).unwrap();
        terminal.feed(b"\x1b]2;agent shell\x1b\\\x1b[5n");
        let snapshot = terminal.snapshot().unwrap();
        assert_eq!(snapshot.title.as_deref(), Some("agent shell"));
        assert!(!snapshot.pty_response.is_empty());
    }

    #[test]
    fn answers_dynamic_color_queries_from_the_configured_theme() {
        let mut terminal = GhosttyTerminalCore::new(20, 4, 100).unwrap();
        terminal
            .set_colors([1, 2, 3], [4, 5, 6], [7, 8, 9])
            .unwrap();
        terminal.feed(b"\x1b]10;?\x1b\\\x1b]11;?\x1b\\\x1b]12;?\x1b\\");
        let response = terminal.snapshot().unwrap().pty_response;
        assert!(
            response.windows(8).any(|value| value == b"]10;rgb:"),
            "missing foreground response: {response:?}"
        );
        assert!(
            response.windows(8).any(|value| value == b"]11;rgb:"),
            "missing background response: {response:?}"
        );
        assert!(
            response.windows(8).any(|value| value == b"]12;rgb:"),
            "missing cursor response: {response:?}"
        );
    }

    #[test]
    fn encodes_keys_from_terminal_modes() {
        let mut terminal = GhosttyTerminalCore::new(20, 4, 100).unwrap();
        assert_eq!(
            terminal.encode_key("ArrowUp", "", 0, 0, 1).unwrap(),
            b"\x1b[A"
        );
        terminal.feed(b"\x1b[?1h");
        assert_eq!(
            terminal.encode_key("ArrowUp", "", 0, 0, 1).unwrap(),
            b"\x1bOA"
        );
        assert_eq!(
            terminal
                .encode_key("KeyC", "c", 'c'.into(), 1 << 1, 1)
                .unwrap(),
            b"\x03"
        );
    }

    #[test]
    fn suppresses_release_events_without_kitty_event_reporting() {
        let mut terminal = GhosttyTerminalCore::new(20, 4, 100).unwrap();
        let press = terminal.encode_key("KeyW", "w", 'w'.into(), 0, 1).unwrap();
        let release = terminal.encode_key("KeyW", "w", 'w'.into(), 0, 0).unwrap();
        assert_eq!(press, b"w");
        assert!(release.is_empty());
    }

    #[test]
    fn reports_printable_releases_without_repeating_text_in_kitty_mode() {
        let mut terminal = GhosttyTerminalCore::new(20, 4, 100).unwrap();
        terminal.feed(b"\x1b[>7u");
        let press = terminal.encode_key("KeyW", "w", 'w'.into(), 0, 1).unwrap();
        let release = terminal.encode_key("KeyW", "w", 'w'.into(), 0, 0).unwrap();
        assert_eq!(press, b"w");
        assert_eq!(release, b"\x1b[119;1:3u");
    }

    #[test]
    fn encodes_mouse_only_when_application_tracking_is_active() {
        let mut terminal = GhosttyTerminalCore::new(20, 4, 100).unwrap();
        assert!(!terminal.snapshot().unwrap().mouse_tracking);
        assert!(
            terminal
                .encode_mouse(0, 1, 0, 16.0, 22.0, 188, 100, 8, 19, 14, 12)
                .unwrap()
                .is_empty()
        );
        terminal.feed(b"\x1b[?1000h\x1b[?1006h");
        assert!(terminal.snapshot().unwrap().mouse_tracking);
        let encoded = terminal
            .encode_mouse(0, 1, 0, 16.0, 22.0, 668, 404, 8, 19, 14, 12)
            .unwrap();
        assert_eq!(
            encoded, b"\x1b[<0;1;1M",
            "unexpected mouse sequence: {encoded:?}"
        );
    }

    #[test]
    fn captures_osc52_clipboard_writes() {
        let mut terminal = GhosttyTerminalCore::new(20, 4, 100).unwrap();
        terminal.feed(b"\x1b]52;c;aGVsbG8=\x07");
        assert_eq!(
            terminal.snapshot().unwrap().clipboard.as_deref(),
            Some(b"hello".as_slice())
        );
    }

    #[test]
    fn scrolls_the_primary_screen_viewport() {
        let mut terminal = GhosttyTerminalCore::new(20, 3, 100).unwrap();
        terminal.feed(b"one\r\ntwo\r\nthree\r\nfour\r\nfive");
        let bottom = terminal.snapshot().unwrap();
        assert!(bottom.scrollbar.total > bottom.scrollbar.len);
        assert_eq!(
            bottom.scrollbar.offset + bottom.scrollbar.len,
            bottom.scrollbar.total
        );
        terminal.scroll(-2);
        let history = terminal.snapshot().unwrap();
        assert_ne!(history.rows, bottom.rows);
        assert!(history.scrollbar.offset < bottom.scrollbar.offset);
        assert!(
            history
                .rows
                .iter()
                .any(|row| row.starts_with("one") || row.starts_with("two"))
        );
        terminal.scroll_to(bottom.scrollbar.offset as usize);
        let restored = terminal.snapshot().unwrap();
        assert_eq!(restored.rows, bottom.rows);
        assert_eq!(restored.scrollbar, bottom.scrollbar);
    }

    /// Ghostty performs strict page reclamation only on 64-bit Linux and
    /// Darwin (`src/terminal/mem.zig`). Elsewhere full compression reports
    /// unsupported and leaves scrollback memory resident.
    const SCROLLBACK_RECLAIM_SUPPORTED: bool = cfg!(all(
        target_pointer_width = "64",
        any(target_os = "linux", target_vendor = "apple")
    ));

    #[test]
    fn full_scrollback_compression_preserves_logical_content() {
        let mut terminal = GhosttyTerminalCore::new(20, 3, 1_000_000).unwrap();
        for line in 0..2_000 {
            terminal.feed(format!("line-{line:04}\r\n").as_bytes());
        }
        let before = terminal.selection_text((0, 0), (0, 0), true).unwrap();
        let before_scrollbar = terminal.snapshot().unwrap().scrollbar;

        // Logical content must survive either outcome; only reclamation is
        // platform-dependent.
        assert_eq!(
            terminal.compress_scrollback_full().unwrap(),
            SCROLLBACK_RECLAIM_SUPPORTED
        );

        let after = terminal.selection_text((0, 0), (0, 0), true).unwrap();
        let after_scrollbar = terminal.snapshot().unwrap().scrollbar;
        assert_eq!(after, before);
        assert_eq!(after_scrollbar, before_scrollbar);
    }

    #[test]
    fn formats_screen_absolute_and_select_all_ranges() {
        let mut terminal = GhosttyTerminalCore::new(12, 2, 100).unwrap();
        terminal.feed(b"first\r\nsecond\r\nthird");
        let scrollbar = terminal.snapshot().unwrap().scrollbar;
        assert_eq!(terminal.selection_row_count().unwrap(), scrollbar.total);
        assert_eq!(
            terminal.selection_text((0, 1), (5, 1), false).unwrap(),
            "second"
        );
        let all = terminal.selection_text((0, 0), (0, 0), true).unwrap();
        assert!(all.contains("first"));
        assert!(all.contains("third"));
        assert!(scrollbar.total >= 3);
    }

    #[test]
    fn identifies_alternate_screen_scroll_key_mode() {
        let mut terminal = GhosttyTerminalCore::new(20, 3, 100).unwrap();
        assert!(!terminal.alternate_scroll());
        terminal.feed(b"\x1b[?1049h\x1b[?1007h");
        assert!(terminal.alternate_scroll());
        terminal.feed(b"\x1b[?1007l");
        assert!(!terminal.alternate_scroll());
    }

    #[test]
    fn exposes_requested_cursor_style_and_blinking() {
        let mut terminal = GhosttyTerminalCore::new(20, 3, 100).unwrap();
        assert!(terminal.snapshot().unwrap().cursor.blinking);
        terminal.feed(b"\x1b[5 q");
        let bar = terminal.snapshot().unwrap().cursor;
        assert_eq!(bar.style, 0);
        assert!(bar.blinking);
        terminal.feed(b"\x1b[4 q");
        let underline = terminal.snapshot().unwrap().cursor;
        assert_eq!(underline.style, 2);
        assert!(!underline.blinking);
    }

    #[test]
    fn encodes_focus_only_when_application_reporting_is_active() {
        let mut terminal = GhosttyTerminalCore::new(20, 3, 100).unwrap();
        assert!(terminal.encode_focus(true).unwrap().is_empty());
        terminal.feed(b"\x1b[?1004h");
        assert_eq!(terminal.encode_focus(true).unwrap(), b"\x1b[I");
        assert_eq!(terminal.encode_focus(false).unwrap(), b"\x1b[O");
    }

    #[test]
    fn restores_primary_screen_after_alternate_screen() {
        let mut terminal = GhosttyTerminalCore::new(20, 4, 100).unwrap();
        terminal.feed(b"primary");
        terminal.feed(b"\x1b[?1049h\x1b[2J\x1b[Halternate");
        assert!(terminal.snapshot().unwrap().rows[0].starts_with("alternate"));
        terminal.feed(b"\x1b[?1049l");
        assert!(terminal.snapshot().unwrap().rows[0].starts_with("primary"));
    }

    #[test]
    fn reflows_wrapped_unicode_on_resize() {
        let mut terminal = GhosttyTerminalCore::new(6, 4, 100).unwrap();
        terminal.feed("ab界cdef".as_bytes());
        terminal.resize(12, 4).unwrap();
        let joined = terminal.snapshot().unwrap().rows.join("");
        assert!(
            joined.starts_with("ab界cdef"),
            "unexpected reflow output: {joined:?}"
        );
    }

    #[test]
    fn remains_stable_under_arbitrary_input_chunks() {
        let mut terminal = GhosttyTerminalCore::new(40, 8, 100).unwrap();
        let mut state = 0x5eed_u32;
        for chunk_index in 0..256 {
            let mut bytes = [0_u8; 64];
            for byte in &mut bytes {
                state = state.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                *byte = (state >> 24) as u8;
            }
            terminal.feed(&bytes);
            if chunk_index % 16 == 0 {
                terminal.snapshot().unwrap();
            }
        }
        terminal.snapshot().unwrap();
    }
}
