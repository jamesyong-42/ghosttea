# Ghostty-Class Terminal Runtime for Electron

**Implementation-ready architecture design**  
**Status:** Proposed  
**Date:** July 14, 2026

---

## 1. Executive decision

Build the terminal system as five cooperating layers:

```text
┌─────────────────────────────────────────────────────────────┐
│ Electron renderer                                           │
│                                                             │
│ React UI + DOM layout                                       │
│ ├── infinite canvas                                         │
│ ├── agent monitor                                           │
│ ├── tabs, panels, overlays                                  │
│ └── <canvas> terminal surfaces                              │
│           │                                                 │
│           ▼                                                 │
│ Terminal Render Worker                                      │
│ ├── one WebGPU device per Electron window                   │
│ ├── multiple terminal canvas contexts                       │
│ ├── glyph atlases                                           │
│ └── GPU display-list rendering                              │
└───────────────────────┬─────────────────────────────────────┘
                        │ Electron MessagePorts
┌───────────────────────▼─────────────────────────────────────┐
│ terminal-bridge utility process                             │
│ ├── control-channel client                                  │
│ ├── frame-channel client                                    │
│ └── binary packet forwarding                                │
└───────────────────────┬─────────────────────────────────────┘
                        │ UDS / named pipes
┌───────────────────────▼─────────────────────────────────────┐
│ ghosttead native sidecar                                    │
│ ├── persistent session manager                              │
│ ├── direct Unix PTY / Windows ConPTY                        │
│ ├── libghostty-vt terminal state                            │
│ ├── native font shaping and glyph rasterization             │
│ ├── render-damage and display-list generation               │
│ ├── scrollback, selection, search and recording             │
│ └── agent-specific structured channels                      │
└───────────────────────┬─────────────────────────────────────┘
                        │
                        ▼
             shell / SSH / Claude / Codex / TUIs
```

### The core architectural rule

```text
PTY bytes never enter the Electron renderer hot path.
```

The renderer receives:

- absolute replacements for damaged terminal rows;
- shaped glyph placements;
- style definitions;
- glyph bitmap additions;
- cursor and selection state;
- terminal-local images;
- semantic terminal events.

It does **not** receive a continuous raw VT byte stream for parsing.

### Final rendering choice

Use:

```text
libghostty-vt terminal state
        +
native text shaping/rasterization
        +
custom WebGPU renderer
```

Do not use:

```text
libghostty native child view
```

and do not transfer:

```text
native RGBA framebuffer → Electron
```

This choice is necessary because the terminal surface must behave like a real DOM element:

- CSS clipping and rounded corners;
- CSS transforms;
- infinite-canvas pan and zoom;
- DOM overlays;
- opacity and animations;
- standard browser hit testing;
- React-controlled layout.

`libghostty-vt` exposes terminal state and incremental render information for custom renderers, but its API is currently marked unstable. Ghostling demonstrates the intended custom-renderer boundary and explicitly notes that shaping and layout remain the consumer’s responsibility. citeturn839826search2turn839826search5

---

# 2. Product requirements

## 2.1 Functional goals

The system must support:

1. Full interactive shells and original agent TUIs.
2. Unix PTYs and Windows ConPTY.
3. Tabs, split panes and multiple Electron windows.
4. Persistent sessions across renderer reloads.
5. Optional persistence after the Electron UI exits.
6. Hundreds of headless agent sessions.
7. Several simultaneously visible interactive terminals.
8. Infinite-canvas terminal cards.
9. Agent-monitor thumbnails.
10. Search, selection, copy and hyperlinks.
11. Unicode, combining marks, wide characters and ligatures.
12. Kitty keyboard and mouse protocols.
13. Alternate-screen applications.
14. Kitty graphics, with a later path for Sixel.
15. IME input.
16. Clipboard and OSC safety policies.
17. Structured agent events separate from visual terminal output.
18. Renderer device-loss recovery.
19. Reconnection after Electron renderer or bridge crashes.

## 2.2 Performance goals

Target budgets:

| Operation | Target |
|---|---:|
| DOM keyboard event → PTY write, p50 | under 2 ms |
| DOM keyboard event → PTY write, p99 | under 8 ms |
| PTY output read → WebGPU submission, p50 | under 8 ms |
| PTY output read → WebGPU submission, p99 | under 16 ms |
| Ctrl+C response during output flood, p99 | under 20 ms |
| Active terminal refresh | up to display refresh rate |
| Visible background terminal refresh | 30–60 Hz |
| Monitor thumbnail refresh | 2–5 Hz |
| Renderer UI-thread terminal parsing | zero |
| Renderer UI-thread glyph rasterization | zero |
| Intermediate frames allowed to drop | yes |
| Terminal state or PTY bytes allowed to drop | no |

## 2.3 Non-goals

The initial implementation will not promise:

- pixel-for-pixel identity with Ghostty’s own Metal or OpenGL renderer;
- persistence of a live shell across an operating-system restart;
- arbitrary third-party web content inside the terminal renderer origin;
- direct native GPU texture import into browser WebGPU;
- support for every terminal image protocol in the first milestone.

Ghostty currently expects custom-renderer consumers to produce their own pixels rather than relying on a canonical Ghostty RGBA output. citeturn839826search0

---

# 3. Architecture decisions

## ADR-001: Terminal state belongs in the sidecar

The authoritative terminal emulator lives in `ghosttead`.

Reasons:

- sessions survive renderer reloads;
- no VT parsing on the browser thread;
- headless agents retain full terminal state;
- output floods cannot freeze React;
- multiple views can attach to one session;
- inactive sessions require no browser resources;
- renderer backpressure does not corrupt terminal state.

`libghostty-vt` owns:

- VT parsing;
- cursor state;
- terminal modes;
- screen and alternate screen;
- scrollback;
- reflow;
- style and color state;
- input encoding;
- render damage.

## ADR-002: WebGPU owns final pixels

The terminal is rendered into a `<canvas>` controlled by WebGPU.

WebGPU maps to modern native GPU APIs and is suitable for GPU-buffer and texture-driven rendering. WebGPU canvas contexts can be used with `OffscreenCanvas` in workers, allowing rendering work to stay off the UI thread. citeturn373663search1turn373663search2

