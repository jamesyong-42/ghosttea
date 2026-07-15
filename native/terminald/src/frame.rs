use anyhow::{Result, bail};
use ghosttea_text::{GlyphDefinition, GlyphFormat, GlyphInstance, ShapedRow};
use ghosttea_vt::{CellStyle, TerminalCell};
use std::collections::BTreeMap;

pub const FRAME_MAGIC: u32 = 0x3146_5254;
pub const FRAME_HEADER_BYTES: usize = 64;
pub const SECTION_HEADER_BYTES: usize = 16;
pub const ACCESSIBILITY_TEXT: u16 = 10;
pub const CURSOR_STATE: u16 = 4;
pub const ROW_REPLACEMENTS: u16 = 3;
pub const STYLE_DEFINITIONS: u16 = 2;
pub const GLYPH_DEFINITIONS: u16 = 1;
pub const CLIPBOARD_WRITE: u16 = 11;
pub const FULL_SNAPSHOT: u16 = 1;
pub const MOUSE_TRACKING: u16 = 1 << 1;

pub struct FrameCursor {
    pub x: u16,
    pub y: u16,
    pub visible: bool,
    pub style: u8,
    pub blinking: bool,
}

fn put_u16(target: &mut [u8], offset: usize, value: u16) {
    target[offset..offset + 2].copy_from_slice(&value.to_le_bytes());
}

fn put_u32(target: &mut [u8], offset: usize, value: u32) {
    target[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
}

fn put_u64(target: &mut [u8], offset: usize, value: u64) {
    target[offset..offset + 8].copy_from_slice(&value.to_le_bytes());
}

fn encode_glyph_definitions(definitions: &[GlyphDefinition]) -> Result<(Vec<u8>, u32)> {
    let count: u32 = definitions.len().try_into()?;
    let mut bytes = Vec::new();
    bytes.extend_from_slice(&count.to_le_bytes());
    for definition in definitions {
        let pixel_length: u32 = definition.pixels.len().try_into()?;
        bytes.extend_from_slice(&definition.id.to_le_bytes());
        bytes.extend_from_slice(&definition.width.to_le_bytes());
        bytes.extend_from_slice(&definition.height.to_le_bytes());
        bytes.extend_from_slice(&definition.bearing_x.to_le_bytes());
        bytes.extend_from_slice(&definition.bearing_y.to_le_bytes());
        bytes.push(match definition.format {
            GlyphFormat::Alpha8 => 0,
            GlyphFormat::Rgba8Premultiplied => 1,
        });
        bytes.extend_from_slice(&[0; 3]);
        bytes.extend_from_slice(&pixel_length.to_le_bytes());
        bytes.extend_from_slice(&definition.pixels);
    }
    Ok((bytes, count))
}

fn style_id(style: CellStyle) -> u32 {
    if style == CellStyle::default() {
        return 0;
    }
    let mut hash = 2_166_136_261_u32;
    let flags = [
        style.bold,
        style.italic,
        style.faint,
        style.inverse,
        style.invisible,
        style.strikethrough,
        style.underline,
    ];
    let foreground = style.foreground.unwrap_or([0; 3]);
    let background = style.background.unwrap_or([0; 3]);
    for byte in flags
        .into_iter()
        .map(u8::from)
        .chain([u8::from(style.foreground.is_some())])
        .chain(foreground)
        .chain([u8::from(style.background.is_some())])
        .chain(background)
    {
        hash ^= byte as u32;
        hash = hash.wrapping_mul(16_777_619);
    }
    if hash == 0 { 1 } else { hash }
}

fn encode_style_definitions(styles: &BTreeMap<u32, CellStyle>) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(4 + styles.len() * 16);
    bytes.extend_from_slice(&(styles.len() as u32).to_le_bytes());
    for (id, style) in styles {
        let flags = u16::from(style.bold)
            | (u16::from(style.italic) << 1)
            | (u16::from(style.faint) << 2)
            | (u16::from(style.inverse) << 3)
            | (u16::from(style.invisible) << 4)
            | (u16::from(style.strikethrough) << 5)
            | (u16::from(style.underline) << 6);
        let foreground = style.foreground.unwrap_or([0; 3]);
        let background = style.background.unwrap_or([0; 3]);
        bytes.extend_from_slice(&id.to_le_bytes());
        bytes.extend_from_slice(&flags.to_le_bytes());
        bytes.push(u8::from(style.foreground.is_some()));
        bytes.push(u8::from(style.background.is_some()));
        bytes.extend_from_slice(&foreground);
        bytes.extend_from_slice(&background);
        bytes.extend_from_slice(&0_u16.to_le_bytes());
    }
    bytes
}

