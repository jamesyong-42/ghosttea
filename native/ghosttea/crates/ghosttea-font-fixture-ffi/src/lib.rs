use std::{panic::AssertUnwindSafe, ptr, slice};

use ghosttea_text::{
    FontPresentation, FontResource, FontResources, RASTER_SCALE, TextEngine, TextMetrics,
    phase2_fixture_cases,
};

pub const GHOSTTEA_FONT_FIXTURE_OK: i32 = 0;
pub const GHOSTTEA_FONT_FIXTURE_INVALID_ARGUMENT: i32 = 1;
pub const GHOSTTEA_FONT_FIXTURE_FAILED: i32 = 2;
pub const GHOSTTEA_FONT_FIXTURE_PANIC: i32 = 3;

#[repr(C)]
#[derive(Clone, Copy)]
pub struct GhostteaFontBytes {
    pub data: *const u8,
    pub len: usize,
}

#[repr(C)]
pub struct GhostteaOwnedBytes {
    pub data: *mut u8,
    pub len: usize,
    pub capacity: usize,
}

impl GhostteaOwnedBytes {
    const EMPTY: Self = Self {
        data: ptr::null_mut(),
        len: 0,
        capacity: 0,
    };
}

fn copy_font(input: GhostteaFontBytes, name: &str) -> Option<FontResource> {
    if input.data.is_null() || input.len == 0 {
        return None;
    }
    // SAFETY: The caller promises that a non-null input points to `len` readable bytes for the
    // duration of this call. We immediately copy the bytes into Rust-owned storage.
    let bytes = unsafe { slice::from_raw_parts(input.data, input.len) }.to_vec();
    Some(FontResource::new(name, bytes))
}

fn generate(
    regular: GhostteaFontBytes,
    bold: GhostteaFontBytes,
    italic: GhostteaFontBytes,
    bold_italic: GhostteaFontBytes,
    emoji: GhostteaFontBytes,
    symbols_math: GhostteaFontBytes,
    symbols: GhostteaFontBytes,
    emoji_text: GhostteaFontBytes,
) -> Result<Vec<u8>, i32> {
    let mut fonts = FontResources::new(
        copy_font(regular, "JetBrainsMonoNerdFont-Regular.ttf")
            .ok_or(GHOSTTEA_FONT_FIXTURE_INVALID_ARGUMENT)?,
    );
    fonts.bold = Some(
        copy_font(bold, "JetBrainsMonoNerdFont-Bold.ttf")
            .ok_or(GHOSTTEA_FONT_FIXTURE_INVALID_ARGUMENT)?,
    );
    fonts.italic = Some(
        copy_font(italic, "JetBrainsMonoNerdFont-Italic.ttf")
            .ok_or(GHOSTTEA_FONT_FIXTURE_INVALID_ARGUMENT)?,
    );
    fonts.bold_italic = Some(
        copy_font(bold_italic, "JetBrainsMonoNerdFont-BoldItalic.ttf")
            .ok_or(GHOSTTEA_FONT_FIXTURE_INVALID_ARGUMENT)?,
    );
    fonts.fallbacks = vec![
        copy_font(emoji, "NotoColorEmoji.ttf")
            .ok_or(GHOSTTEA_FONT_FIXTURE_INVALID_ARGUMENT)?
            .with_presentation(FontPresentation::Emoji),
        copy_font(symbols_math, "STIXTwoMath-Regular.otf")
            .ok_or(GHOSTTEA_FONT_FIXTURE_INVALID_ARGUMENT)?
            .with_presentation(FontPresentation::Text),
        copy_font(symbols, "NotoSansSymbols2-Regular.ttf")
            .ok_or(GHOSTTEA_FONT_FIXTURE_INVALID_ARGUMENT)?
            .with_presentation(FontPresentation::Text),
        copy_font(emoji_text, "NotoEmoji-Regular.ttf")
            .ok_or(GHOSTTEA_FONT_FIXTURE_INVALID_ARGUMENT)?
            .with_presentation(FontPresentation::Text),
    ];
    let mut engine = TextEngine::from_fonts(fonts, TextMetrics::default(), RASTER_SCALE)
        .map_err(|_| GHOSTTEA_FONT_FIXTURE_FAILED)?;
    let fixture = engine
        .shaping_fixture(&phase2_fixture_cases())
        .map_err(|_| GHOSTTEA_FONT_FIXTURE_FAILED)?;
    serde_json::to_vec_pretty(&fixture).map_err(|_| GHOSTTEA_FONT_FIXTURE_FAILED)
}

#[unsafe(no_mangle)]
/// Generates the normalized Phase 2 shaping fixture.
///
/// # Safety
///
/// Every input must point to `len` readable bytes for the duration of the call, and `out` must
/// point to writable storage for one [`GhostteaOwnedBytes`].
pub unsafe extern "C" fn ghosttea_font_fixture_generate(
    regular: GhostteaFontBytes,
    bold: GhostteaFontBytes,
    italic: GhostteaFontBytes,
    bold_italic: GhostteaFontBytes,
    emoji: GhostteaFontBytes,
    symbols_math: GhostteaFontBytes,
    symbols: GhostteaFontBytes,
    emoji_text: GhostteaFontBytes,
    out: *mut GhostteaOwnedBytes,
) -> i32 {
    if out.is_null() {
        return GHOSTTEA_FONT_FIXTURE_INVALID_ARGUMENT;
    }
    // SAFETY: `out` is non-null and the caller promises it is writable.
    unsafe { out.write(GhostteaOwnedBytes::EMPTY) };
    match std::panic::catch_unwind(AssertUnwindSafe(|| {
        generate(
            regular,
            bold,
            italic,
            bold_italic,
            emoji,
            symbols_math,
            symbols,
            emoji_text,
        )
    })) {
        Ok(Ok(mut bytes)) => {
            let owned = GhostteaOwnedBytes {
                data: bytes.as_mut_ptr(),
                len: bytes.len(),
                capacity: bytes.capacity(),
            };
            std::mem::forget(bytes);
            // SAFETY: `out` was validated above and remains writable for this call.
            unsafe { out.write(owned) };
            GHOSTTEA_FONT_FIXTURE_OK
        }
        Ok(Err(status)) => status,
        Err(_) => GHOSTTEA_FONT_FIXTURE_PANIC,
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn ghosttea_font_fixture_free(bytes: GhostteaOwnedBytes) {
    if bytes.data.is_null() {
        return;
    }
    // SAFETY: This function only accepts buffers returned by `ghosttea_font_fixture_generate`,
    // whose pointer, length, and capacity came from a forgotten Vec allocation.
    unsafe { drop(Vec::from_raw_parts(bytes.data, bytes.len, bytes.capacity)) };
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_missing_fonts() {
        let empty = GhostteaFontBytes {
            data: ptr::null(),
            len: 0,
        };
        let mut output = GhostteaOwnedBytes::EMPTY;
        assert_eq!(
            unsafe {
                ghosttea_font_fixture_generate(
                    empty,
                    empty,
                    empty,
                    empty,
                    empty,
                    empty,
                    empty,
                    empty,
                    &mut output,
                )
            },
            GHOSTTEA_FONT_FIXTURE_INVALID_ARGUMENT
        );
        assert!(output.data.is_null());
    }
}