This makes the canvas a normal DOM element:

```tsx
<div className="terminal-card">
  <canvas ref={canvasRef} />
  <AgentOverlay />
</div>
```

The terminal can therefore use:

```css
.terminal-card {
  border-radius: 14px;
  overflow: hidden;
  transform: translate3d(var(--x), var(--y), 0) scale(var(--zoom));
  opacity: var(--opacity);
}
```

## ADR-003: Native code shapes and rasterizes text

`libghostty-vt` identifies terminal graphemes and styles, but it does not perform complete font shaping or layout for the custom renderer. citeturn839826search2

A native text engine in `ghosttead` will perform:

- system font discovery;
- font fallback;
- HarfBuzz shaping;
- FreeType or platform rasterization;
- ligature placement;
- combining-mark placement;
- bold and italic face resolution;
- grayscale glyph generation;
- color-glyph generation;
- glyph metrics and caching.

The renderer receives shaped glyph instances rather than font files or unshaped strings.

Advantages:

- browser code does not need access to system font files;
- glyph layout is consistent across views;
- shaping is isolated from the React process;
- the WebGPU worker performs only atlas management and drawing;
- font work can be cached across terminal sessions.

## ADR-004: One WebGPU worker per Electron window

Do not create one worker or GPU device per terminal.

Each Electron window gets:

```text
one RenderWorker
one GPUAdapter
one GPUDevice
one monochrome glyph atlas set
one color glyph atlas set
many terminal surfaces
```

The worker can configure multiple transferred `OffscreenCanvas` objects against the same device.

## ADR-005: Use a utility-process bridge

Electron main should not forward terminal frames.

Electron provides utility processes and transferable MessagePorts suitable for direct process-to-renderer channels. citeturn387041search1turn387041search4turn387041search10

The main process only:

- locates or starts `ghosttead`;
- starts `terminal-bridge`;
- creates MessagePorts;
- transfers ports to the utility process and renderer;
- handles lifecycle and updates.

After bootstrap:

```text
ghosttead ↔ terminal-bridge ↔ RenderWorker
```

does not route each frame through Electron main.

## ADR-006: Two independent transport planes

Use separate transport paths for:

### Control plane

High-priority, low-volume:

- input;
- resize;
- session creation;
- kill and interrupt;
- focus;
- selection;
- clipboard;
- view subscription;
- acknowledgements.

### Frame plane

Lower-priority, higher-volume:

- terminal row display lists;
- glyph bitmap definitions;
- image data;
- full snapshots;
- thumbnails.

This prevents a large frame packet from delaying Ctrl+C or a resize command.

## ADR-007: Do not begin with shared memory

The first production implementation uses binary packets and transferable `ArrayBuffer`s.

Shared memory is not needed unless profiling proves otherwise. Browser `SharedArrayBuffer` usage requires cross-origin isolation and introduces additional application and resource-loading constraints. citeturn387041search2turn387041search5

The frame protocol is intentionally designed so an OS shared-memory transport can be added later without changing the logical packet schema.

---

# 4. Process topology

## 4.1 Electron main process

Responsibilities:

- application lifecycle;
- sidecar discovery and startup;
- sidecar version verification;
- utility-process startup;
- creation of control and frame MessagePorts;
- secure preload registration;
- app-level shortcuts;
- crash detection;
- update coordination.

It must not:

- parse VT output;
- store scrollback;
- allocate glyph atlases;
- forward every terminal frame;
- own PTY file descriptors.

## 4.2 Electron renderer UI thread

Responsibilities:

- React layout;
- canvas element creation;
- focus and input collection;
- DOM overlays;
- infinite-canvas transformations;
- terminal card virtualization;
- accessibility mirror;
- command palette and application UI.

It must not:

- parse escape sequences;
- shape text;
- rasterize glyphs;
- decode large terminal frame packets into JS objects;
- redraw terminal cells with React.

## 4.3 Terminal Render Worker

Responsibilities:

- WebGPU device ownership;
- canvas-context configuration;
- binary frame decoding;
- GPU-buffer updates;
- glyph atlas allocation;
- glyph texture uploads;
- terminal drawing;
- frame scheduling;
- device-loss recovery;
- thumbnail generation.

The worker receives its MessagePort directly:

```ts
const offscreen = canvas.transferControlToOffscreen();

renderWorker.postMessage(
  {
    type: "mount-view",
    viewId,
    canvas: offscreen,
  },
  [offscreen],
);
```

`OffscreenCanvas` is transferable and allows canvas work to occur in a worker rather than on the UI thread. citeturn373663search0

## 4.4 `terminal-bridge` utility process

Responsibilities:

- connect to `ghosttead`;
- authenticate;
- decode only transport envelope headers;
- transfer control messages;
- transfer frame buffers;
- reconnect after renderer replacement;
- enforce renderer-specific quotas.

It does not parse terminal frames into object graphs.

A frame should remain:

```text
Rust byte buffer
→ operating-system socket
→ Node Buffer
→ transferable ArrayBuffer
→ RenderWorker Uint8Array
```

The bridge should pool buffers to limit allocation churn.

## 4.5 `ghosttead` sidecar

Recommended implementation language: **Rust**.

Reasons:

- safe long-lived process management;
- strong cross-platform system APIs;
- efficient binary protocol implementation;
- good concurrency and cancellation;
- straightforward C ABI integration;
- separate distributable binary.

`libghostty-vt` is linked through its C API and wrapped behind one internal crate. No other crate may depend directly on Ghostty headers.

## 4.6 Shell and agent processes

Each session launches under:

### macOS and Linux

- `openpty` or `forkpty`;
- new process group/session;
- controlling terminal;
- nonblocking PTY master;
- explicit environment and working directory;
- signal delivery to the process group.

### Windows

- input and output pipes;
- `CreatePseudoConsole`;
- `STARTUPINFOEX`;
- process group;
- Job Object for process-tree ownership;
- asynchronous pipe reads and writes.

Microsoft’s ConPTY host model requires the host application to create communication pipes, create the pseudoconsole and spawn the attached process. citeturn420086search4turn420086search12

---

# 5. `ghosttead` internal design

