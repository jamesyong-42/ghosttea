use std::{env, fs, path::Path};

use anyhow::{Context, Result};
use ghosttea_text::{
    FontResource, FontResources, RASTER_SCALE, ShapingFixtureCase, TextEngine, TextMetrics,
};

fn main() -> Result<()> {
    let directory = env::args()
        .nth(1)
        .context("usage: shaping_fixture <font-directory>")?;
    let directory = Path::new(&directory);
    let resource = |name: &str| -> Result<FontResource> {
        Ok(FontResource::new(
            name,
            fs::read(directory.join(name)).with_context(|| format!("read font {name}"))?,
        ))
    };
    let mut fonts = FontResources::new(resource("JetBrainsMonoNerdFont-Regular.ttf")?);
    fonts.bold = Some(resource("JetBrainsMonoNerdFont-Bold.ttf")?);
    fonts.italic = Some(resource("JetBrainsMonoNerdFont-Italic.ttf")?);
    fonts.bold_italic = Some(resource("JetBrainsMonoNerdFont-BoldItalic.ttf")?);
    fonts.fallbacks = vec![resource("NotoColorEmoji.ttf")?];
    let mut engine = TextEngine::from_fonts(fonts, TextMetrics::default(), RASTER_SCALE)?;
    let fixture = engine.shaping_fixture(&[
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
    ])?;
    println!("{}", serde_json::to_string_pretty(&fixture)?);
    Ok(())
}
