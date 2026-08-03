# ghosttea-text

Native font loading, shaping, fallback, and glyph rasterization for Ghosttea.

Parity mode uses `TextEngine::from_fonts` with owned font bytes, explicit
`TextMetrics`, and an explicit raster scale. The configured fallback list is
ordered and closed: if none of those fonts covers a cluster, the primary font's
missing glyph is rendered. This makes shaping and bitmap results reproducible
across hosts.

`TextEngine::discover` remains available for desktop convenience. It scans
system fonts and must be treated as `FontMode::System`, which is intentionally
non-parity because installed fonts and fallback choices differ between devices.

The Phase 2 parity bundle is locked in `native/fonts.lock.json`: JetBrains Mono
Nerd Font regular/bold/italic/bold-italic, Noto Color Emoji, STIX Two Math,
Noto Sans Symbols 2, and Noto Emoji. Missing text glyphs resolve by ordered
font coverage through the symbol faces before the monochrome emoji face; Unicode
presentation rules select the colored emoji face. All fonts ship under OFL-1.1
with pinned source and notice metadata. Run:

```sh
npm run sync:fonts
npm run check:font-parity
npm run build:apple-native
npm run test:font-parity:apple-runtime
```

The first command verifies hashes and stages generated assets under
`native/build/ghosttea-fonts`. The second compares normalized shaping geometry
and glyph bitmap hashes with the checked-in Phase 2 golden.
The Apple build creates macOS, arm64 iOS simulator, and arm64 iOS device slices.
The runtime test executes the same Rust engine through Swift package resources
and a narrow C ABI instead of treating cross-compilation as parity evidence.
