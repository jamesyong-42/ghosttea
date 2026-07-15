use std::{
    collections::{HashMap, HashSet},
    sync::Arc,
};

use anyhow::{bail, Context, Result};
use fontdb::{Database, Family, ID, Query, Stretch, Style, Weight};
use harfbuzz_rs::{shape, Face, Font, UnicodeBuffer};
use swash::{
    scale::{image::Content, Render, ScaleContext, Source, StrikeWith},
    zeno::Format,
    FontRef,
};
use unicode_segmentation::UnicodeSegmentation;
use unicode_width::UnicodeWidthStr;

pub const FONT_SIZE_PX: f32 = 13.0;
pub const RASTER_SCALE: f32 = 2.0;
pub const CELL_WIDTH_PX: f32 = 7.83;
pub const LINE_HEIGHT_PX: f32 = 19.0;
pub const BASELINE_PX: f32 = 14.0;

#[derive(Clone, Copy, Debug, Default, Eq, Hash, PartialEq)]
pub struct FontStyle {
    pub bold: bool,
    pub italic: bool,
}

#[derive(Clone, Copy, Debug)]
pub struct StyleSpan {
    pub byte_start: usize,
    pub byte_end: usize,
    pub style: FontStyle,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u8)]
pub enum GlyphFormat {
    Alpha8 = 0,
    Rgba8Premultiplied = 1,
}

#[derive(Clone, Debug)]
pub struct GlyphDefinition {
    pub id: u32,
    pub width: u16,
    pub height: u16,
    pub bearing_x: i16,
    pub bearing_y: i16,
    pub format: GlyphFormat,
    pub pixels: Arc<[u8]>,
}

#[derive(Clone, Copy, Debug)]
pub struct GlyphInstance {
    pub glyph_id: u32,
    pub style_id: u32,
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
    pub cell_start: u16,
    pub cell_span: u16,
}

#[derive(Clone, Debug, Default)]
pub struct ShapedRow {
    pub glyphs: Vec<GlyphInstance>,
    pub definitions: Vec<GlyphDefinition>,
}

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
struct GlyphKey {
    face_id: u32,
    glyph_index: u32,
    pixel_size_26_6: u32,
    render_flags: u16,
}

struct LoadedFace {
    id: u32,
    index: u32,
    data: Arc<dyn AsRef<[u8]> + Send + Sync>,
}

#[derive(Clone)]
struct Grapheme<'a> {
    text: &'a str,
    byte_start: usize,
    cell_start: u16,
    cell_span: u16,
    face: ID,
    style: FontStyle,
}

pub struct TextEngine {
    database: Database,
    primary_family: String,
    styled_faces: HashMap<FontStyle, ID>,
    fallback_faces: HashMap<char, ID>,
    loaded_faces: HashMap<ID, LoadedFace>,
    next_face_id: u32,
    glyph_ids: HashMap<GlyphKey, u32>,
    glyphs: HashMap<u32, GlyphDefinition>,
    next_glyph_id: u32,
    scale_context: ScaleContext,
}

const MAX_CACHED_GLYPHS: usize = 65_536;

impl TextEngine {
    pub fn discover() -> Result<Self> {
        let requested = std::env::var("ELECTRON_GHOSTTY_FONT_FAMILY").ok();
        Self::discover_with_family(requested.as_deref())
    }

    pub fn discover_with_family(requested: Option<&str>) -> Result<Self> {
        let mut database = Database::new();
        database.load_system_fonts();
        let mut preferred = Vec::new();
        if let Some(family) = requested {
            preferred.push(Family::Name(family));
        }
        preferred.extend([
            Family::Name("JetBrains Mono"),
            Family::Name("Fira Code"),
            Family::Name("Cascadia Code"),
            Family::Name("SF Mono"),
            Family::Name("Menlo"),
            Family::Name("Monaco"),
            Family::Name("Cascadia Mono"),
            Family::Name("DejaVu Sans Mono"),
            Family::Monospace,
        ]);
        let primary = database
            .query(&Query { families: &preferred, ..Query::default() })
            .or_else(|| database.faces().find(|face| face.monospaced).map(|face| face.id))
            .context("no system monospace font was discovered")?;
        let primary_family = database
            .face(primary)
            .and_then(|face| face.families.first())
            .map(|family| family.0.clone())
            .context("primary font has no family name")?;

        let mut styled_faces = HashMap::new();
        for style in [
            FontStyle::default(),
            FontStyle { bold: true, italic: false },
            FontStyle { bold: false, italic: true },
            FontStyle { bold: true, italic: true },
        ] {
            let families = [Family::Name(primary_family.as_str())];
            let face = database.query(&Query {
                families: &families,
                weight: if style.bold { Weight::BOLD } else { Weight::NORMAL },
                stretch: Stretch::Normal,
                style: if style.italic { Style::Italic } else { Style::Normal },
            }).unwrap_or(primary);
            styled_faces.insert(style, face);
        }

        Ok(Self {
            database,
            primary_family,
            styled_faces,
            fallback_faces: HashMap::new(),
            loaded_faces: HashMap::new(),
            next_face_id: 1,
            glyph_ids: HashMap::new(),
            glyphs: HashMap::new(),
            next_glyph_id: 1,
            scale_context: ScaleContext::new(),
        })
    }

