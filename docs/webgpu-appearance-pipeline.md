# WebGPU appearance pipeline

Each terminal pane owns three persistent render textures: one terminal scene
and two shader ping-pong targets. All panes share a WebGPU device, pipelines,
and glyph atlases through the render worker.

## Pass composition

1. The terminal scene pass updates the persistent scene texture. Full damage
   clears it to the theme background; row damage first overwrites affected
   rows with the premultiplied background, then blends cell backgrounds,
   selection, glyphs, decorations, and cursor geometry.
2. The ordered shader stack samples the scene. Intermediate effects alternate
   between ping-pong A and B; the final effect writes to the canvas texture.
3. An empty effect stack still performs one full-screen blit, so scene
   persistence and canvas acquisition use the same path.

Each effect pass has an independent 48-byte uniform containing its registry
mode, frame number, stack position, physical resolution, time/delta, and
cursor state. Separate uniform buffers are required because multiple writes to
one buffer before a queue submission would otherwise make every encoded pass
observe the final effect's values.

Animation marks only focused, visible surfaces dirty. With no terminal damage,
the scene pass loads its persistent texture and the renderer reruns only the
full-screen effects. Hidden tabs and unfocused panes stop requesting frames.

## Alpha semantics

The scene, ping-pong textures, canvas context, and shader outputs all use
premultiplied alpha. `background-opacity` controls the default terminal
background. `background-opacity-cells` also applies that alpha to explicit
cell backgrounds.

Incremental row reset uses a no-blend overwrite pipeline. Normal source-over
blending cannot reduce destination alpha, so using the standard rectangle
pipeline would retain stale opaque pixels after transparency is enabled.
macOS BrowserWindows are created alpha-capable and the DOM beneath each canvas
is transparent. Native framed Windows/Linux windows remain OS-opaque even
though renderer alpha remains correct.

A solid block cursor is inserted after selection backgrounds and before glyphs;
the covered glyph uses `cursor-text`. Bar, underline, and hollow cursors remain
late overlay geometry.

## Catalogs and persistence

The linked `ghostty.style` gallery seeds its built-in collection from every
Ghostty file in `mbadolato/iTerm2-Color-Schemes`. Ghosttea packages that source
directly as a deterministic offline picker rather than depending on the
gallery's mutable community database at runtime. The generated catalog pins
all 602 files at revision
`875a82f0fdc773ae45099ce683a11c56bb0f8b3d`. A selected theme expands to fixed
colors plus ANSI palette entries 0–15. The daemon applies sparse palette
overrides on top of libghostty's default 256-color palette.

The desktop bridge validates settings, generates a marked Ghostty-syntax
appearance block, validates the full layered candidate through the daemon, and
replaces the profile overlay with compare-and-swap. Text outside the managed
block is preserved.

The shader picker accounts for all 36 files at reviewed
`0xhckr/ghostty-shaders` revision
`85898f08fcf4a9274e418912098e99e00a5f8350`. New bundled ports are limited to
files with explicit redistributable terms. The other names remain visible but
disabled pending clearance; arbitrary GLSL paths are never executed as WGSL.