```text
ghosttead
├── supervisor
├── connection manager
├── session registry
├── PTY backends
├── session actors
├── libghostty adapter
├── view subscription manager
├── text engine
├── glyph cache
├── display-list builder
├── frame scheduler
├── scrollback/search service
├── recorder
├── agent protocol adapters
└── metrics
```

## 5.1 Session actor

Every terminal session is a single-writer actor.

```rust
struct SessionActor {
    id: SessionId,
    epoch: u64,
    pty: Box<dyn PtyHandle>,
    terminal: GhosttyTerminal,
    process: ProcessTree,
    subscribers: HashMap<ViewId, ViewSubscription>,
    render_profiles: HashMap<RenderProfileId, RenderProfile>,
    recorder: Option<Recorder>,
    semantic_events: SemanticEventState,
}
```

Messages:

```rust
enum SessionCommand {
    PtyOutput(Bytes),
    Key(InputKey),
    Text(String),
    Paste(String),
    Mouse(InputMouse),
    Resize(TerminalSize),
    AttachView(AttachView),
    UpdateView(UpdateView),
    DetachView(ViewId),
    SetViewport(SetViewport),
    Select(SelectionCommand),
    Search(SearchCommand),
    Interrupt,
    Terminate,
    Shutdown,
}
```

All calls into one `GhosttyTerminal` happen inside this actor.

No external mutex protects terminal state.

## 5.2 Actor scheduling

Output floods must not starve control messages.

The actor uses a biased event loop:

```rust
loop {
    tokio::select! {
        biased;

        Some(command) = priority_rx.recv() => {
            handle_priority(command).await;
        }

        Some(command) = control_rx.recv() => {
            handle_control(command).await;
        }

        Some(output) = pty_output_rx.recv() => {
            process_output_with_budget(output).await;
        }
    }
}
```

PTY output processing is budgeted:

- process at most 256 KiB before checking control queues;
- yield after approximately 2 ms of parser work;
- never discard bytes;
- allow the PTY pipe to apply backpressure if the parser falls behind.

## 5.3 Ghostty adapter

Create a narrow wrapper:

```rust
trait TerminalCore {
    fn feed(&mut self, bytes: &[u8]) -> Result<TerminalDamage>;
    fn resize(&mut self, cols: u16, rows: u16) -> Result<TerminalDamage>;
    fn encode_key(&self, key: &InputKey, out: &mut Vec<u8>) -> Result<()>;
    fn encode_mouse(&self, event: &InputMouse, out: &mut Vec<u8>) -> Result<()>;
    fn render_rows(&self, range: RowRange) -> Result<Vec<LogicalRow>>;
    fn cursor(&self) -> CursorState;
    fn title(&self) -> Option<&str>;
    fn cwd(&self) -> Option<&str>;
    fn extract_selection(&self, selection: &Selection) -> Result<String>;
}
```

Implementation:

```text
crates/ghostty-adapter
└── the only code allowed to call libghostty-vt
```

Because the current C API is not yet stable, the project must:

1. Pin an exact Ghostty commit.
2. Check in generated bindings.
3. Wrap all Ghostty types.
4. Never expose Ghostty structs in IPC.
5. Maintain conformance tests around the wrapper.
6. Upgrade Ghostty only through an explicit dependency-update PR.

The upstream header currently warns that breaking API changes are expected. citeturn839826search5

## 5.4 Terminal damage

After parsing output, the actor receives or calculates:

```rust
struct TerminalDamage {
    full: bool,
    dirty_rows: SmallVec<[u16; 8]>,
    cursor_changed: bool,
    modes_changed: bool,
    scroll_changed: bool,
    title_changed: bool,
    cwd_changed: bool,
    images_changed: bool,
}
```

Damage is merged into each view subscription.

Frames contain **absolute current row state**, not mutation commands. This allows queued frames to be replaced safely.

---

# 6. Native text engine

## 6.1 Responsibilities

The text engine converts terminal rows into positioned glyph instances.

```text
logical terminal row
  ↓
font fallback resolution
  ↓
shaping runs
  ↓
glyph positioning
  ↓
glyph cache lookup
  ↓
display-list row
```

## 6.2 Render profile

Every attached view specifies a render profile:

```rust
struct RenderProfile {
    font_family: String,
    bold_family: Option<String>,
    italic_family: Option<String>,
    bold_italic_family: Option<String>,

    font_size_px: f32,
    line_height_px: f32,
    cell_width_px: f32,
    device_pixel_ratio: f32,

    font_features: Vec<FontFeature>,
    ligature_mode: LigatureMode,
    antialias_mode: AntialiasMode,
}
```

Profiles are hashed and shared across views.

A layout cache key is:

```text
row revision
+ render profile hash
+ terminal width
```

## 6.3 Shaping rules

For every dirty row:

1. Resolve graphemes to font faces.
2. Group adjacent cells by shaping-compatible face and attributes.
3. Shape with HarfBuzz.
4. Preserve terminal cluster-to-cell mapping.
5. Constrain the shaped run to the expected cell span.
6. Handle wide-cell and continuation cells.
7. Position combining marks relative to their base cluster.
8. Generate glyph instances in device pixels.
9. Produce decoration and background runs separately.

Colors do not split shaping runs unless required by a rendering rule. This allows ligatures across adjacent cells that differ only in foreground color, if the configured ligature policy permits it.

## 6.4 Glyph catalog

The native text engine assigns stable connection-scoped glyph IDs:

```rust
struct GlyphKey {
    face_id: u32,
    glyph_index: u32,
    pixel_size_26_6: u32,
    render_flags: u16,
    variation_hash: u64,
}
```

The sidecar stores:

```rust
struct GlyphDefinition {
    id: GlyphId,
    width: u16,
    height: u16,
    bearing_x: i16,
    bearing_y: i16,
    format: GlyphFormat,
    pixels: Bytes,
}
```

Formats:

```rust
enum GlyphFormat {
    Alpha8,
    Rgba8Premultiplied,
}
```

Glyph definitions are sent once per renderer connection and cached by the WebGPU worker.

## 6.5 Why atlas placement belongs in the renderer

The renderer, not the sidecar, chooses atlas placement because it knows:

- WebGPU texture limits;
- current device generation;
- available atlas layers;
- device-loss state;
- memory pressure;
- terminal-window lifetime.