fn encode_glyph_instance(bytes: &mut Vec<u8>, glyph: &GlyphInstance, style_id: u32) {
    bytes.extend_from_slice(&glyph.glyph_id.to_le_bytes());
    bytes.extend_from_slice(&style_id.to_le_bytes());
    bytes.extend_from_slice(&glyph.x.to_le_bytes());
    bytes.extend_from_slice(&glyph.y.to_le_bytes());
    bytes.extend_from_slice(&glyph.width.to_le_bytes());
    bytes.extend_from_slice(&glyph.height.to_le_bytes());
    bytes.extend_from_slice(&glyph.cell_start.to_le_bytes());
    bytes.extend_from_slice(&glyph.cell_span.to_le_bytes());
}

pub struct TextSnapshot<'a> {
    pub session_handle: u64,
    pub session_epoch: u64,
    pub layout_epoch: u64,
    pub sequence: u64,
    pub revision: u64,
    pub cols: u16,
    pub rows: &'a [String],
    pub shaped_rows: &'a [ShapedRow],
    pub cells: &'a [Vec<TerminalCell>],
    pub updated_rows: &'a [u16],
    pub full_snapshot: bool,
    pub mouse_tracking: bool,
    pub new_glyph_definitions: &'a [GlyphDefinition],
    pub clipboard: Option<&'a [u8]>,
    pub cursor: &'a FrameCursor,
}