    pub fn primary_family(&self) -> &str {
        &self.primary_family
    }

    pub fn shape_row(&mut self, text: &str, style: FontStyle) -> Result<ShapedRow> {
        self.shape_styled_row(text, &[StyleSpan { byte_start: 0, byte_end: text.len(), style }])
    }

    pub fn shape_styled_row(&mut self, text: &str, spans: &[StyleSpan]) -> Result<ShapedRow> {
        let graphemes = self.resolve_graphemes(text, spans)?;
        let mut output = ShapedRow::default();
        let mut used_definitions = HashSet::new();
        let mut run_start = 0;
        while run_start < graphemes.len() {
            let face = graphemes[run_start].face;
            let mut run_end = run_start + 1;
            let style = graphemes[run_start].style;
            while run_end < graphemes.len() && graphemes[run_end].face == face && graphemes[run_end].style == style {
                run_end += 1;
            }
            self.shape_run(
                text,
                &graphemes[run_start..run_end],
                face,
                style,
                &mut output.glyphs,
                &mut used_definitions,
            )?;
            run_start = run_end;
        }
        let mut ids: Vec<_> = used_definitions.into_iter().collect();
        ids.sort_unstable();
        output.definitions = ids
            .into_iter()
            .filter_map(|id| self.glyphs.get(&id).cloned())
            .collect();
        Ok(output)
    }