The sidecar supplies glyph bitmaps and metrics. The render worker packs them into texture atlases.

---

# 7. Transport protocol

## 7.1 Local transport

Use:

| Platform | Control | Frames |
|---|---|---|
| macOS | Unix-domain socket | second Unix-domain socket |
| Linux | Unix-domain socket | second Unix-domain socket |
| Windows | named pipe | second named pipe |

The channels are authenticated independently using the same connection token.

## 7.2 Protocol negotiation

Handshake:

```protobuf
message ClientHello {
  uint32 protocol_major = 1;
  uint32 protocol_minor = 2;
  string client_build = 3;
  bytes auth_token = 4;
  RendererCapabilities renderer = 5;
}

message ServerHello {
  uint32 protocol_major = 1;
  uint32 protocol_minor = 2;
  string server_build = 3;
  string ghostty_commit = 4;
  repeated Feature features = 5;
}
```

A major-version mismatch fails immediately.

Minor versions negotiate feature flags.

## 7.3 Control protocol

Use Protocol Buffers for low-volume control messages.

Primary commands:

```protobuf
CreateSession
AttachSession
ListSessions
CloseSession
TerminateSession

AttachView
UpdateView
DetachView
SetViewport

SendKey
SendText
SendPaste
SendMouse
SetFocus

ResizeTerminal
SelectionCommand
SearchCommand

FrameAck
RequestFullSnapshot
RequestGlyphs
```

Primary events:

```protobuf
SessionCreated
SessionExited
SessionError

TitleChanged
CwdChanged
Bell
ModeChanged

ClipboardRequest
OpenUrlRequest
NotificationRequest

SearchResults
SelectionText
FrameAvailable
```

## 7.4 Binary frame protocol

Do not decode frames into thousands of JavaScript objects.

Each packet uses a packed little-endian representation.

### Header

```text
FrameHeader
├── magic: u32                 // "TRF1"
├── protocol_version: u16
├── flags: u16
├── session_handle: u64
├── view_handle: u64
├── session_epoch: u64
├── layout_epoch: u64
├── frame_sequence: u64
├── terminal_revision: u64
├── cols: u16
├── rows: u16
├── section_count: u16
└── reserved: u16
```

### Sections

```text
SectionHeader
├── kind: u16
├── flags: u16
├── byte_offset: u32
├── byte_length: u32
└── item_count: u32
```

Section kinds:

```text
1  GlyphDefinitions
2  StyleDefinitions
3  RowReplacements
4  CursorState
5  SelectionSpans
6  ImageDefinitions
7  ImagePlacements
8  ScrollbarState
9  ViewportMetadata
10 AccessibilityText
```

## 7.5 Row replacement format

Each dirty row is replaced atomically:

```rust
struct RowReplacement {
    viewport_row: u16,
    row_revision: u64,

    background_offset: u32,
    background_count: u16,

    glyph_offset: u32,
    glyph_count: u16,

    decoration_offset: u32,
    decoration_count: u16,
}
```

Glyph instance:

```rust
struct GlyphInstance {
    glyph_id: u32,
    style_id: u32,

    x: f32,
    y: f32,
    width: f32,
    height: f32,

    cell_start: u16,
    cell_span: u16,
}
```

Background or decoration instance:

```rust
struct RectInstance {
    style_id: u32,
    kind: u16,
    flags: u16,

    x: f32,
    y: f32,
    width: f32,
    height: f32,
}
```

## 7.6 Style format

Styles preserve semantic defaults so themes can change without rebuilding terminal state.

```rust
enum ColorSpec {
    DefaultForeground,
    DefaultBackground,
    Palette(u8),
    Rgb(u8, u8, u8),
}
```

```rust
struct StyleDefinition {
    id: u32,
    foreground: ColorSpec,
    background: ColorSpec,
    underline: ColorSpec,

    bold: bool,
    faint: bool,
    italic: bool,
    inverse: bool,
    invisible: bool,
    strikethrough: bool,
    underline_style: UnderlineStyle,
}
```

The WebGPU worker resolves semantic colors against the current theme.

## 7.7 Frame acknowledgements and dropping

PTY bytes are never dropped.

Intermediate display frames may be dropped.

Every view tracks:

```rust
struct ViewAckState {
    last_acked_sequence: u64,
    acked_row_revisions: Vec<u64>,
    pending_frames: VecDeque<SentFrame>,
}
```

Frame generation logic:

1. A row is dirty when its current revision is greater than its acknowledged revision.
2. A sent frame records the row revisions it contains.
3. On acknowledgement, those revisions become acknowledged.
4. If a row changed again after transmission, it remains dirty.
5. If more than two unacknowledged frames accumulate, intermediate frames are replaced.
6. If lag exceeds a threshold, send one fresh full viewport snapshot.

This provides latest-state behavior without losing correctness.

---

# 8. WebGPU renderer

## 8.1 Worker structure

```text
TerminalRenderWorker
├── DeviceManager
├── SurfaceRegistry
├── FrameDecoder
├── GlyphAtlas
├── StyleBuffer
├── TerminalViewState[]
├── PipelineCache
├── FrameScheduler
├── ThumbnailService
└── DeviceRecovery
```

## 8.2 GPU resources

Shared per window:

- monochrome glyph texture array;
- color glyph texture array;
- sampler objects;
- style storage buffer;
- shared shader modules;
- pipeline objects.

Per terminal view:

- glyph instance buffer;
- rectangle instance buffer;
- image instance buffer;
- cursor buffer;
- canvas context;
- viewport uniforms;
- CPU-side row cache.

## 8.3 Render passes

Recommended pass order:

```text
1. Clear
2. Default terminal background
3. Cell background runs
4. Selection backgrounds
5. Terminal images
6. Monochrome glyphs
7. Color glyphs and emoji
8. Underlines and strikethrough
9. Search highlights
10. Cursor
11. Diagnostic overlays
```

Use premultiplied alpha.

## 8.4 GPU updates

When a frame arrives:

```ts
function applyFrame(packet: ArrayBuffer): void {
  const frame = decodeFrame(packet);

  applyStyleDefinitions(frame.styles);
  applyGlyphDefinitions(frame.glyphs);

  for (const row of frame.rows) {
    view.replaceRow(row);
  }

  view.updateCursor(frame.cursor);
  view.updateSelection(frame.selection);
  scheduler.markDirty(view.id);
}
```

