use std::{env, fs, path::Path};

use anyhow::{Context, Result};
use ghosttea_text::{
    FontPresentation, FontResource, FontResources, RASTER_SCALE, TextEngine, TextMetrics,
    phase2_fixture_cases,
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
    fonts.fallbacks = vec![
        resource("NotoColorEmoji.ttf")?.with_presentation(FontPresentation::Emoji),
        resource("STIXTwoMath-Regular.otf")?.with_presentation(FontPresentation::Text),
        resource("NotoSansSymbols2-Regular.ttf")?.with_presentation(FontPresentation::Text),
        resource("NotoEmoji-Regular.ttf")?.with_presentation(FontPresentation::Text),
    ];
    let mut engine = TextEngine::from_fonts(fonts, TextMetrics::default(), RASTER_SCALE)?;
    let fixture = engine.shaping_fixture(&phase2_fixture_cases())?;
    println!("{}", serde_json::to_string_pretty(&fixture)?);
    Ok(())
}