    fn resolve_graphemes<'a>(&mut self, text: &'a str, spans: &[StyleSpan]) -> Result<Vec<Grapheme<'a>>> {
        let mut cell = 0_u16;
        let mut output = Vec::new();
        for (byte_start, cluster) in text.grapheme_indices(true) {
            let style = spans
                .iter()
                .find(|span| byte_start >= span.byte_start && byte_start < span.byte_end)
                .map(|span| span.style)
                .unwrap_or_default();
            let primary = *self.styled_faces.get(&style).context("missing styled primary face")?;
            let span = UnicodeWidthStr::width(cluster).max(1).min(2) as u16;
            let face = if self.face_supports(primary, cluster)? {
                primary
            } else {
                self.fallback_for(cluster).unwrap_or(primary)
            };
            output.push(Grapheme { text: cluster, byte_start, cell_start: cell, cell_span: span, face, style });
            cell = cell.saturating_add(span);
        }
        Ok(output)
    }

    fn fallback_for(&mut self, cluster: &str) -> Option<ID> {
        let representative = cluster.chars().find(|character| !character.is_control())?;
        if let Some(face) = self.fallback_faces.get(&representative) {
            if self.face_supports(*face, cluster).unwrap_or(false) {
                return Some(*face);
            }
        }
        let prefer_emoji = cluster.chars().any(is_emoji);
        let mut ids: Vec<ID> = self.database.faces().map(|face| face.id).collect();
        if prefer_emoji {
            ids.sort_by_key(|id| {
                let face = self.database.face(*id);
                let emoji_named = face.is_some_and(|face| {
                    face.post_script_name.contains("Emoji") || face.families.iter().any(|family| family.0.contains("Emoji"))
                });
                !emoji_named
            });
        }
        let found = ids.into_iter().find(|id| self.face_supports(*id, cluster).unwrap_or(false));
        if let Some(face) = found {
            self.fallback_faces.insert(representative, face);
        }
        found
    }

    fn face_supports(&self, face: ID, cluster: &str) -> Result<bool> {
        self.database
            .with_face_data(face, |data, index| {
                FontRef::from_index(data, index as usize).is_some_and(|font| {
                    cluster.chars().filter(|character| !is_ignorable(*character)).all(|character| font.charmap().map(character) != 0)
                })
            })
            .context("failed to access system font data")
    }

    #[allow(clippy::too_many_arguments)]
    fn shape_run(
        &mut self,
        full_text: &str,
        graphemes: &[Grapheme<'_>],
        face_id: ID,
        style: FontStyle,
        output: &mut Vec<GlyphInstance>,
        used_definitions: &mut HashSet<u32>,
    ) -> Result<()> {
        let first = graphemes.first().context("empty shaping run")?;
        let last = graphemes.last().context("empty shaping run")?;
        let byte_end = last.byte_start + last.text.len();
        let run_text = &full_text[first.byte_start..byte_end];
        let loaded = self.load_face(face_id)?;
        let face = Face::from_bytes(loaded.data.as_ref().as_ref(), loaded.index);
        let mut font = Font::new(face);
        font.set_scale((FONT_SIZE_PX * 64.0).round() as i32, (FONT_SIZE_PX * 64.0).round() as i32);
        font.set_ppem(FONT_SIZE_PX.round() as u32, FONT_SIZE_PX.round() as u32);
        let buffer = UnicodeBuffer::new().add_str(run_text).guess_segment_properties();
        let shaped = shape(&font, buffer, &[]);
        let infos = shaped.get_glyph_infos();
        let positions = shaped.get_glyph_positions();
        let natural_width = positions.iter().map(|position| position.x_advance).sum::<i32>() as f32 / 64.0;
        let target_cells = graphemes.iter().map(|grapheme| grapheme.cell_span as u32).sum::<u32>() as f32;
        let target_width = target_cells * CELL_WIDTH_PX;
        let run_scale_x = if natural_width.abs() > f32::EPSILON { target_width / natural_width } else { 1.0 };
        let mut pen_x = first.cell_start as f32 * CELL_WIDTH_PX;

        let mut cluster_starts: Vec<u32> = infos.iter().map(|info| info.cluster).collect();
        cluster_starts.sort_unstable();
        cluster_starts.dedup();
        for (info, position) in infos.iter().zip(positions) {
            let cluster = info.cluster as usize;
            let grapheme_index = graphemes
                .iter()
                .rposition(|grapheme| grapheme.byte_start - first.byte_start <= cluster)
                .unwrap_or(0);
            let cluster_cell_start = graphemes[grapheme_index].cell_start;
            let next_cluster = cluster_starts.iter().copied().find(|candidate| *candidate > info.cluster).map(|value| value as usize);
            let cluster_end_cell = next_cluster
                .and_then(|byte| graphemes.iter().find(|grapheme| grapheme.byte_start - first.byte_start >= byte))
                .map(|grapheme| grapheme.cell_start)
                .unwrap_or_else(|| last.cell_start.saturating_add(last.cell_span));
            let cluster_span = cluster_end_cell.saturating_sub(cluster_cell_start).max(1);
            if let Some((glyph_id, definition)) = self.rasterize(&loaded, info.codepoint, style)? {
                let x = pen_x + position.x_offset as f32 / 64.0 * run_scale_x + definition.bearing_x as f32 / RASTER_SCALE * run_scale_x;
                let y = BASELINE_PX - position.y_offset as f32 / 64.0 - definition.bearing_y as f32 / RASTER_SCALE;
                output.push(GlyphInstance {
                    glyph_id,
                    style_id: style_id(style),
                    x,
                    y,
                    width: definition.width as f32 / RASTER_SCALE * run_scale_x,
                    height: definition.height as f32 / RASTER_SCALE,
                    cell_start: cluster_cell_start,
                    cell_span: cluster_span,
                });
                used_definitions.insert(glyph_id);
            }
            pen_x += position.x_advance as f32 / 64.0 * run_scale_x;
        }
        Ok(())
    }

    fn load_face(&mut self, id: ID) -> Result<Arc<LoadedFace>> {
        if !self.loaded_faces.contains_key(&id) {
            // System font files are treated as immutable for the terminald lifetime.
            let (data, index) = unsafe { self.database.make_shared_face_data(id) }
                .context("failed to memory-map system font")?;
            let face = LoadedFace { id: self.next_face_id, index, data };
            self.next_face_id = self.next_face_id.checked_add(1).context("font ID overflow")?;
            self.loaded_faces.insert(id, face);
        }
        let face = self.loaded_faces.get(&id).context("loaded font disappeared")?;
        Ok(Arc::new(LoadedFace { id: face.id, index: face.index, data: Arc::clone(&face.data) }))
    }

    fn rasterize(&mut self, face: &LoadedFace, glyph_index: u32, style: FontStyle) -> Result<Option<(u32, GlyphDefinition)>> {
        let flags = u16::from(style.bold) | (u16::from(style.italic) << 1);
        let key = GlyphKey {
            face_id: face.id,
            glyph_index,
            pixel_size_26_6: (FONT_SIZE_PX * RASTER_SCALE * 64.0).round() as u32,
            render_flags: flags,
        };
        if let Some(id) = self.glyph_ids.get(&key).copied() {
            return Ok(self.glyphs.get(&id).cloned().map(|definition| (id, definition)));
        }
        if self.glyph_ids.len() >= MAX_CACHED_GLYPHS {
            self.glyph_ids.clear();
            self.glyphs.clear();
        }
        if glyph_index > u16::MAX as u32 {
            bail!("glyph index exceeds OpenType range");
        }
        let font = FontRef::from_index(face.data.as_ref().as_ref(), face.index as usize).context("invalid raster font")?;
        let mut scaler = self.scale_context.builder(font).size(FONT_SIZE_PX * RASTER_SCALE).hint(true).build();
        let image = Render::new(&[
            Source::ColorOutline(0),
            Source::ColorBitmap(StrikeWith::BestFit),
            Source::Outline,
        ])
        .format(Format::Alpha)
        .render(&mut scaler, glyph_index as u16);
        let Some(image) = image else { return Ok(None) };
        if image.placement.width == 0 || image.placement.height == 0 { return Ok(None); }
        let format = match image.content {
            Content::Mask => GlyphFormat::Alpha8,
            Content::SubpixelMask | Content::Color => GlyphFormat::Rgba8Premultiplied,
        };
        let id = self.next_glyph_id;
        self.next_glyph_id = self.next_glyph_id.checked_add(1).context("glyph ID overflow")?;
        let definition = GlyphDefinition {
            id,
            width: image.placement.width.try_into().context("glyph is too wide")?,
            height: image.placement.height.try_into().context("glyph is too tall")?,
            bearing_x: image.placement.left.try_into().context("glyph X bearing overflow")?,
            bearing_y: image.placement.top.try_into().context("glyph Y bearing overflow")?,
            format,
            pixels: image.data.into(),
        };
        self.glyph_ids.insert(key, id);
        self.glyphs.insert(id, definition.clone());
        Ok(Some((id, definition)))
    }
}