The row cache is an array of packed typed arrays, not JS cell objects.

At draw time, the first implementation may compact all row display lists into contiguous GPU buffers. A full 200×60 terminal remains small enough for this approach.

Later optimization:

- fixed per-row GPU regions;
- dirty-range `queue.writeBuffer`;
- indirect drawing;
- render bundles.

## 8.5 Atlas behavior

The atlas manager:

1. Receives a `GlyphDefinition`.
2. Allocates a rectangle in an atlas layer.
3. Uploads bitmap pixels.
4. Maps `glyph_id → atlas location`.
5. Resolves pending glyph instances.
6. Evicts least-recently-used glyphs only when necessary.

Recommended defaults:

```text
monochrome page: 2048×2048 R8
color page:      2048×2048 RGBA8
initial layers:  4
growth:          negotiated from adapter limits
```

## 8.6 Device loss

On WebGPU device loss:

1. Stop submitting frames.
2. Recreate adapter, device and pipelines.
3. Reconfigure all visible canvas contexts.
4. Recreate glyph atlases.
5. Request a full snapshot and visible glyph definitions.
6. Resume drawing.
7. Fall back to WebGL2 if recovery repeatedly fails.

The terminal sessions remain unaffected because the sidecar owns all authoritative state.

## 8.7 Renderer fallback

Expose a renderer interface:

```ts
interface TerminalRenderer {
  mount(view: MountedView): Promise<void>;
  applyFrame(frame: ArrayBuffer): void;
  resize(viewId: ViewId, size: PixelSize): void;
  unmount(viewId: ViewId): void;
  captureThumbnail(viewId: ViewId): Promise<ImageBitmap>;
}
```

Implementations:

```text
WebGpuTerminalRenderer      preferred
WebGlTerminalRenderer       fallback
CanvasTerminalRenderer      diagnostic fallback
```

---

# 9. DOM and infinite-canvas integration

## 9.1 React component

```tsx
export function TerminalSurface({
  sessionId,
  renderProfile,
}: TerminalSurfaceProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const handle = terminalRuntime.mount({
      sessionId,
      canvas,
      renderProfile,
    });

    return () => handle.dispose();
  }, [sessionId, renderProfile]);

  return (
    <div className="terminal-surface">
      <canvas ref={canvasRef} />
      <TerminalDomOverlay sessionId={sessionId} />
    </div>
  );
}
```

## 9.2 Resizing

A `ResizeObserver` reports CSS dimensions:

```ts
observer.observe(container);
```

The render worker receives:

```ts
{
  cssWidth,
  cssHeight,
  devicePixelRatio,
  effectiveZoom,
}
```

The worker computes physical resolution and cell geometry.

The terminal-size change is sent to `ghosttead` only when calculated `cols` or `rows` change.

Resize sequence:

1. DOM pane changes size.
2. Canvas display size follows immediately.
3. Worker renders the previous terminal state stretched or letterboxed.
4. Worker calculates new rows and columns.
5. Sidecar atomically resizes PTY and terminal state.
6. Sidecar increments `layout_epoch`.
7. Worker rejects frames from the old epoch.
8. Full viewport frame arrives.

## 9.3 Canvas zoom behavior

During live infinite-canvas zoom:

- let CSS transform the current canvas;
- do not rerasterize every pointer event;
- preserve interaction responsiveness.

After zoom settles for roughly 80–120 ms:

- recompute effective pixel scale;
- create or select an appropriate render profile;
- rerender glyphs at the new resolution.

This gives smooth zoom during interaction and crisp text after settling.

## 9.4 View virtualization

View states:

```text
HEADLESS
THUMBNAIL
VISIBLE
ACTIVE
```

Behavior:

| State | Sidecar subscription | Refresh | GPU surface |
|---|---|---:|---|
| Headless | semantic events only | none | none |
| Thumbnail | low-resolution viewport | 2–5 Hz | temporary |
| Visible | full viewport | 30–60 Hz | mounted |
| Active | full viewport + input | display rate | mounted |

When a terminal leaves the visible canvas region:

1. Worker produces an `ImageBitmap` thumbnail.
2. UI replaces the live canvas with the thumbnail.
3. View subscription downgrades or detaches.
4. Per-view GPU buffers are released.
5. Session continues headlessly.

When the card becomes visible again:

1. Mount a new canvas surface.
2. Attach the view.
3. Request a full viewport snapshot.
4. Replace the thumbnail when the first frame renders.

---

# 10. Input architecture

## 10.1 Keyboard path

```text
DOM KeyboardEvent
→ application shortcut router
→ normalized TerminalKeyEvent
→ control MessagePort
→ terminal-bridge
→ ghosttead
→ libghostty input encoder
→ PTY
```

Use a normalized event:

```ts
interface TerminalKeyEvent {
  type: "down" | "up";
  key: string;
  code: string;
  location: number;
  repeat: boolean;

  shift: boolean;
  control: boolean;
  alt: boolean;
  meta: boolean;

  timestamp: number;
}
```

Application shortcuts are removed before terminal delivery.

Terminal protocol encoding belongs in the sidecar because the sidecar knows:

- Kitty keyboard mode;
- application cursor mode;
- keypad mode;
- modify-other-keys state;
- active terminal modes.

## 10.2 Text and IME

Use a hidden DOM text input for composition.

During composition:

- show the preedit string in a DOM or WebGPU overlay near the cursor;
- do not write incomplete composition to the PTY.

On `compositionend`:

```text
committed Unicode string
→ SendText
→ sidecar encoder
→ PTY
```

IME behavior needs dedicated tests per platform and language.

## 10.3 Mouse

The renderer converts pointer coordinates into:

```ts
interface TerminalPointerEvent {
  pixelX: number;
  pixelY: number;
  cellColumn: number;
  cellRow: number;

  button: number;
  buttons: number;
  kind: "down" | "up" | "move" | "wheel";

  deltaX?: number;
  deltaY?: number;

  shift: boolean;
  control: boolean;
  alt: boolean;
  meta: boolean;
}
```

The sidecar decides whether an event:

