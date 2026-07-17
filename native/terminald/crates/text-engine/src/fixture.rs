use std::collections::{BTreeMap, BTreeSet};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::{FontMode, FontStyle, GlyphFormat, ShapedRow, TextEngine, TextMetrics};

const POSITION_SCALE: f32 = 1024.0;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ShapingFixtureCase {
    pub name: String,
    pub text: String,
    pub bold: bool,
    pub italic: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ShapingFixture {
    pub schema_version: u32,
    pub font_mode: String,
    pub primary_family: String,
    pub metrics: TextMetrics,
    pub raster_scale: f32,
    pub faces: Vec<NormalizedFontFace>,
    pub cases: BTreeMap<String, NormalizedShapedRowDigest>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NormalizedFontFace {
    pub role: String,
    pub family: String,
    pub face_index: u32,
    pub sha256: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NormalizedShapedRow {
    pub glyphs: Vec<NormalizedGlyphInstance>,
    pub definitions: Vec<NormalizedGlyphDefinition>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NormalizedShapedRowDigest {
    pub glyph_count: usize,
    pub definition_count: usize,
    pub sha256: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NormalizedGlyphInstance {
    pub glyph_id: u32,
    pub style_id: u32,
    pub x_1024: i32,
    pub y_1024: i32,
    pub width_1024: i32,
    pub height_1024: i32,
    pub cell_start: u16,
    pub cell_span: u16,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NormalizedGlyphDefinition {
    pub id: u32,
    pub width: u16,
    pub height: u16,
    pub bearing_x: i16,
    pub bearing_y: i16,
    pub format: String,
    pub pixel_sha256: String,
}

pub fn phase2_fixture_cases() -> Vec<ShapingFixtureCase> {
    vec![
        ShapingFixtureCase {
            name: "ascii-ligatures".into(),
            text: "Ghosttea => ffi != 0123456789".into(),
            bold: false,
            italic: false,
        },
        ShapingFixtureCase {
            name: "bold".into(),
            text: "bold terminal".into(),
            bold: true,
            italic: false,
        },
        ShapingFixtureCase {
            name: "italic".into(),
            text: "italic terminal".into(),
            bold: false,
            italic: true,
        },
        ShapingFixtureCase {
            name: "bold-italic".into(),
            text: "bold italic".into(),
            bold: true,
            italic: true,
        },
        ShapingFixtureCase {
            name: "combining-wide-missing".into(),
            text: "e\u{301} 界".into(),
            bold: false,
            italic: false,
        },
        ShapingFixtureCase {
            name: "emoji-fallback".into(),
            text: "terminal 😀".into(),
            bold: false,
            italic: false,
        },
    ]
}

impl TextEngine {
    pub fn shaping_fixture(&mut self, cases: &[ShapingFixtureCase]) -> Result<ShapingFixture> {
        let mut normalized_cases = BTreeMap::new();
        for case in cases {
            let shaped = self.shape_row(
                &case.text,
                FontStyle {
                    bold: case.bold,
                    italic: case.italic,
                },
            )?;
            let normalized = normalize_row(shaped)?;
            normalized_cases.insert(
                case.name.clone(),
                NormalizedShapedRowDigest {
                    glyph_count: normalized.glyphs.len(),
                    definition_count: normalized.definitions.len(),
                    sha256: digest(&serde_json::to_vec(&normalized)?),
                },
            );
        }

        Ok(ShapingFixture {
            schema_version: 1,
            font_mode: match self.mode {
                FontMode::Bundled => "bundled",
                FontMode::System => "system-non-parity",
            }
            .into(),
            primary_family: self.primary_family.clone(),
            metrics: self.metrics,
            raster_scale: self.raster_scale,
            faces: self.normalized_faces()?,
            cases: normalized_cases,
        })
    }

    fn normalized_faces(&self) -> Result<Vec<NormalizedFontFace>> {
        let mut roles = Vec::new();
        let styles = [
            ("regular", FontStyle::default()),
            (
                "bold",
                FontStyle {
                    bold: true,
                    italic: false,
                },
            ),
            (
                "italic",
                FontStyle {
                    bold: false,
                    italic: true,
                },
            ),
            (
                "bold-italic",
                FontStyle {
                    bold: true,
                    italic: true,
                },
            ),
        ];
        for (role, style) in styles {
            let id = *self
                .styled_faces
                .get(&style)
                .context("fixture style face is missing")?;
            roles.push((role.to_owned(), id));
        }
        if let Some(fallbacks) = &self.fallback_order {
            roles.extend(
                fallbacks
                    .iter()
                    .enumerate()
                    .map(|(index, id)| (format!("fallback-{index}"), *id)),
            );
        }

        let mut seen = BTreeSet::new();
        let mut output = Vec::new();
        for (role, id) in roles {
            if !seen.insert(id) {
                continue;
            }
            let face = self
                .database
                .face(id)
                .context("fixture font face vanished")?;
            let sha256 = self
                .database
                .with_face_data(id, |bytes, _| digest(bytes))
                .context("fixture font bytes are unavailable")?;
            output.push(NormalizedFontFace {
                role,
                family: face
                    .families
                    .first()
                    .map(|family| family.0.clone())
                    .unwrap_or_else(|| face.post_script_name.clone()),
                face_index: face.index,
                sha256,
            });
        }
        Ok(output)
    }
}

fn normalize_row(shaped: ShapedRow) -> Result<NormalizedShapedRow> {
    let glyphs = shaped
        .glyphs
        .into_iter()
        .map(|glyph| {
            Ok(NormalizedGlyphInstance {
                glyph_id: glyph.glyph_id,
                style_id: glyph.style_id,
                x_1024: quantize(glyph.x)?,
                y_1024: quantize(glyph.y)?,
                width_1024: quantize(glyph.width)?,
                height_1024: quantize(glyph.height)?,
                cell_start: glyph.cell_start,
                cell_span: glyph.cell_span,
            })
        })
        .collect::<Result<Vec<_>>>()?;
    let mut definitions = shaped
        .definitions
        .into_iter()
        .map(|definition| NormalizedGlyphDefinition {
            id: definition.id,
            width: definition.width,
            height: definition.height,
            bearing_x: definition.bearing_x,
            bearing_y: definition.bearing_y,
            format: match definition.format {
                GlyphFormat::Alpha8 => "alpha8",
                GlyphFormat::Rgba8Premultiplied => "rgba8-premultiplied",
            }
            .into(),
            pixel_sha256: digest(&definition.pixels),
        })
        .collect::<Vec<_>>();
    definitions.sort_by_key(|definition| definition.id);
    Ok(NormalizedShapedRow {
        glyphs,
        definitions,
    })
}

fn quantize(value: f32) -> Result<i32> {
    if !value.is_finite() {
        anyhow::bail!("fixture glyph geometry is not finite");
    }
    let scaled = (value * POSITION_SCALE).round();
    i32::try_from(scaled as i64).context("fixture glyph geometry overflow")
}

fn digest(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}