fn is_ignorable(character: char) -> bool {
    character == '\u{200d}' || character == '\u{fe0f}' || character.is_control()
}

fn is_emoji(character: char) -> bool {
    matches!(character as u32, 0x1f000..=0x1faff | 0x2600..=0x27bf)
}

fn style_id(style: FontStyle) -> u32 {
    u32::from(style.bold) | (u32::from(style.italic) << 1)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shapes_ligatures_combining_marks_and_wide_text_without_cell_drift() {
        let mut engine = TextEngine::discover().unwrap();
        let row = engine.shape_row("ffi e\u{301} 界", FontStyle::default()).unwrap();
        assert!(!row.glyphs.is_empty());
        assert!(row.glyphs.iter().all(|glyph| glyph.x.is_finite() && glyph.y.is_finite()));
        assert!(row.glyphs.iter().any(|glyph| glyph.cell_span >= 2));
        assert!(row.definitions.iter().all(|glyph| !glyph.pixels.is_empty()));
    }

    #[test]
    fn resolves_bold_and_italic_profiles() {
        let mut engine = TextEngine::discover().unwrap();
        for style in [
            FontStyle { bold: true, italic: false },
            FontStyle { bold: false, italic: true },
            FontStyle { bold: true, italic: true },
        ] {
            let row = engine.shape_row("agent => ready", style).unwrap();
            assert!(!row.glyphs.is_empty());
            assert!(row.glyphs.iter().all(|glyph| glyph.style_id == style_id(style)));
        }
    }

    #[test]
    fn applies_style_spans_without_breaking_cell_positions() {
        let mut engine = TextEngine::discover().unwrap();
        let row = engine.shape_styled_row("normal bold italic", &[
            StyleSpan { byte_start: 0, byte_end: 7, style: FontStyle::default() },
            StyleSpan { byte_start: 7, byte_end: 12, style: FontStyle { bold: true, italic: false } },
            StyleSpan { byte_start: 12, byte_end: 19, style: FontStyle { bold: false, italic: true } },
        ]).unwrap();
        assert!(row.glyphs.iter().any(|glyph| glyph.style_id == 1));
        assert!(row.glyphs.iter().any(|glyph| glyph.style_id == 2));
        assert!(row.glyphs.windows(2).all(|pair| pair[0].x <= pair[1].x + CELL_WIDTH_PX));
    }
}