- enters local selection behavior;
- scrolls terminal scrollback;
- is encoded and forwarded to the application.

## 10.4 Paste

Paste flow:

1. Read clipboard through a narrow Electron API.
2. Send text to sidecar.
3. Sidecar performs paste-safety checks.
4. Sidecar applies bracketed-paste encoding when enabled.
5. Sidecar writes the result atomically or in bounded chunks.

## 10.5 Clipboard control sequences

OSC clipboard requests must never execute silently.

Policy options:

```text
deny
read-only
write-with-confirmation
allow-for-trusted-session
```

The sidecar emits a policy event to Electron UI and waits for a decision.

---

# 11. Selection, scrollback and search

## 11.1 Ownership

The sidecar owns:

- scrollback contents;
- viewport offset;
- selection endpoints;
- logical text extraction;
- search indexes and results.

The WebGPU renderer owns only their visual representation.

## 11.2 Selection

Selection endpoints use logical terminal positions:

```rust
struct TextPosition {
    line_id: u64,
    column: u32,
}
```

The renderer sends drag updates in viewport coordinates. The sidecar resolves them to logical positions and returns selection spans.

Copy requests call:

```text
ExtractSelection
```

rather than reconstructing text from rendered glyphs.

## 11.3 Search

Search runs in the sidecar.

Results:

```rust
struct SearchMatch {
    start: TextPosition,
    end: TextPosition,
}
```

The active visible matches are converted to highlight spans in display-list frames.

## 11.4 Scrollback policy

Configurable limits:

```text
maximum lines
maximum bytes
maximum decoded images
maximum hyperlink entries
```

The byte limit takes precedence over line count to avoid pathological lines consuming unbounded memory.

---

# 12. Terminal graphics

## 12.1 Kitty graphics

The sidecar:

1. Parses graphics protocol state through the terminal core.
2. Validates dimensions and byte limits.
3. Decodes or stores the image.
4. Assigns an `ImageId`.
5. Sends image definitions separately from row frames.
6. Sends image placements in display-list frames.

The worker maintains a terminal-image texture cache.

## 12.2 Image quotas

Per session:

```text
maximum individual image dimensions
maximum decoded bytes
maximum compressed bytes
maximum image count
maximum total GPU allocation
```

When limits are exceeded, the sidecar rejects or evicts according to a deterministic policy.

## 12.3 Sixel

Add Sixel after:

- Kitty graphics;
- image-cache limits;
- device-loss restoration;
- image-placement clipping;

are all stable.

---

# 13. Agent runtime integration

The terminal is a presentation and process-control channel. It must not become the sole source of agent semantics.

## 13.1 Channels per agent session

```text
AgentSession
├── PTY channel
│   └── original human-facing TUI
│
├── structured channel
│   ├── ACP
│   ├── JSONL
│   ├── agent-specific RPC
│   └── tool lifecycle events
│
└── process telemetry
    ├── exit
    ├── CPU and memory
    ├── child processes
    └── working directory
```

## 13.2 Structured channel

When supported, spawn the agent with:

- an inherited file descriptor on Unix;
- a named pipe on Windows;
- a localhost authenticated socket;
- an agent protocol connection.

Structured events go directly into the agent orchestrator.

They do not pass through:

- the terminal parser;
- the renderer;
- terminal-cell scraping.

## 13.3 Raw PTY tap

When no structured protocol exists, provide a passive raw-output tap:

```text
PTY read
├── terminal parser — highest priority
├── optional recorder
└── agent detector — bounded, lower priority
```

The detector can lag or disable itself. It must never delay terminal parsing.

## 13.4 Semantic terminal events

Expose:

```ts
type TerminalSemanticEvent =
  | { type: "title"; value: string }
  | { type: "cwd"; value: string }
  | { type: "bell" }
  | { type: "prompt-start" }
  | { type: "command-start"; command?: string }
  | { type: "command-finished"; exitCode?: number }
  | { type: "notification"; title: string; body: string }
  | { type: "process-exited"; exitCode: number | null };
```

Shell-integration events may use OSC sequences when available.

---

# 14. Persistence and reconnection

## 14.1 Renderer reload

The sidecar remains alive.

Reconnect flow:

1. New renderer starts.
2. New render worker receives its ports.
3. UI calls `ListSessions`.
4. Existing terminal cards remount.
5. Each view sends `AttachView`.
6. Sidecar returns a full viewport snapshot.
7. Original processes continue uninterrupted.

## 14.2 Electron main crash

If `ghosttead` is launched in persistent mode, it does not use Electron main as its process-lifetime parent.

It stores:

```text
endpoint
process ID
protocol version
authentication token reference
session registry metadata
```

The restarted app authenticates and reattaches.

## 14.3 Application exit policy

Per session:

```rust
enum ExitPolicy {
    TerminateWithApp,
    KeepUntilProcessExit,
    KeepUntilExplicitClose,
}
```

Default behavior should be explicit and visible to users.

## 14.4 Sidecar crash

A sidecar crash normally closes PTYs and therefore cannot preserve running sessions.

Initial production response:

- crash-safe logs;
- minidumps;
- automatic daemon restart;
- UI identifies lost sessions;
- saved terminal recordings remain available.

Later hardening option:

```text
terminal-supervisor
├── workspace-session-host A
├── workspace-session-host B
└── workspace-session-host C
```

This limits a native failure to one workspace, but it should be added only after the single-daemon implementation is stable.

---

# 15. Security model

## 15.1 Renderer isolation

Use:

```ts
contextIsolation: true
nodeIntegration: false
sandbox: true
```

Expose a narrow preload API.

The renderer never receives:

- arbitrary filesystem access;
- PTY handles;
- sidecar authentication tokens;
- process handles.

## 15.2 Sidecar authentication

At daemon startup:

1. Generate a random 256-bit token.
2. Store it in a user-only file.
3. Protect the Unix socket with mode `0600`.
4. Protect Windows named pipes with the current-user ACL.
5. Require token authentication before protocol negotiation.
6. Rotate the token on daemon replacement.

## 15.3 Packet validation

Every packet is checked for:

- magic;
- protocol version;
- maximum size;
- valid session and view handles;
- valid epoch;
- section offsets;
- integer overflow;
- glyph and image quotas;
- UTF-8 validity where required.