pub fn encode_text_snapshot(snapshot: TextSnapshot<'_>) -> Result<Vec<u8>> {
    let TextSnapshot {
        session_handle,
        session_epoch,
        layout_epoch,
        sequence,
        revision,
        cols,
        rows,
        shaped_rows,
        cells,
        updated_rows,
        full_snapshot,
        mouse_tracking,
        new_glyph_definitions,
        clipboard,
        cursor,
    } = snapshot;
    if rows.len() > u16::MAX as usize {
        bail!("too many rows");
    }
    if rows.len() != shaped_rows.len() || rows.len() != cells.len() {
        bail!("text, shaped, and styled row counts differ");
    }
    let mut styles = BTreeMap::new();
    styles.insert(0, CellStyle::default());
    for row in updated_rows {
        for cell in cells.get(*row as usize).into_iter().flatten() {
            styles.entry(style_id(cell.style)).or_insert(cell.style);
        }
    }
    let (glyph_definitions, glyph_count) = encode_glyph_definitions(new_glyph_definitions)?;
    let style_definitions = encode_style_definitions(&styles);
    let mut accessibility = Vec::new();
    accessibility.extend_from_slice(&(updated_rows.len() as u16).to_le_bytes());
    let mut replacements = Vec::new();
    replacements.extend_from_slice(&(updated_rows.len() as u16).to_le_bytes());
    for row in updated_rows.iter().copied() {
        let row_index = row as usize;
        let text = &rows[row_index];
        let shaped = &shaped_rows[row_index];
        let row_cells = &cells[row_index];
        let bytes = text.as_bytes();
        if bytes.len() > u32::MAX as usize {
            bail!("row is too large");
        }
        accessibility.extend_from_slice(&row.to_le_bytes());
        accessibility.extend_from_slice(&(bytes.len() as u32).to_le_bytes());
        accessibility.extend_from_slice(bytes);
        replacements.extend_from_slice(&row.to_le_bytes());
        replacements.extend_from_slice(&revision.to_le_bytes());
        replacements.extend_from_slice(&(bytes.len() as u32).to_le_bytes());
        replacements.extend_from_slice(&(shaped.glyphs.len() as u16).to_le_bytes());
        let mut runs: Vec<(u32, u16, u16)> = Vec::new();
        for cell in row_cells {
            let id = style_id(cell.style);
            if id == 0 {
                continue;
            }
            if let Some((previous_id, start, span)) = runs.last_mut()
                && *previous_id == id
                && start.saturating_add(*span) == cell.column
            {
                *span = span.saturating_add(cell.span);
                continue;
            }
            runs.push((id, cell.column, cell.span));
        }
        replacements.extend_from_slice(&(runs.len() as u16).to_le_bytes());
        replacements.extend_from_slice(bytes);
        for glyph in &shaped.glyphs {
            let style_id = row_cells
                .iter()
                .find(|cell| {
                    glyph.cell_start >= cell.column
                        && glyph.cell_start < cell.column.saturating_add(cell.span)
                })
                .map(|cell| style_id(cell.style))
                .unwrap_or(0);
            encode_glyph_instance(&mut replacements, glyph, style_id);
        }
        for (style_id, cell_start, cell_span) in runs {
            replacements.extend_from_slice(&style_id.to_le_bytes());
            replacements.extend_from_slice(&cell_start.to_le_bytes());
            replacements.extend_from_slice(&cell_span.to_le_bytes());
        }
    }

    let clipboard_payload = clipboard.map(|text| {
        let mut bytes = Vec::with_capacity(4 + text.len());
        bytes.extend_from_slice(&(text.len() as u32).to_le_bytes());
        bytes.extend_from_slice(text);
        bytes
    });
    let section_count = 5 + usize::from(clipboard_payload.is_some());
    let glyph_offset = FRAME_HEADER_BYTES + SECTION_HEADER_BYTES * section_count;
    let style_offset = glyph_offset + glyph_definitions.len();
    let replacement_offset = style_offset + style_definitions.len();
    let cursor_offset = replacement_offset + replacements.len();
    let accessibility_offset = cursor_offset + 8;
    let mut packet = vec![0; glyph_offset];
    packet.extend_from_slice(&glyph_definitions);
    packet.extend_from_slice(&style_definitions);
    packet.extend_from_slice(&replacements);
    packet.extend_from_slice(&cursor.x.to_le_bytes());
    packet.extend_from_slice(&cursor.y.to_le_bytes());
    packet.push(u8::from(cursor.visible));
    packet.push(cursor.style);
    packet.push(u8::from(cursor.blinking));
    packet.push(0);
    packet.extend_from_slice(&accessibility);
    let clipboard_offset = packet.len();
    if let Some(bytes) = &clipboard_payload {
        packet.extend_from_slice(bytes);
    }

    put_u32(&mut packet, 0, FRAME_MAGIC);
    put_u16(&mut packet, 4, 1);
    put_u16(
        &mut packet,
        6,
        (if full_snapshot { FULL_SNAPSHOT } else { 0 })
            | (if mouse_tracking { MOUSE_TRACKING } else { 0 }),
    );
    put_u64(&mut packet, 8, session_handle);
    put_u64(&mut packet, 16, session_handle);
    put_u64(&mut packet, 24, session_epoch);
    put_u64(&mut packet, 32, layout_epoch);
    put_u64(&mut packet, 40, sequence);
    put_u64(&mut packet, 48, revision);
    put_u16(&mut packet, 56, cols);
    put_u16(&mut packet, 58, rows.len() as u16);
    put_u16(&mut packet, 60, section_count as u16);

    put_u16(&mut packet, 64, GLYPH_DEFINITIONS);
    put_u32(&mut packet, 68, glyph_offset as u32);
    put_u32(&mut packet, 72, glyph_definitions.len() as u32);
    put_u32(&mut packet, 76, glyph_count);
    put_u16(&mut packet, 80, STYLE_DEFINITIONS);
    put_u32(&mut packet, 84, style_offset as u32);
    put_u32(&mut packet, 88, style_definitions.len() as u32);
    put_u32(&mut packet, 92, styles.len() as u32);
    put_u16(&mut packet, 96, ROW_REPLACEMENTS);
    put_u16(
        &mut packet,
        98,
        if full_snapshot { FULL_SNAPSHOT } else { 0 },
    );
    put_u32(&mut packet, 100, replacement_offset as u32);
    put_u32(&mut packet, 104, replacements.len() as u32);
    put_u32(&mut packet, 108, updated_rows.len() as u32);
    put_u16(&mut packet, 112, CURSOR_STATE);
    put_u32(&mut packet, 116, cursor_offset as u32);
    put_u32(&mut packet, 120, 8);
    put_u32(&mut packet, 124, 1);
    put_u16(&mut packet, 128, ACCESSIBILITY_TEXT);
    put_u32(&mut packet, 132, accessibility_offset as u32);
    put_u32(&mut packet, 136, accessibility.len() as u32);
    put_u32(&mut packet, 140, updated_rows.len() as u32);
    if let Some(bytes) = &clipboard_payload {
        put_u16(&mut packet, 144, CLIPBOARD_WRITE);
        put_u32(&mut packet, 148, clipboard_offset as u32);
        put_u32(&mut packet, 152, bytes.len() as u32);
        put_u32(&mut packet, 156, 1);
    }
    Ok(packet)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snapshot_has_expected_header() {
        let mut engine = ghosttea_text::TextEngine::discover().unwrap();
        let shaped = vec![
            engine
                .shape_row("hello", ghosttea_text::FontStyle::default())
                .unwrap(),
        ];
        let cells = vec![vec![TerminalCell {
            column: 0,
            span: 1,
            text: "h".into(),
            style: CellStyle::default(),
        }]];
        let cursor = FrameCursor {
            x: 5,
            y: 0,
            visible: true,
            style: 1,
            blinking: true,
        };
        let frame = encode_text_snapshot(TextSnapshot {
            session_handle: 4,
            session_epoch: 1,
            layout_epoch: 2,
            sequence: 3,
            revision: 5,
            cols: 80,
            rows: &["hello".into()],
            shaped_rows: &shaped,
            cells: &cells,
            updated_rows: &[0],
            full_snapshot: true,
            mouse_tracking: false,
            new_glyph_definitions: &shaped[0].definitions,
            clipboard: None,
            cursor: &cursor,
        })
        .unwrap();
        assert_eq!(&frame[0..4], &FRAME_MAGIC.to_le_bytes());
        assert_eq!(u64::from_le_bytes(frame[40..48].try_into().unwrap()), 3);
        assert_eq!(u16::from_le_bytes(frame[60..62].try_into().unwrap()), 5);
        assert_eq!(
            u16::from_le_bytes(frame[64..66].try_into().unwrap()),
            GLYPH_DEFINITIONS
        );
        assert_eq!(
            u16::from_le_bytes(frame[96..98].try_into().unwrap()),
            ROW_REPLACEMENTS
        );
        assert_eq!(u32::from_le_bytes(frame[120..124].try_into().unwrap()), 8);
        let cursor_offset = u32::from_le_bytes(frame[116..120].try_into().unwrap()) as usize;
        assert_eq!(&frame[cursor_offset + 4..cursor_offset + 8], &[1, 1, 1, 0]);
    }

    #[test]
    fn incremental_frame_contains_only_updated_rows_and_no_repeated_glyphs() {
        let mut engine = ghosttea_text::TextEngine::discover().unwrap();
        let shaped = vec![
            engine
                .shape_row("stable", ghosttea_text::FontStyle::default())
                .unwrap(),
            engine
                .shape_row("changed", ghosttea_text::FontStyle::default())
                .unwrap(),
        ];
        let cells = vec![Vec::new(), Vec::new()];
        let cursor = FrameCursor {
            x: 7,
            y: 1,
            visible: true,
            style: 1,
            blinking: true,
        };
        let frame = encode_text_snapshot(TextSnapshot {
            session_handle: 4,
            session_epoch: 1,
            layout_epoch: 2,
            sequence: 4,
            revision: 6,
            cols: 80,
            rows: &["stable".into(), "changed".into()],
            shaped_rows: &shaped,
            cells: &cells,
            updated_rows: &[1],
            full_snapshot: false,
            mouse_tracking: false,
            new_glyph_definitions: &[],
            clipboard: None,
            cursor: &cursor,
        })
        .unwrap();
        assert_eq!(u16::from_le_bytes(frame[6..8].try_into().unwrap()), 0);
        assert_eq!(u32::from_le_bytes(frame[76..80].try_into().unwrap()), 0);
        assert_eq!(u16::from_le_bytes(frame[98..100].try_into().unwrap()), 0);
        assert_eq!(u32::from_le_bytes(frame[108..112].try_into().unwrap()), 1);
    }

    #[test]
    fn advertises_mouse_tracking_and_transports_clipboard_writes() {
        let shaped = vec![ShapedRow::default()];
        let cursor = FrameCursor {
            x: 0,
            y: 0,
            visible: false,
            style: 1,
            blinking: false,
        };
        let frame = encode_text_snapshot(TextSnapshot {
            session_handle: 4,
            session_epoch: 1,
            layout_epoch: 2,
            sequence: 5,
            revision: 7,
            cols: 80,
            rows: &[String::new()],
            shaped_rows: &shaped,
            cells: &[Vec::new()],
            updated_rows: &[0],
            full_snapshot: false,
            mouse_tracking: true,
            new_glyph_definitions: &[],
            clipboard: Some(b"copied"),
            cursor: &cursor,
        })
        .unwrap();
        assert_eq!(
            u16::from_le_bytes(frame[6..8].try_into().unwrap()) & MOUSE_TRACKING,
            MOUSE_TRACKING
        );
        assert_eq!(u16::from_le_bytes(frame[60..62].try_into().unwrap()), 6);
        assert_eq!(
            u16::from_le_bytes(frame[144..146].try_into().unwrap()),
            CLIPBOARD_WRITE
        );
        let offset = u32::from_le_bytes(frame[148..152].try_into().unwrap()) as usize;
        assert_eq!(&frame[offset + 4..], b"copied");
    }
}