Never cast an incoming byte buffer directly to an unchecked Rust structure.

## 15.4 Dangerous terminal actions

Require policy checks for:

- OSC clipboard access;
- opening URLs;
- desktop notifications;
- file transfers;
- terminal-triggered commands;
- working-directory links;
- image allocations.

## 15.5 Untrusted output

Terminal output is untrusted binary input.

Maintain:

- libghostty fuzz tests;
- protocol fuzzing;
- image decoder isolation or strict limits;
- no HTML generation from raw terminal output;
- URL sanitization.

---

# 16. Accessibility

A WebGPU canvas is not intrinsically accessible as terminal text.

Create a low-frequency accessibility projection.

```text
sidecar viewport text
→ accessibility event
→ hidden semantic DOM mirror
→ screen reader
```

The mirror contains:

- visible lines;
- cursor row and column;
- selection;
- terminal title;
- focused state.

Update it:

- immediately after focus or cursor movement caused by user input;
- at a capped frequency during output floods;
- independently from the visual frame rate.

Accessibility updates must not sit in the visual-rendering hot path.

---

# 17. Repository layout

```text
apps/
└── desktop/
    ├── src/main/
    │   ├── terminal-supervisor.ts
    │   ├── terminal-ports.ts
    │   └── terminal-preload.ts
    │
    ├── src/renderer/
    │   ├── terminal/
    │   │   ├── TerminalSurface.tsx
    │   │   ├── TerminalInputRouter.ts
    │   │   ├── TerminalRuntime.ts
    │   │   └── TerminalAccessibility.ts
    │   │
    │   └── workers/
    │       └── terminal-render.worker.ts
    │
    └── src/utility/
        └── terminal-bridge.ts

packages/
├── terminal-client/
│   ├── control-client.ts
│   ├── session.ts
│   ├── view.ts
│   └── events.ts
│
├── terminal-frame/
│   ├── decoder.ts
│   ├── types.ts
│   └── generated/
│
├── terminal-webgpu/
│   ├── device.ts
│   ├── surface.ts
│   ├── atlas.ts
│   ├── buffers.ts
│   ├── renderer.ts
│   ├── thumbnail.ts
│   └── shaders/
│       ├── glyph.wgsl
│       ├── rect.wgsl
│       └── image.wgsl
│
└── terminal-protocol/
    └── generated/

native/
├── terminald/
│   └── crates/
│       ├── terminald/
│       ├── terminal-protocol/
│       ├── terminal-session/
│       ├── terminal-pty/
│       ├── terminal-pty-unix/
│       ├── terminal-pty-windows/
│       ├── ghostty-adapter/
│       ├── text-engine/
│       ├── display-list/
│       ├── terminal-recording/
│       ├── terminal-search/
│       └── agent-adapters/
│
└── vendor/
    └── ghostty/

schemas/
├── terminal-control.proto
├── terminal-events.proto
└── terminal-frame.md

tests/
├── protocol-golden/
├── terminal-conformance/
├── input-conformance/
├── render-snapshots/
├── unicode-corpus/
├── performance/
└── fault-injection/
```

---

# 18. Public TypeScript API

```ts
export interface TerminalRuntime {
  createSession(options: CreateSessionOptions): Promise<TerminalSession>;
  attachSession(sessionId: string): Promise<TerminalSession>;
  listSessions(): Promise<TerminalSessionSummary[]>;
}

export interface TerminalSession {
  readonly id: string;
  readonly events: EventTarget;

  mount(
    canvas: HTMLCanvasElement,
    options: TerminalViewOptions,
  ): Promise<TerminalView>;

  sendKey(event: TerminalKeyEvent): void;
  sendText(text: string): void;
  paste(text: string): void;

  interrupt(): void;
  terminate(): Promise<void>;
  dispose(): void;
}

export interface TerminalView {
  readonly id: string;

  setPixelSize(size: {
    width: number;
    height: number;
    devicePixelRatio: number;
    effectiveZoom: number;
  }): void;

  setVisible(visible: boolean): void;
  setFocused(focused: boolean): void;
  setViewport(offset: number): void;
  setQuality(quality: "thumbnail" | "visible" | "active"): void;

  captureThumbnail(): Promise<ImageBitmap>;
  dispose(): void;
}
```

Session creation:

```ts
interface CreateSessionOptions {
  executable: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;

  cols: number;
  rows: number;

  persistence:
    | "terminate-with-app"
    | "keep-until-exit"
    | "keep-until-explicit-close";

  agentAdapter?: string;
  record?: boolean;
}
```

---

# 19. Delivery plan

## Phase 0 — Measurement harness

Implement before architectural replacement:

- PTY output generator;
- full-screen redraw benchmark;
- Unicode benchmark;
- resize benchmark;
- Ctrl+C-under-flood benchmark;
- renderer frame-time telemetry;
- Electron main and UI-thread utilization.

Exit criteria:

- repeatable baseline for `node-pty + current renderer`;
- trace format that remains usable for every later phase.

`node-pty` is fundamentally a Node binding around PTY facilities, so replacing only that binding would not eliminate renderer-side parsing and IPC overhead. citeturn387041search0

## Phase 1 — Sidecar and persistent sessions

Build:

- `ghosttead`;
- Unix PTY backend;
- Windows ConPTY backend;
- session registry;
- dual control/frame connections;
- bridge utility process;
- create, input, resize and exit;
- renderer-reload reconnection.

Temporary renderer:

- existing xterm.js or ghostty-web.

Exit criteria:

- renderer can reload without killing sessions;
- no terminal bytes pass through Electron main;
- Ctrl+C remains responsive under flood;
- macOS, Windows and Linux process lifecycle tests pass.

## Phase 2 — Libghostty terminal core

Build:

- pinned Ghostty dependency;
- `ghostty-adapter`;
- terminal state and scrollback;
- input encoding;
- terminal damage;
- title, cwd and bell;
- full and incremental logical-row snapshots.

Exit criteria:

- shell and alternate-screen applications work;
- resize and reflow pass;
- Unicode conformance corpus passes;
- parser remains stable under fuzzed input.

## Phase 3 — Basic WebGPU renderer

Build:

- render worker;
- canvas mounting;
- rectangle and glyph pipelines;
- temporary simple glyph rasterization;
- row-replacement frames;
- cursor and selection;
- theme support;
- device-loss handling.

Exit criteria:

- terminal is a fully styleable DOM canvas;
- no terminal rendering work occurs on the React thread;
- sustained output remains visually current;
- command palette can overlay the terminal normally.

## Phase 4 — Production text engine

Build:

- native font discovery;
- fallback;
- HarfBuzz shaping;
- native glyph rasterization;
- glyph catalog;
- monochrome and color atlases;
- ligatures;
- emoji;
- combining marks;
- bold and italic face resolution.

Exit criteria:

- shaping corpus passes;
- no visible cell drift;
- wide and combining characters align correctly;
- text quality is acceptable at 1× and 2× DPR;
- effective-zoom rerendering is crisp.

## Phase 5 — Infinite-canvas virtualization

Build:

- headless, thumbnail, visible and active states;
- canvas promotion and demotion;
- thumbnail capture;
- pan/zoom quality changes;
- multi-terminal render scheduling;
- GPU memory budgets.

Exit criteria:

- at least 100 headless sessions;
- at least 20 monitor thumbnails;
- at least 8 visible terminals;
- one active terminal at display refresh rate;
- no React-frame regression while terminals output.

## Phase 6 — Advanced terminal features

Build:

- Kitty graphics;
- OSC clipboard policies;
- hyperlinks;
- search;
- accessibility mirror;
- recording and replay;
- shell semantic integration;
- agent structured channels.

Exit criteria:

- original coding-agent TUIs remain fully usable;
- agent monitor receives structured events without screen scraping;
- clipboard and URL security tests pass;
- renderer reload restores all visible sessions.

## Phase 7 — Hardening

Build:

- protocol fuzzing;
- process fault injection;
- bridge restart;
- sidecar crash reporting;
- update compatibility checks;
- optional shared-memory frame transport;
- optional sharded session-host processes.

Shared memory should be considered only after packet traces show that bridge transfer is a material bottleneck.

---

# 20. Test matrix

## Terminal applications

At minimum:

```text
bash
zsh
fish
PowerShell
cmd.exe
SSH
tmux
vim
neovim
emacs TUI
htop/btop
less
fzf
lazygit
Claude Code
Codex CLI
other supported coding agents
```

## Input

- Ctrl+C during output flood;
- Ctrl+Z and job control;
- function keys;
- keypad modes;
- Kitty keyboard protocol;
- dead keys;
- Chinese IME;
- Japanese IME;
- Korean IME;
- emoji input;
- bracketed paste;
- mouse tracking;
- wheel scrolling;
- application mouse mode;
- selection override.

## Output

- full 24-bit color;
- palette changes;
- alternate screen;
- rapid cursor movement;
- 100,000-line output;
- repeated clear/redraw;
- resize while outputting;
- combining marks;
- RTL and complex scripts where supported;
- wide characters;
- long grapheme clusters;
- hyperlinks;
- Kitty graphics.

## Failure injection

- kill renderer;
- reload renderer;
- kill bridge;
- disconnect frame channel;
- delay acknowledgements;
- lose WebGPU device;
- exhaust glyph atlas;
- send malformed frame;
- send oversized image;
- sidecar protocol mismatch;
- terminal process forks a large process tree.

---

# 21. Observability

Every layer emits correlated traces using:

```text
session_id
view_id
frame_sequence
terminal_revision
layout_epoch
```

Metrics:

```text
PTY bytes read
parser duration
dirty rows
layout duration
glyph-cache hit rate
glyph-definition bytes
frame bytes
frame queue depth
frames replaced
bridge transfer latency
worker decode duration
GPU upload bytes
GPU encode duration
GPU submit duration
input latency
resize latency
device-loss count
```

Expose a developer overlay:

```text
FPS
frame age
PTY throughput
dirty rows
glyph cache
GPU buffer writes
terminal revision
ack lag
```

---

# 22. Major risks

## Risk 1: libghostty API changes

Mitigation:

- pin commit;
- single adapter crate;
- checked-in bindings;
- conformance suite;
- explicit upgrades only.

## Risk 2: Text quality becomes the largest project

This is the most significant engineering risk.

Mitigation:

- ship basic monospace rendering first;
- build shaping as an isolated native service;
- maintain a visual Unicode corpus;
- cache row layout and glyphs aggressively;
- keep text-engine APIs independent of the terminal core.

## Risk 3: WebGPU driver variability

Mitigation:

- device-loss recovery;
- WebGL fallback;
- conservative texture formats;
- bounded allocations;
- adapter capability negotiation;
- GPU diagnostics in bug reports.

## Risk 4: Too many live canvases

Mitigation:

- one GPU device per window;
- view virtualization;
- thumbnail state;
- canvas demotion;
- shared glyph atlases;
- per-view GPU budgets.

## Risk 5: Output flood delays input

Mitigation:

- separate control and frame channels;
- actor priority queues;
- parser time budgets;
- bounded render queues;
- droppable display frames;
- independent PTY writer.

## Risk 6: Agent semantics inferred from terminal pixels

Mitigation:

- structured side channels;
- raw-byte taps;
- shell integration;
- semantic events;
- never use the WebGPU display list as the agent protocol.

---

# 23. Final architecture summary

The final system is:

```text
Persistent native process and terminal state
        +
native text shaping and glyph rasterization
        +
binary latest-state display-list protocol
        +
Electron utility-process bridge
        +
one WebGPU worker per window
        +
one normal DOM canvas per visible terminal
```

The performance-critical path becomes:

```text
PTY
→ libghostty-vt
→ damaged terminal rows
→ native shaping
→ compact display list
→ transferable ArrayBuffer
→ WebGPU buffers
→ canvas
```

The user-interface path remains:

```text
React
→ CSS layout
→ DOM canvas
→ overlays, transforms and infinite-canvas behavior
```

This is the strongest architecture for combining:

- Ghostty-class terminal correctness;
- original coding-agent TUIs;
- persistent agent sessions;
- WebGPU performance;
- Electron’s UI ecosystem;
- true DOM compositing;
- an infinite canvas and agent-monitor interface.
