# Ghosttea iOS terminal architecture and implementation plan

**Status:** In implementation
**Date:** July 16, 2026
**Owners:** Ghosttea maintainers
**Target:** iOS 18.1 and later for the first production release

---

## 1. Executive decision

Build the iOS terminal as a native Swift package backed by the same Rust
terminal model and frame producer used by the desktop application.

```text
Desktop

local PTY bytes
    -> shared Ghosttea terminal core
    -> libghostty-vt
    -> shared shaping, rasterization, and TRF1 frame producer
    -> WebGPU renderer

iOS

direct SSH bytes, or a Truffle attachment to a desktop-hosted session
    -> shared Ghosttea terminal core
    -> libghostty-vt
    -> shared shaping, rasterization, and TRF1 frame producer
    -> Metal renderer
```

The production design does not embed Ghostty's complete Metal surface. The
desktop demo does not use that surface; it combines `libghostty-vt`, Ghosttea's
native text engine, TRF1 display-list frames, and a custom WebGPU renderer.
Using the same state and frame pipeline on iOS therefore provides closer
Ghosttea parity than embedding full `libghostty` would.

The production iOS application also integrates the Apple-native Truffle
packages from the sibling `p008/truffle/apple` package. Truffle is not an
optional companion feature: it is the authenticated device mesh through which
the desktop demo and iOS application discover one another and attach two views
to the same authoritative Ghosttea session. Direct SSH remains available for
standalone use, but it does not satisfy the cross-device continuity goal by
itself.

The repository should add three implementation boundaries:

```text
native/ghosttea-core       platform-neutral terminal and session state
native/ghosttea-ffi        stable, narrow C ABI for Apple clients
apple/GhostteaKit          Swift Package with terminal, workspace, and transport products
```

The existing `terminald` becomes a desktop PTY and service adapter around
`ghosttea-core`. The iOS package supplies SSH or remote-session transport,
UIKit input, SwiftUI workspace presentation, and Metal rendering.

### Core architectural rule

```text
Terminal bytes are never parsed by SwiftUI, UIKit, React, or a GPU renderer.
```

Terminal state remains authoritative in Rust. A renderer may drop an
intermediate TRF1 frame under backpressure, but terminal input bytes, terminal
output bytes, terminal-generated replies, and authoritative state must not be
dropped.

---

## 2. Context

Ghosttea desktop currently has the following hot path:

```text
PTY
  -> ghosttead / terminald
  -> GhosttyTerminalCore
  -> native text shaping and glyph rasterization
  -> TRF1 frame socket
  -> Electron utility process
  -> transferable MessagePort
  -> render worker
  -> WebGPU
```

The current implementation already contains most of the platform-neutral
behavior needed by an iOS client:

- VT parsing, screen state, damage, reflow, scrollback, terminal modes, and
  input encoding through `GhosttyTerminalCore`;
- session and view authority;
- globally ordered human and automation input;
- logical terminal snapshots;
- native shaping and glyph rasterization;
- revisioned binary TRF1 frames;
- remote logical-state replication;
- workspace split, focus, resize, zoom, and close semantics.

The main obstacle is not Ghostty compatibility. It is that the current
`Session` type couples those behaviors to desktop PTY creation, process
lifecycle, Unix-oriented I/O threads, and system-font discovery.

The iOS implementation must separate those concerns without regressing the
desktop path.

---

## 3. Goals

### 3.1 Product goals

1. Run interactive remote shells and terminal applications on iPhone and iPad.
2. Match the desktop demo's VT, key, paste, mouse, scroll, resize, cursor,
   color, selection, and workspace behavior where the platform permits.
3. Support software keyboards, hardware keyboards, pointer devices, and IME.
4. Support direct SSH sessions and Truffle attachments to desktop-hosted
   Ghosttea sessions.
5. Preserve remote shells across ordinary network changes and iOS suspension
   through reconnectable transports and remote session persistence.
6. Support tabs and splits, with adaptive presentation on compact iPhone
   layouts and desktop-like presentation on iPad.
7. Make the terminal reusable by other iOS applications through Swift Package
   Manager.
8. Keep the Ghostty revision, native artifacts, licenses, checksums, and build
   inputs pinned and reproducible.
9. Let the desktop demo and iOS application concurrently attach to the same
   Truffle-published Ghosttea session, with one terminal authority and the
   existing view/control epochs governing both clients.

### 3.2 Engineering goals

1. Use one authoritative terminal implementation across desktop and iOS.
2. Keep Rust/Swift crossings coarse-grained and binary.
3. Keep VT parsing, shaping, glyph rasterization, and frame construction off
   the iOS main thread.
4. Make the desktop PTY path an adapter rather than a special case embedded in
   the terminal model.
5. Test parity through shared fixtures and golden frames.
6. Permit the iOS UI, renderer, and transports to evolve independently of the
   terminal core.
7. Avoid requiring a permanent fork of full `libghostty`.

### 3.3 Initial performance goals

These measure the local client pipeline and exclude network latency:

| Operation                                      |                   Initial target |
| ---------------------------------------------- | -------------------------------: |
| UIKit event to transport write invocation, p50 |                       under 2 ms |
| UIKit event to transport write invocation, p99 |                       under 8 ms |
| Received bytes to Metal submission, p50        |                       under 8 ms |
| Received bytes to Metal submission, p99        |                      under 16 ms |
| Active terminal refresh                        | display refresh rate when useful |
| Background GPU submissions                     |                             zero |
| Main-thread VT parsing                         |                             zero |
| Main-thread glyph rasterization                |                             zero |
| Per-cell Swift/Rust calls                      |                             zero |

The current 8 ms output batching interval is the starting policy. It should be
measured on 60 Hz and 120 Hz devices before being made adaptive.

---

## 4. Non-goals

The first production version will not promise:

- spawning an unrestricted local Unix shell or arbitrary local executable on
  iOS;
- keeping a general-purpose SSH connection and Metal renderer active
  indefinitely after iOS suspends the application;
- reusing React, DOM, Electron, or WebGPU implementation code on iOS;
- literal screenshot equality between devices with different display scale,
  color space, or safe-area geometry;
- complete Ghostty graphics-protocol support in the first milestone;
- a stable public Rust ABI;
- running the desktop Go sidecar unchanged inside an iOS application; iOS uses
  the Apple-native Truffle package and its in-process network backend instead;
- changing the desktop output path while extracting the shared core.

---

## 5. Research findings and constraints

### 5.1 `libghostty-vt` is the correct shared state boundary

Ghostty describes `libghostty-vt` as a terminal-state library intended for
custom renderers. It provides terminal parsing and render state but does not
draw a surface or perform complete text shaping and layout. Ghostling is the
upstream demonstration of this boundary.

That matches Ghosttea's existing architecture exactly: Ghosttea owns shaping,
rasterization, binary display-list generation, and final rendering.

### 5.2 The pinned Ghostty revision already contains an iOS VT build path

The pinned checkout's `GhosttyLibVt.zig` supports:

- `aarch64-ios` device builds;
- `aarch64-ios-simulator` builds;
- an Apple XCFramework containing the supported slices;
- a `GhosttyVt` module map.

The current Ghosttea artifact pipeline publishes only the Apple Silicon macOS
target. iOS support therefore requires build and packaging work, not a new VT
port.

Because iOS SDK discovery and `xcodebuild -create-xcframework` require Xcode,
Apple artifacts must be built on a pinned macOS/Xcode builder. The current
minimal Linux container remains appropriate for the existing macOS
cross-compiled artifact but cannot be the complete iOS XCFramework builder.

### 5.3 Full `libghostty` is useful for a spike, not the parity foundation

The pinned Ghostty source contains UIKit and Metal surface support. Its public
surface configuration still follows Ghostty's normal command/termio model and
does not expose a stable upstream host-managed byte backend for an SSH client.

Community projects such as `libghostty-spm`, Termini, Geistty, and Rootshell
demonstrate viable iOS integration, but they have needed additional external
I/O, event-loop, or lifecycle work. Depending on one of those implementations
for the production core would introduce a second rendering implementation and
a fork/patch update burden.

A bounded full-libghostty spike remains valuable for:

- confirming device and simulator Metal behavior;
- studying keyboard and IME integration;
- studying `CADisplayLink`, background, and foreground behavior;
- comparing text and rendering output;
- learning from existing host-managed transport APIs.

It is not on the production critical path unless upstream exposes a stable
host-managed I/O surface and the product changes its parity target from
Ghosttea desktop to upstream Ghostty.

### 5.4 iOS changes process and lifecycle assumptions

The desktop service owns a local process, PTY master, read thread, write
thread, termination escalation, and process exit metadata. An App Store iOS
application cannot use that as its general terminal-session model. The iOS
terminal must consume a byte transport such as SSH or a remote Ghosttea
session.

When an ordinary iOS application enters the background, it receives a limited
transition period and is normally suspended. Metal submissions must stop. The
design must therefore make foreground rendering disposable and make transport
reconnection explicit. Persistent terminal work belongs in the remote shell,
tmux/zellij, or a remote Ghosttea authority.

---

## 6. Alternatives considered

| Alternative                                               |    Time to first pixels | Desktop semantic parity | Desktop render parity | Maintenance risk | Decision                |
| --------------------------------------------------------- | ----------------------: | ----------------------: | --------------------: | ---------------: | ----------------------- |
| Embed community full `libghostty` package                 |                    Fast |                  Medium |            Low-medium |             High | Spike only              |
| Maintain a full Ghostty iOS fork                          |                  Medium |                  Medium |            Low-medium |        Very high | Reject                  |
| Reimplement VT behavior in Swift                          |                    Slow |                     Low |                   Low |        Very high | Reject                  |
| Share `libghostty-vt` only; duplicate session/frame logic |                  Medium |          High initially |                Medium |      Medium-high | Reject                  |
| Share Ghosttea terminal model and frame producer          |                  Medium |                 Highest |     Highest practical |           Medium | Adopt                   |
| Render remote Ghosttea frames only                        | Fast for companion mode |                 Highest |                  High |           Medium | Optional transport mode |

### 6.1 Why not ship only a remote-frame client?

A client that attaches to a running Ghosttea daemon can reuse the most server
behavior and is the correct mode for seamless desktop/iOS continuity, but it
cannot provide standalone SSH without a Ghosttea host. Conversely, a purely
standalone terminal cannot join the desktop demo's already-running session.

The production app therefore supports both modes. Direct SSH feeds the local
shared core. A Truffle attachment treats the desktop daemon as terminal
authority, receives its logical snapshots and patches, and projects that state
through the same iOS renderer. The remote replica never reparses terminal bytes
and never claims to be an independent copy of the session.

---

## 7. Target architecture

```text
┌───────────────────────────────────────────────────────────────────┐
│ SwiftUI application and workspace                                │
│                                                                   │
│ tabs, split tree, command palette, settings, session restoration  │
└──────────────────────────────┬────────────────────────────────────┘
                               │ view models and commands
┌──────────────────────────────▼────────────────────────────────────┐
│ GhostteaTerminal UIKit module                                    │
│                                                                   │
│ UITextInput / hardware keys / pointer / selection / accessibility│
│ Metal surface / display link / glyph atlases / frame coalescing  │
└───────────────┬───────────────────────────────┬───────────────────┘
                │ coarse C ABI                    │ async byte I/O
┌───────────────▼──────────────────────┐  ┌──────▼──────────────────┐
│ GhostteaCoreFFI.xcframework          │  │ TerminalTransport       │
│                                      │  │                         │
│ Ghosttea terminal model              │  │ selected SSH adapter    │
│ libghostty-vt                        │  │ Ghosttea remote gateway │
│ shaping and rasterization            │  │ test/replay transport   │
│ TRF1 frame production                │  └─────────────────────────┘
│ terminal replies and semantic events │
└──────────────────────────────────────┘
```

### 7.1 Ownership

At application scope:

```text
one native Ghosttea runtime per font and raster configuration
one shared text engine and glyph identity namespace
one Metal runtime per MTLDevice
shared immutable pipeline state and, where practical, shared glyph atlases
```

The shared Rust core supports multiple attached views because the desktop
service requires them. The iOS v1 presentation deliberately does not exercise
that capability: each `TerminalController` permits at most one attached iOS
presentation endpoint at a time.

For each live terminal session in iOS v1:

```text
one TerminalTransport
one TerminalController actor
one native Ghosttea terminal handle
one retained row and frame-sequencing state
zero or one visible terminal surface
```

A session may remain connected without a visible surface. In that state the
native terminal continues consuming bytes and producing terminal replies and
logical metadata, but it does not shape rows or construct render frames until
a view is attached or a refresh is requested. The application-level runtime
keeps font parsing, glyph rasterization caches, and glyph identifiers shared
across terminal sessions, as the desktop service does today. A future iPad
multi-scene release may attach more than one presentation to a session without
changing the native model; each presentation will need its own view identity,
selection, focus, geometry, and resize-authority state.

### 7.2 Data paths

Output:

```text
transport receives ordered bytes
  -> TerminalController batches for at most 8 ms
  -> ghosttea_terminal_feed
  -> libghostty-vt updates authoritative state
  -> terminal-generated reply bytes are returned to transport
  -> changed rows are shaped and rasterized
  -> one owned TRF1 buffer is returned
  -> Metal render queue decodes and submits
```

Input:

```text
UIKit event
  -> normalized Ghosttea key/mouse/paste/focus event
  -> ghosttea_terminal_encode_*
  -> one owned output byte buffer
  -> transport sends bytes immediately
```

Resize:

```text
surface bounds + scale + font metrics
  -> rows and columns
  -> view claims resize authority
  -> native terminal reflows once
  -> transport sends SSH window-change or remote resize
  -> full TRF1 snapshot
```

---

## 8. Repository and package design

```text
Cargo.toml

native/
  ghosttea-core/
    Cargo.toml
    src/
      lib.rs
      model.rs
      input.rs
      output.rs
      render.rs
      events.rs

  ghosttea-ffi/
    Cargo.toml
    include/ghosttea.h
    src/lib.rs

  terminald/
    src/
      session.rs             desktop PTY adapter around ghosttea-core
      service.rs
      authority.rs           moved or re-exported from core as appropriate
      frame.rs               moved to core

apple/
  GhostteaKit/
    Package.swift
    Sources/
      GhostteaCore/
      GhostteaTerminal/
      GhostteaWorkspace/
      GhostteaSSH/
    Tests/
      GhostteaCoreTests/
      GhostteaTerminalTests/
      GhostteaWorkspaceTests/
      GhostteaSSHTests/
    Artifacts/
      GhosttyVt.xcframework
      GhostteaCoreFFI.xcframework

fixtures/
  parity/
    vt/
    input/
    frames/
    layouts/
```

### 8.1 Rust crates

#### `ghosttea-core`

`ghosttea-core` owns all behavior that must be identical across hosts. It
provides an application-level `TerminalRuntime` and per-session
`TerminalModel` values. The runtime owns shared fonts, shaping state, glyph
caches, and the glyph identity namespace. Each model owns its terminal state,
damage, view, and sequence state.

The crate is responsible for:

- `GhosttyTerminalCore` lifetime;
- feed, resize, scroll, alternate scroll, focus, paste, key, and mouse behavior;
- terminal-generated response extraction;
- title, cwd, bell, mouse tracking, and clipboard events;
- logical snapshot creation;
- damage and render caches;
- text shaping and glyph definition production;
- TRF1 encoding;
- session, layout, revision, and frame sequence counters;
- view attachment and resize authority where multi-view behavior is used;
- human-input and automation ordering policy where automation is used.

It must not depend on:

- `portable_pty`;
- a child process;
- Tokio networking;
- Unix sockets;
- Electron;
- Truffle;
- UIKit or Swift.

The crate may depend on `ghostty-adapter`, `text-engine`, `bytes`, `serde`, and
small synchronization primitives. Its public API should be ordinary Rust and
must not expose C ABI concerns.

#### `ghosttea-ffi`

`ghosttea-ffi` owns the exported C ABI and nothing else. It translates plain C
data structures into `ghosttea-core` calls, catches Rust panics at the ABI
boundary, converts failures into typed status codes, and defines explicit
buffer ownership.

It builds as a static library for:

- `aarch64-apple-ios`;
- `aarch64-apple-ios-sim`;
- optionally `x86_64-apple-ios` while Intel simulator support is required.

No Rust type, allocator object, trait object, string, or panic crosses the ABI.

#### `terminald`

`terminald` retains:

- PTY creation and process supervision;
- environment policy;
- desktop read/write actors;
- process-group termination and exit classification;
- control and frame socket services;
- application persistence policy;
- attachment to remote mesh adapters.

Its `Session` owns a `TerminalModel` rather than owning
`GhosttyTerminalCore`, text-engine state, and render caches separately.

### 8.2 Swift Package products

`apple/GhostteaKit/Package.swift` should expose:

| Product               | Responsibility                                      |
| --------------------- | --------------------------------------------------- |
| `GhostteaCore`        | Safe Swift ownership of the C handle and buffers    |
| `GhostteaTerminal`    | UIKit input surface and Metal renderer              |
| `GhostteaWorkspace`   | Portable tab/split model, commands, and restoration |
| `GhostteaWorkspaceUI` | Adaptive SwiftUI tabs and split presentation        |
| `GhostteaSSH`         | First-party SSH transport selected by Phase 0       |

Applications may consume `GhostteaTerminal` with a custom transport without
depending on `GhostteaSSH` or `GhostteaWorkspace`.

The package initially contains two binary targets internally:

- the pinned `GhosttyVt.xcframework`;
- `GhostteaCoreFFI.xcframework`, which links against it.

A small Swift target depends on both and exposes only the safe Ghosttea API.
Once the artifact build is stable, the archives may be merged into one
consumer-facing XCFramework if doing so simplifies distribution without
obscuring licenses or symbols.

---

## 9. Shared Rust core refactor

### 9.1 Proposed terminal model

The exact names may change, but the ownership split should resemble:

```rust
pub struct TerminalRuntime {
    text_engine: Arc<Mutex<TextEngine>>,
    render_configuration: RenderConfiguration,
}

pub struct TerminalModel {
    runtime: Arc<TerminalRuntime>,
    terminal: GhosttyTerminalCore,
    render_cache: RenderCache,
    metadata: TerminalMetadata,
    session_epoch: u64,
    layout_epoch: u64,
    terminal_revision: u64,
    frame_sequence: u64,
    authority: ViewAuthority,
    input_order: InputOrderState,
}

impl TerminalModel {
    pub fn new(runtime: Arc<TerminalRuntime>, options: TerminalModelOptions) -> Result<Self>;
    pub fn feed(&mut self, bytes: &[u8], render: RenderRequest) -> Result<TerminalUpdate>;
    pub fn refresh(&mut self, kind: RefreshKind) -> Result<TerminalUpdate>;
    pub fn resize(&mut self, size: TerminalSize) -> Result<TerminalUpdate>;
    pub fn encode_key(&mut self, event: KeyInput) -> Result<Vec<u8>>;
    pub fn encode_mouse(&mut self, event: MouseInput) -> Result<Vec<u8>>;
    pub fn encode_paste(&mut self, text: &str) -> Result<Vec<u8>>;
    pub fn encode_focus(&mut self, focused: bool) -> Result<Vec<u8>>;
    pub fn scroll(&mut self, rows: isize) -> Result<TerminalUpdate>;
}
```

`feed` must return terminal-generated replies even when no view is attached.
These include device-status and capability responses that the remote process
expects. A transport adapter must send them before or in order with later user
input.

### 9.2 Separate state mutation from process I/O

The model must never write directly to a PTY or network connection. Every
state-mutating operation returns one ordered effect batch:

```rust
pub type TerminalUpdate = SmallVec<[TerminalEffect; 4]>;

pub enum TerminalEffect {
    WriteToTransport(Vec<u8>),
    MetadataChanged(TerminalMetadata),
    Bell,
    ClipboardRequest(ClipboardRequest),
    FrameReady(Vec<u8>),
    LogicalSnapshotReady(LogicalTerminalSnapshot),
}
```

The effect list is the authoritative model contract. The host executes effects
in order and applies host policy for clipboard, notifications, URLs, and other
privileged actions.

Ordering rules:

1. Effects appear in causal order.
2. A `WriteToTransport` discovered while processing received bytes precedes
   any effect that assumes the remote process has received that reply.
3. The host enqueues every effect from one `TerminalUpdate` before processing
   another model operation.
4. The FFI representation must preserve this ordering; it must not flatten
   effects into unrelated fields with implicit order.
5. Input-encoding methods return only outbound input bytes because they do not
   produce render or semantic effects. The host assigns those bytes their
   place in the same outbound sequence used for `WriteToTransport` effects.

### 9.3 Rendering is demand-driven

The current desktop implementation avoids snapshot and shaping work when no
view is active. Preserve that property with an explicit render request:

```rust
pub enum RenderRequest {
    None,
    Damage,
    Full,
}
```

Terminal state always advances. `RenderRequest::None` still extracts reply
bytes and semantic events. Attaching a new view requests a full snapshot and a
glyph-catalog reset.

### 9.4 Do not change the desktop wire protocol during extraction

The first extraction commit must produce byte-identical TRF1 frames for
existing fixtures. Moving `frame.rs`, render-cache types, and logical snapshot
construction should be mechanical before adding any iOS API.

Existing desktop protocol versions, socket paths, service commands, view
authority, frame sequence behavior, and renderer ownership remain unchanged.

---

## 10. FFI design

### 10.1 ABI principles

1. Export C, not a Rust ABI.
2. Use opaque handles.
3. Use fixed-width integers and explicitly sized structures.
4. Version every configuration and event structure.
5. Return one contiguous buffer per operation.
6. Make allocation and deallocation ownership explicit.
7. Never call Swift once per cell, style, glyph, or row.
8. Never invoke arbitrary Swift while holding a Rust mutex.
9. Catch panics before unwinding across C.
10. Make handles single-owner and serialize all model access.

### 10.2 Illustrative C API

```c
typedef struct ghosttea_terminal ghosttea_terminal_t;
typedef struct ghosttea_runtime ghosttea_runtime_t;

typedef struct {
  const uint8_t *data;
  size_t len;
} ghosttea_bytes_view_t;

typedef struct {
  uint8_t *data;
  size_t len;
  size_t capacity;
} ghosttea_owned_bytes_t;

typedef enum {
  GHOSTTEA_STATUS_OK = 0,
  GHOSTTEA_STATUS_INVALID_ARGUMENT = 1,
  GHOSTTEA_STATUS_INVALID_STATE = 2,
  GHOSTTEA_STATUS_INTERNAL = 3,
  GHOSTTEA_STATUS_PANIC = 4,
} ghosttea_status_t;

typedef enum {
  GHOSTTEA_FONT_REGULAR = 0,
  GHOSTTEA_FONT_BOLD = 1,
  GHOSTTEA_FONT_ITALIC = 2,
  GHOSTTEA_FONT_BOLD_ITALIC = 3,
  GHOSTTEA_FONT_FALLBACK = 4,
} ghosttea_font_role_t;

typedef struct {
  ghosttea_bytes_view_t data;
  uint32_t face_index;
  ghosttea_font_role_t role;
} ghosttea_font_t;

typedef struct ghosttea_key_event ghosttea_key_event_t;

typedef struct {
  uint32_t abi_version;
  const ghosttea_font_t *fonts;
  size_t font_count;
  float font_size;
  float raster_scale;
} ghosttea_runtime_config_t;

typedef struct {
  uint32_t abi_version;
  uint16_t cols;
  uint16_t rows;
  uint64_t scrollback_bytes;
} ghosttea_terminal_config_t;

typedef struct {
  uint32_t sequence;
  uint32_t kind;
  uint32_t payload_offset;
  uint32_t payload_length;
} ghosttea_effect_t;

typedef struct {
  ghosttea_owned_bytes_t storage;
  const ghosttea_effect_t *effects;
  size_t effect_count;
} ghosttea_update_t;

ghosttea_status_t ghosttea_runtime_create(
    const ghosttea_runtime_config_t *config,
    ghosttea_runtime_t **out_runtime);

void ghosttea_runtime_destroy(ghosttea_runtime_t *runtime);

ghosttea_status_t ghosttea_terminal_create(
    ghosttea_runtime_t *runtime,
    const ghosttea_terminal_config_t *config,
    ghosttea_terminal_t **out_terminal);

void ghosttea_terminal_destroy(ghosttea_terminal_t *terminal);

ghosttea_status_t ghosttea_terminal_feed(
    ghosttea_terminal_t *terminal,
    ghosttea_bytes_view_t bytes,
    uint32_t render_request,
    ghosttea_update_t *out_update);

ghosttea_status_t ghosttea_terminal_resize(
    ghosttea_terminal_t *terminal,
    uint16_t cols,
    uint16_t rows,
    ghosttea_update_t *out_update);

ghosttea_status_t ghosttea_terminal_encode_key(
    ghosttea_terminal_t *terminal,
    const ghosttea_key_event_t *event,
    ghosttea_owned_bytes_t *out_bytes);

void ghosttea_owned_bytes_free(ghosttea_owned_bytes_t bytes);
void ghosttea_update_destroy(ghosttea_update_t update);
const char *ghosttea_last_error_message(void);
```

This is illustrative rather than a frozen header. `ghosttea_update_t` owns one
arena containing the ordered descriptor table and effect payloads. One destroy
operation releases the entire update. Mouse, paste, focus, scroll, theme,
metadata, full refresh, selection-text extraction, and accessibility-row
snapshot calls must follow the same ownership model.
`ghosttea_font_t` must contain a byte view, face index, and font role. The
runtime copies or otherwise takes documented ownership of font bytes during
creation; it must never retain borrowed Swift memory accidentally.

`ghosttea_last_error_message` should be thread-local, valid until the next FFI
call on that thread, and copied immediately by Swift. An owned structured error
may replace it if that produces a clearer API during implementation.

### 10.3 Event encoding

Low-frequency semantic events may use a versioned binary envelope or JSON in
the first implementation. TRF1 frames and transport byte streams must remain
binary. If JSON is used for events, it must not be introduced into the frame
path.

### 10.4 Threading contract

The C header must state:

- runtime and terminal creation and destruction may occur on any non-realtime
  thread;
- a runtime must outlive every terminal created from it;
- terminal calls may share a runtime concurrently because the Rust runtime
  synchronizes its shared text engine;
- a terminal handle is not concurrently callable;
- the Swift `TerminalController` actor serializes calls;
- buffers remain valid until explicitly freed;
- returned frame buffers may be moved to a render queue without copying;
- deallocation may occur on the render queue after GPU staging completes.

### 10.5 Panic and poisoned-handle contract

`GHOSTTEA_STATUS_PANIC` is fatal for the affected native state. Swift must not
retry the operation.

- A panic confined to a terminal operation poisons that terminal handle.
- After terminal poisoning, only error inspection and
  `ghosttea_terminal_destroy` are legal.
- Other calls return `GHOSTTEA_STATUS_INVALID_STATE` without touching the
  terminal.
- A panic while mutating shared runtime state, including the shared text
  engine, poisons the runtime.
- A poisoned runtime invalidates every terminal created from it. Swift marks
  those sessions failed, destroys their handles, and creates a new runtime
  before starting replacement sessions.
- Runtime creation that panics returns no handle.

The FFI catches unwinding, marks the appropriate poison scope before returning,
and retains a diagnostic safe to copy for redacted crash reporting.

Swift should wrap returned memory in `Data(bytesNoCopy:deallocator:)` where it
is safe and verified. If Foundation copies a buffer in a particular path, the
copy must be measured rather than hidden.

---

## 11. Swift API design

### 11.1 Transport abstraction

```swift
public protocol TerminalTransport: Sendable {
    func connect() async throws -> any TerminalConnection
}

public protocol TerminalConnection: Sendable {
    func read(maxBytes: Int) async throws -> ByteBuffer?
    func write(_ bytes: ByteBuffer) async throws
    func finishInput() async throws
    func resize(columns: Int, rows: Int) async throws
    func interrupt() async throws
    func waitForExit() async throws -> TerminalExitStatus
    func disconnect() async
}
```

The pull-based read is intentional. `AsyncThrowingStream` is not the generic
transport contract because its default buffer is unbounded and its bounded
policies discard elements. Transport implementations preserve byte ordering
and propagate read demand into their native flow-control primitive. They own
connection, authentication, host verification, network recovery, and
protocol-level resize messages. They do not parse terminal escape sequences.
`finishInput()` is a protocol half-close: it sends input EOF while leaving
remote output readable. After output is drained, `waitForExit()` completes the
transport close handshake and returns the typed remote exit status. Abrupt
`disconnect()` remains available for cancellation and network loss.
`TerminalExitStatus` is an enum with `.exited(code:)` and `.signaled(name:)`;
SSH signal names omit the leading `SIG`. This prevents a remote signal from
being mistaken for libssh2's default numeric status of zero.

Initial implementations:

- `SSHTransport` backed by the implementation selected by the Phase 0
  compatibility gate;
- `ReplayTransport` for deterministic fixtures and demos;
- `LoopbackTransport` for unit and UI tests.

Future implementations:

- `GhostteaRemoteTransport` through an authenticated network gateway;
- application-provided transports for serial consoles or custom agents.

### 11.2 Terminal controller

```swift
public actor TerminalController {
    public let id: UUID

    public init(runtime: GhostteaRuntime,
                configuration: TerminalConfiguration,
                transport: any TerminalTransport) throws

    public func connect() async throws
    public func attachView(_ view: TerminalViewEndpoint) async
    public func detachView() async
    public func resize(columns: Int, rows: Int) async throws
    public func send(_ event: TerminalInputEvent) async throws
    public func requestFullRefresh() async throws
    public func disconnect() async
}
```

`GhostteaRuntime` is a long-lived, thread-safe Swift owner for the native
runtime handle. It is normally created once by the application for a font and
raster configuration, then shared by all terminal controllers.

The controller actor owns its native terminal handle and serializes:

- received transport bytes;
- terminal-generated reply writes;
- user input encoding and writes;
- resize and reflow;
- view attachment;
- frame generation requests.

The Metal renderer does not call the native terminal handle directly. It
receives immutable frame buffers through a render endpoint.

### 11.3 Ordering and backpressure

The outbound transport writer must be an ordered actor or channel separate from the
potentially blocking network implementation. The terminal controller assigns
an outbound sequence to every terminal reply and user-input buffer and enqueues
it without waiting for a socket write to complete.

```text
TerminalController
  -> bounded, ordered outbound queue
  -> TransportWriter
  -> TerminalConnection.write
```

The actor order defines the wire order. A terminal reply discovered while
processing received bytes is enqueued before any later input event accepted by
the controller. Resize protocol messages use the same ordered transport policy
where the underlying protocol requires it.

Backpressure policies differ intentionally.

Inbound:

- terminal bytes are lossless;
- the controller requests another bounded chunk only when it can process it;
- an SSH implementation disables automatic child-channel reads and withholds
  channel-window updates until the terminal drains delivered bytes;
- other transports map demand to their flow-control mechanism;
- ordinary output floods stall the remote writer rather than disconnecting;
- disconnect is reserved for a peer that violates flow control or a transport
  that cannot pause before a hard memory-safety bound.

Outbound:

- bytes are lossless and globally ordered;
- queues are bounded by bytes as well as item count;
- a connection that cannot drain its outbound queue within policy fails with
  an explicit backpressure error instead of dropping or growing without bound;

Rendering and events:

- intermediate render frames are latest-useful-state and may be coalesced;
- a dropped incremental frame causes a full-refresh request unless the
  renderer can prove that a newer frame supersedes it completely;
- semantic security events are lossless and bounded separately from frames.

### 11.4 Public terminal view

The reusable UI should be UIKit-first and SwiftUI-compatible:

```swift
public final class GhostteaTerminalView: UIView {
    public var controller: TerminalController?
    public var theme: TerminalTheme
    public var contentInsets: UIEdgeInsets

    public func focusTerminal()
    public func copySelection()
    public func paste()
    public func selectAll()
    public func clearSelection()
}

public struct GhostteaTerminalSurface: UIViewRepresentable {
    // SwiftUI wrapper
}
```

UIKit owns low-level text input, hardware key events, selection gestures,
pointer interaction, accessibility, and the Metal layer. SwiftUI owns
composition and workspace state.

---

## 12. Metal renderer

### 12.1 Contract

The Metal renderer consumes the same TRF1 protocol as the desktop WebGPU
worker. It must not access terminal state or font files.

TRF1 currently carries:

- frame, session, view, layout, and terminal revision identifiers;
- full-snapshot and mouse-tracking flags;
- glyph definitions;
- style definitions;
- row replacements;
- cursor state;
- reserved sections for selection, images, viewport metadata,
  accessibility, and clipboard writes.

The Swift decoder must apply the same structural validation as
`@vibecook/ghosttea-frame`:

- magic and protocol version;
- maximum frame size;
- section-table bounds;
- integer overflow checks;
- section-specific lengths and counts;
- UTF-8 validity;
- glyph pixel-length validation;
- reserved field validation.

Malformed frames must fail closed without reaching Metal buffer or texture
allocation.

### 12.2 Renderer state

An application-level `MetalRuntime` owns:

```text
one MTLDevice
one MTLCommandQueue
immutable render pipeline state
shared alpha and premultiplied-RGBA glyph atlases where glyph IDs permit
```

Each visible terminal renderer owns:

```text
one style catalog scoped to its terminal stream
one retained row display list per terminal row
cursor and selection state
frame/revision sequencing state
```

The first vertical slice uses per-terminal, 2,048-square alpha and color
atlases, a fixed 20 MiB allocation per visible renderer. It uses deterministic
shelf placement and resets an atlas only after preflighting that the complete
visible working set fits from empty; an unrepresentable set fails without a
partial upload. Before production, measure smaller tiered sizes, multi-page
growth, and whether sharing atlases across terminals
materially reduces memory and upload work. Shared atlases must namespace glyph
IDs by native runtime so independent runtime configurations cannot collide.

The renderer processes row replacement frames atomically. It discards stale
frame sequences and requests a full refresh after a sequence gap, glyph
catalog reset, decode failure, foreground restoration, or resource eviction.

### 12.3 Rendering passes

The first implementation uses these passes:

1. clear terminal background;
2. draw per-cell and row background rectangles;
3. draw selection rectangles;
4. draw alpha glyphs tinted by resolved foreground color;
5. draw premultiplied color glyphs;
6. draw underline and strikethrough decorations;
7. draw cursor according to block, bar, underline, or hollow-block style.

This ordering must match the desktop renderer's observable behavior.

### 12.4 Scheduling

Use an `MTKView` or a controlled `CAMetalLayer` plus display link. Rendering is
event-driven:

- a new accepted TRF1 frame marks the surface dirty;
- cursor blinking marks only cursor state dirty;
- selection changes mark affected rows dirty;
- animations request display-link ticks only while active;
- an unchanged terminal does not continuously submit command buffers.

When the scene becomes inactive:

1. stop the display link;
2. stop creating Metal command buffers;
3. detach or drain pending drawable work;
4. retain CPU terminal state;
5. permit reclaiming GPU atlases under memory pressure.

On foreground restoration, recreate missing GPU resources and request a full
TRF1 refresh.

### 12.5 Scale and geometry

The renderer separates:

- logical terminal cells;
- points in the UIKit layout;
- drawable pixels;
- font raster scale.

Grid dimensions are computed from available points and shared cell metrics.
Drawable allocation uses the current screen scale. A screen-scale change,
external display move, Dynamic Type policy change, or font-size change causes
one controlled resize and full refresh.

---

## 13. Font and text parity

### 13.1 Current incompatibility

The existing text engine discovers and loads system fonts. That behavior is
not an adequate cross-platform parity contract:

- iOS and macOS expose different installed fonts and file access;
- fallback order can differ;
- font versions can change with the operating system;
- the same family name does not guarantee the same bytes;
- system discovery may not compile or behave unchanged on iOS.

### 13.2 Adopt explicit font resources

Add a byte-oriented text-engine constructor:

```rust
pub struct FontResource<'a> {
    pub bytes: &'a [u8],
    pub face_index: u32,
    pub role: FontRole,
}

TextEngine::from_fonts(fonts, metrics, raster_scale)
```

The product must select terminal fonts that may legally be bundled and
redistributed. Use identical font bytes, face indices, feature settings, cell
metrics, shaping options, and Swash rasterization parameters on desktop and
iOS parity runs.

The desktop product may retain an explicit opt-in system-font mode, but that
mode cannot claim cross-platform pixel parity.

### 13.3 Parity levels

Define three levels instead of using “exact” ambiguously:

| Level           | Contract                                                               |
| --------------- | ---------------------------------------------------------------------- |
| Semantic parity | Same VT state, modes, input bytes, logical cells, cursor, and events   |
| Frame parity    | Same normalized TRF1 rows, styles, glyph placements, and glyph bitmaps |
| Visual parity   | Rendered screenshots match within declared scale/color tolerances      |

Semantic parity is mandatory. Frame parity is mandatory when the same bundled
fonts and raster scale are used. Visual parity is mandatory within test
tolerances but cannot mean identical raw screenshots across different device
scales and color spaces.

---

## 14. Input, selection, and accessibility

### 14.1 Software keyboard and IME

The terminal view should implement `UIKeyInput` and the necessary
`UITextInput` surface for marked text and IME composition.

Composition policy:

1. UIKit owns the marked-text lifecycle.
2. Marked text is presented as an overlay and is not sent prematurely.
3. Committed text is sent through the terminal text/paste encoder.
4. Composition cancellation removes only the local overlay.
5. The surrounding-text model is deliberately minimal because a terminal is
   not a conventional editable document.

Test Latin composition, CJK input methods, combining marks, emoji, dictation,
and autocorrection-disabled typing.

### 14.2 Hardware keyboard

Normalize UIKit presses into the same Ghosttea key model used by the browser:

- action;
- logical key;
- physical code where available;
- repeat;
- Shift, Control, Option/Alt, Command/Meta;
- keypad location where available.

The mapping layer must distinguish:

- text insertion from terminal key encoding;
- application commands from bytes sent to the remote shell;
- Option-as-Meta policy from text composition;
- system-reserved shortcuts from overridable terminal shortcuts.

Maintain shared key conformance vectors that specify the terminal modes,
normalized event, and expected output bytes.

### 14.3 Accessory keys

Provide a configurable keyboard accessory row for keys that are difficult on
a software keyboard:

```text
Esc  Tab  Ctrl  Alt  arrows  Home  End  PgUp  PgDn  |  ~  `
```

Accessory actions must enter the same normalized input path as hardware keys.
They must not write escape sequences directly from UIKit.

### 14.4 Mouse and pointer

Pointer and gesture behavior depends on the terminal's current mouse-tracking
mode:

- when tracking is active, translate pointer presses, releases, motion, and
  wheel gestures into Ghostty mouse events;
- when tracking is inactive, gestures control local selection and scrollback;
- support a modifier or explicit mode for forcing local selection while an
  application owns the mouse;
- keep coordinates in cell space after applying content insets and scale.

### 14.5 Selection and clipboard

Selection state belongs to the view. The iOS v1 controller has at most one
attached presentation, but the shared core and desktop can have multiple views
whose selections differ. Text extraction requests go to the native terminal
model so wide cells, wrapped rows, and grapheme boundaries use terminal
semantics.

Clipboard writes initiated by remote escape sequences require an application
policy. Default to denying or prompting for unsolicited remote clipboard
writes. User-invoked copy and paste remain direct actions.

### 14.6 Accessibility

Expose the visible terminal as an accessibility element with:

- row text from TRF1 accessibility or logical snapshot data;
- selected text;
- cursor row and column;
- session title and connection state;
- actions for copy, paste, scroll, reconnect, and focus.

Accessibility updates must be throttled and based on row changes, not emitted
per cell or per received byte.

---

## 15. Workspace parity

### 15.1 What is shared

React and SwiftUI cannot share implementation code directly. They can share a
behavioral model:

- split-tree shape;
- horizontal and vertical split semantics;
- focus-relative and focus-directional navigation;
- resize operations;
- equalize operation;
- zoom and unzoom behavior;
- close and replacement-focus rules;
- tab ordering;
- stable session and view identifiers;
- persistence schema.

### 15.2 Portable workspace schema

Define a versioned JSON model used for fixtures and optional restoration:

```json
{
  "version": 1,
  "selectedTabId": "tab-1",
  "tabs": [
    {
      "id": "tab-1",
      "workspace": {
        "version": 1,
        "root": {
          "kind": "split",
          "id": "split-1",
          "axis": "horizontal",
          "ratio": 0.5,
          "first": { "kind": "pane", "id": "pane-1", "sessionId": "session-1" },
          "second": { "kind": "pane", "id": "pane-2", "sessionId": "session-2" }
        },
        "activePaneId": "pane-1",
        "zoomedPaneId": null
      }
    }
  ]
}
```

Run identical mutation vectors against the TypeScript and Swift
implementations and compare the resulting normalized tree and focused pane.

The first Phase 7 slice implements and versions the per-tab payload. Its pane
leaves contain only node `id`/opaque `sessionId`, and its record carries
`activePaneId` and `zoomedPaneId`. The second slice embeds these payloads under
stable tab IDs and owns `selectedTabId`. Its reducer defines creation,
selection, wraparound traversal, clamped reordering, and deterministic close
replacement. Applying a pane mutation through the outer reducer is atomic: a
last-pane close closes its tab when another tab remains, a last-tab close asks
the host to close the window, and a split cannot duplicate a session already
owned by another tab. Neither layer adds live session metadata to the persisted
record.

### 15.3 Adaptive presentation

On iPad and external displays, expose desktop-like tabs and splits. On compact
iPhone layouts, the same workspace tree may present one focused pane at a time
with a pane switcher. This is presentation adaptation, not a change to the
underlying close, focus, or session semantics.

### 15.4 Command routing

Application commands such as new tab, split, focus direction, resize pane,
zoom, close, copy, and paste are handled before terminal key encoding. If no
application command matches, the event enters the terminal core.

The command identifiers should remain stable across desktop and iOS even when
their default key bindings differ.

The fourth Phase 7 slice assigns `ghosttea.workspace.*` identifiers to the
desktop command set and adds a platform-neutral Swift key-chord resolver with
the same semantics. Commands either become an atomic workspace reducer action
or an explicit host request for a new tab, split session, or remote-session
picker. The host must consult this resolver before passing an unmatched key to
the terminal encoder. A shared JSON fixture covers command/control/option/shift
combinations, payloads, and non-matches in both TypeScript and Swift.

---

## 16. SSH transport

### 16.1 Initial implementation

Implement the first-party SSH transport behind `TerminalTransport` only after
its stack passes the Phase 0 capability gate. The product-level SSH transport
must support:

- password, public-key, keyboard-interactive, and multi-step authentication;
- agent-like credential strategies supported by the application;
- required host-key verification;
- known-host storage;
- PTY allocation with terminal type, rows, and columns;
- shell and optional command sessions;
- ordered stdin/stdout/stderr handling appropriate for a PTY channel;
- window-change requests after resize;
- keepalive policy;
- cancellation and clean channel close;
- connection-state events;
- reconnect orchestration at a higher layer.

Phase 0 screening found that SwiftNIO SSH 0.14.1 and Citadel 0.12.1 do not
expose keyboard-interactive client authentication. A pinned libssh2 1.11.1 and
OpenSSL 3.5.7 candidate now builds and imports for all required Apple slices,
including the multi-prompt keyboard-interactive API. It is not selected for
production release, but Phase 0 selects its host-owned adapter architecture for
development. A 2026-07-17 review found newly disclosed pre-authentication
vulnerabilities affecting libssh2 through 1.11.1 while that version remains the
latest tag. The current artifact is therefore release-blocked; a fixed
immutable pin must incorporate the recorded upstream fixes and rerun every
compatibility/device gate before production approval. This does not block
parity implementation. Its opaque C shim and serialized
nonblocking Swift adapter pass
password, Ed25519 public key, two-round keyboard-interactive, and public key
followed by keyboard-interactive. The accepted partial key step returns `-19`
rather than a distinct partial-success result, so only the explicit chained
policy may attempt the second method; a wrong-key control remains rejected. The
same adapter passes strict host-key negatives, PTY allocation and resize, a
byte-exact 32 MiB stalled-reader fixture, and blocked-read cancellation. Its
candidate-only diagnostics expose raw encrypted socket, delivered, and written
bytes, socket waits, and libssh2 receive-window state. Socket-receive and
delivery counters remain unchanged throughout the forced 750 ms pause, ruling
out network or Swift-side prefetch before the exact drain.
The async challenge responder preserves server prompt text and echo policy while
the synchronous callback waits on a dedicated worker; informational and
multiple prompt rounds, exact nonempty protocol name/instruction metadata, and
cancellation pass. Passphrase-encrypted OpenSSH
Ed25519 keys pass and incorrect passphrases are rejected.
`GhostteaCredentials` stores opaque credential references in the device-only,
non-synchronizing data-protection Keychain, and its save/load/delete round trip
passes on a physical iPhone. The password path resolves Keychain bytes only when
authentication begins and deletes the item immediately after connection; that
path also passes the physical SSH fixture. The private-key path now resolves
opaque key/passphrase IDs only during authentication and passes counted key
bytes to libssh2's in-memory API. The OpenSSL backend derives the public key
without configured public-key bytes or a path. Unencrypted and encrypted
fixtures pass, a wrong passphrase is rejected, and no private-key file exists.
The encrypted private-key/passphrase path also passes on a physical iPhone
through opaque device-only Keychain items, with both items deleted before
command output is read. A continuous diagnostic host-key/authentication sheet
also passes the exact two-prompt, mixed-echo metadata fixture on a physical
iPhone; cancelling from that sheet unwinds the suspended responder and native
callback worker in 162 ms. Product authentication UI promotion,
representative-server sampling and complete minimum-device evidence remain
open. Physical Wi-Fi route-loss
cancellation completes in 23 ms and a fresh connection succeeds after Wi-Fi
restoration. Strict
host-key rejection and an async accept-once boundary for unknown/changed keys
pass with host, port, algorithm, SHA-256 fingerprint, and mismatch reason.
Accept-and-store uses a
mode-preserving atomic replacement and passes subsequent strict reconnects. A
physical iPhone persists an unknown key, warns before replacing a changed key,
and reconnects without another prompt. TCP establishment now uses a
cancellable nonblocking connector and the SSH handshake has a separate deadline;
a peer that accepts TCP without sending a banner proves deterministic handshake
timeout and cancellation. Hostnames resolve through Apple DNS-SD under the same
absolute connect deadline with 100 ms cancellation polling; package and live
`localhost` fixtures pass, both iOS SDKs build, and a signed iPhone resolves the
Mac's Bonjour hostname for a bounded SSH command. The adapter records negotiated
methods; the current fixture locks Curve25519, Ed25519,
ChaCha20-Poly1305, and HMAC-SHA2-256.
A second forced profile locks ECDSA P-256 and bidirectional AES-256-GCM under
strict known-host verification. A third locks an RSA-3072 host key to
RSA/SHA-2-512 rather than deprecated `ssh-rsa`. No stack-specific type may
escape the adapter.
Repeated cleanup stress passes 32 stalled-handshake cancellations and 16
suspended keyboard-interactive cancellations in one process. A
transport-neutral reconnect reducer and Network.framework observer now build
for iOS with explicit route, background, and stale-generation policy. The
physical iPhone passes automatic Wi-Fi-to-cellular teardown, explicit fresh
reconnect, background teardown, and foreground reconnect availability;
representative-server evidence remains open.

The same transport supports PTY shells and non-PTY commands. A live command
fixture preserves separate stdout and stderr and exit status 37. A second
fixture writes through `cat`, half-closes input, drains the exact output, and
completes the channel EOF/close handshake with exit status 0.
A third command terminates under `SIGTERM`; its result is preserved as
`.signaled(name: "TERM")` rather than collapsed into exit code zero.

Secrets and private keys belong in Keychain-backed storage and must never be
serialized into workspace restoration, logs, crash reports, or terminal
fixtures.

### 16.2 Session persistence

An SSH TCP connection may not survive background suspension or a network
change. Reliability should be layered:

```text
best:       attach to remote Ghosttea persistent session
good:       attach to tmux or zellij on the SSH host
fallback:   reconnect and start a new shell with clear status
```

The app must not imply that a disconnected ordinary shell remained alive.
Show explicit states: connecting, connected, reconnecting, suspended,
disconnected, authentication required, and failed.

### 16.3 Production Truffle shared-session transport

Shared-session mode is a required production path. The desktop demo remains
the session authority and publishes attachable sessions through its existing
host-owned Truffle node. The iOS application embeds the Swift products from
`p008/truffle/apple`; it does not launch the desktop sidecar.

The integration has two protocol layers with deliberately separate ownership:

```text
Truffle
  appId, device identity, interactive login, peer discovery, authenticated
  tailnet routing, connection lifecycle

Ghosttea terminal protocol
  session listing, view attachment, access capability, input/control epochs,
  logical snapshot/patch, selection, resize, detach, resynchronization
```

Both clients use Truffle app ID `ghosttea-terminal`. Persisted references use
Truffle's durable `deviceId`, never a generation-scoped `PeerRef`, hostname, IP
address, or Tailscale node key. On reconnect the app resolves the durable ID to
a fresh peer generation before dialing.

The desktop's current terminal protocol is `TSP1` version 1.3 over
Truffle-authenticated QUIC streams. The Apple Truffle package currently exposes
an authenticated full-duplex `MeshConnection`, but not that QUIC stream API.
The implementation must therefore add a transport binding without forking the
terminal semantics. The selected binding is a compact TCP mode on a dedicated
application port:

- one connection-control stream lists sessions and returns the host instance;
- one full-duplex attachment stream carries session control toward the host and
  typed logical state/control messages toward iOS;
- every connection is accepted only after Truffle/WhoIs identity succeeds;
- every attachment begins with the same protocol major/minor and nonce checks;
- message sizes retain the existing 1 MiB control and 16 MiB state limits;
- state sequence gaps cause an explicit snapshot request, never best-effort
  continuation;
- reconnect creates a new attachment and attachment epoch; no stale view,
  input sequence, control epoch, or resize sequence is reused.

This compact binding is an adapter around the existing `ConnectionMessage`,
`SessionControlMessage`, `StateMessage`, logical snapshot, and logical patch
contracts. It must have shared Rust/Swift conformance vectors. It does not
create an unrelated mobile synchronization protocol.

One session may have a visible desktop view and a visible iOS view at the same
time. Each owns selection and presentation state. The existing Ghosttea
controller election decides which view may send human input and authoritative
resize operations. Focusing the iOS terminal claims control with a fresh
control epoch; the desktop receives the corresponding control change. Read-only
attachments can observe and select text but cannot claim control.

Remote state is logical rather than TRF1. The desktop host owns VT parsing; iOS
applies snapshots and patches to `LogicalReplicaModel`, then produces local
TRF1 using the same bundled fonts and text engine. This avoids sending a
device-scale-specific glyph atlas over the network while retaining the desktop
model's exact cell/style/cursor semantics.

The first release requires:

- interactive Truffle login in the production app;
- peer and shared-session picker integrated into the workspace palette;
- attach, read-write input, control handoff, resize, selection, and detach;
- network-change and foreground reconnect with snapshot resynchronization;
- simultaneous desktop/iPhone and desktop/iPad tests against one live session;
- a test proving text entered on either controlling client appears in both
  views without duplicated input or divergent terminal revisions.

---

## 17. iOS lifecycle and state restoration

The application owns runtimes, terminal controllers, and transports. A
`UIScene` owns presentation attachment, selection, focus, and geometry. Scene
disconnection must not implicitly destroy an application-owned session.

iOS v1 prevents the same session from being presented in two scenes at once;
moving a session transfers its one presentation attachment. A future
multi-presentation release assigns a distinct view ID to each scene and reuses
the core's existing view and resize-authority model.

The iOS package enforces this boundary with generation-checked attachment
tokens. Attaching an already-presented session returns the superseded token and
installs a new current token; a delayed detach from the old scene is rejected
and cannot unbind the new owner. Scene phase changes produce visibility updates
only for that scene's current attachments. Disconnecting a scene removes its
presentation tokens but deliberately does not destroy the application-owned
sessions. App-wide suspension uses the aggregate of all connected scene phases:
one scene entering the background cannot suspend transport or GPU state while
another scene remains active.

### 17.1 Scene phases

#### Active

- consume transport bytes;
- batch terminal feeds;
- generate damage frames for visible views;
- run cursor animation and display link only when needed;
- accept input and resize changes.

#### Inactive

- stop accepting new UI gestures;
- stop or drain drawable submission;
- retain terminal and connection state briefly;
- avoid starting expensive new work.

#### Background

- submit no Metal work;
- request no render frames;
- persist non-secret workspace metadata;
- allow only explicitly supported background tasks;
- expect process suspension and connection loss.

#### Foreground restoration

- inspect transport state;
- reconnect or report disconnection;
- recreate evicted GPU resources;
- recompute geometry;
- request a full terminal refresh;
- restore focus only after the user activates the terminal.

### 17.2 Restoration data

Persist:

- workspace tree and selected pane;
- session profile identifiers;
- host aliases and usernames when allowed;
- font size, theme, and terminal preferences;
- remote tmux/zellij session name;
- last known title and directory as non-authoritative display hints.

Do not persist:

- raw passwords or private-key bytes;
- transient C/Rust handles;
- Metal resources;
- unbounded terminal byte history;
- stale claims that a connection is still live.

### 17.3 Whole-application memory policy

Mobile memory policy covers CPU and GPU state together:

- VT screen and scrollback state;
- logical snapshots and shaped-row caches;
- glyph bitmap caches and queued TRF1 frames;
- inbound and outbound transport buffers;
- Metal atlases, retained rows, and staging buffers;
- hidden and disconnected session controllers.

Each device tier defines a soft application budget, a hard safety bound, a
per-session initial scrollback byte budget, and a maximum number of resident
sessions. A memory warning applies this order:

1. stop requesting render frames for hidden presentations;
2. evict reconstructible Metal resources;
3. discard reconstructible frame, logical-snapshot, and row-shaping caches;
4. pause new transport reads while cleanup is in progress;
5. run full scrollback compression for inactive sessions, outside interactive
   latency-sensitive work;
6. trim inactive terminal scrollback if the native API supports it;
7. otherwise evict the least-recently-used detached session as a whole after
   retaining only reconnect or remote-reattach metadata;
8. preserve the active visible session unless the operating system terminates
   the process.

The current Ghostty shim sets the scrollback byte budget only during terminal
creation and has no trim call. Upstream VT does expose caller-driven full and
incremental page compression. Phase 0 measures resident and physical-footprint
curves before and after compression; Phase 1 or 2 must either add a tested trim
shim or explicitly rely on compression followed by whole-session eviction.

The initial Phase 0 policy defines a compact tier at 4 GiB physical memory or
less (four resident sessions, 3,000,000 scrollback bytes per session, 96/128
MiB soft/hard application bounds) and a standard tier above 4 GiB (eight
sessions, 5,000,000 bytes each, 160/224 MiB bounds). On an iPhone 14 Pro, the
standard scenario measured 44.6 MB with all sessions loaded, 30.5 MB with one
active plus seven compressed background sessions, and 28.5 MB after compressing
all sessions. Renderer, decoded-image, TRF1/cache, transport-under-load, and GPU
atlas categories remain future gates because the Phase 0 harness does not yet
contain those components.

---

## 18. Security and App Store considerations

1. All remote host keys must be verified; a first-use prompt must show a
   fingerprint and persist the decision explicitly.
2. Credentials and private keys use Keychain access controls. The initial
   concrete policy is `WhenUnlockedThisDeviceOnly`, no iCloud synchronization,
   and opaque connection UUID metadata; see
   `apple/GhostteaKit/Compatibility/credential-security-policy.md`.
3. Logs redact credentials, authentication payloads, environment values, and
   terminal contents by default.
4. OSC clipboard, hyperlinks, notifications, and file-like transfers are
   privileged host effects with explicit policy.
5. TRF1 decoders enforce size and bounds limits before allocation.
6. Terminal output is untrusted input. UTF-8, image data, URLs, titles, and
   clipboard requests must not bypass validation.
7. The app must not download and execute code that changes application
   functionality. Remote shell execution occurs on the remote host.
8. Background capabilities must be used only for their documented purposes,
   not to simulate indefinite general execution.
9. Third-party notices must include Ghostty and every linked native
   dependency. Artifact bundles retain licenses and an SBOM.
10. Any bundled font must have a redistribution license compatible with App
    Store distribution.

An App Store review note should explain that the app is an SSH/remote terminal,
that commands execute on user-configured remote machines, and that downloaded
terminal output is data rather than executable application code.

---

## 19. Native artifact and release pipeline

### 19.1 Required targets

Initial Apple artifacts:

```text
aarch64-apple-darwin       existing desktop target
aarch64-apple-ios          physical iPhone and iPad
aarch64-apple-ios-sim      Apple Silicon simulator
```

Add `x86_64-apple-ios` only if Intel simulator development remains a product
requirement.

### 19.2 Build stages

```text
1. verify pinned native/ghostty.lock.json
2. build GhosttyVt static libraries for device and simulator
3. build ghosttea-ffi static libraries for matching targets
4. run header/module-map validation
5. create XCFrameworks with xcodebuild
6. run symbol and architecture inspection
7. run Swift package device/simulator link tests
8. collect licenses, source pin, build metadata, and SPDX SBOM
9. zip artifacts deterministically
10. calculate SHA-256 and SwiftPM checksum
11. publish immutable versioned artifacts
```

The build records:

- Ghostty commit;
- Rust toolchain;
- Zig version;
- Xcode and SDK versions;
- deployment target;
- target triples;
- compiler flags;
- source and artifact checksums.

### 19.3 SwiftPM distribution

During repository development, `Package.swift` may reference local
XCFramework paths. A published package uses immutable release URLs and SwiftPM
checksums.

No package build step should silently download an unpinned latest artifact.
Offline and local-artifact overrides should mirror the existing
`ghostty-vt-sys` policy.

### 19.4 Compatibility policy

Version these layers independently:

- Swift package semantic version;
- Ghosttea C ABI version;
- TRF1 protocol version;
- workspace persistence schema;
- pinned Ghostty commit.

A Swift package release documents the exact supported combinations. A Ghostty
upgrade requires rebuilding parity fixtures and artifacts; it must not be a
floating dependency update.

---

## 20. Testing and parity program

### 20.1 Shared fixture format

Each terminal fixture contains:

```text
metadata.json        size, modes, font identity, scale, expected versions
input.bin            ordered terminal output bytes
actions.json         resize, key, mouse, paste, focus, and scroll actions
logical.json         expected normalized terminal state
frame.trf1           expected full or incremental frame sequence
reply.bin            expected terminal-generated transport bytes
```

Fixtures must cover chunking variations. Feeding the same bytes one at a time,
in random chunks, and as one buffer must produce the same final semantic state
and ordered replies.

### 20.2 Core test matrix

- ordinary text, control characters, wrapping, and reflow;
- primary and alternate screen;
- insert/delete lines and characters;
- scroll regions and scrollback;
- SGR colors and styles;
- cursor shapes, visibility, and blinking;
- wide characters, combining marks, emoji, and ZWJ sequences;
- ligatures and font fallback;
- title, cwd, bell, focus, and clipboard events;
- mouse tracking modes and alternate scroll;
- bracketed paste;
- legacy, CSI-u, and Kitty keyboard modes;
- device attribute and status replies;
- full damage, row damage, cache reset, and resynchronization;
- malformed and oversized input/frame handling.

### 20.3 Cross-platform conformance

Run the same fixtures through:

1. Rust host tests using `ghosttea-core`;
2. desktop `terminald` integration tests;
3. iOS Simulator through the C ABI and Swift wrapper;
4. Metal renderer snapshot tests;
5. TypeScript WebGPU or deterministic renderer snapshot tests where
   available.

Compare:

- transport replies byte-for-byte;
- normalized logical snapshots exactly;
- TRF1 protocol fields and sections exactly or through a documented
  normalization for platform-independent identifiers;
- glyph bitmaps exactly when font bytes, scale, and architecture match;
- rendered images using declared per-channel and geometry tolerances.

### 20.4 Workspace conformance

Keep language-neutral action vectors:

```json
[
  { "action": "split", "axis": "horizontal" },
  { "action": "focus", "direction": "left" },
  { "action": "resize", "direction": "right", "amount": 0.05 },
  { "action": "equalize" },
  { "action": "close" }
]
```

TypeScript and Swift must produce the same normalized tree, ratios, active
pane, and close result.

### 20.5 Real-application matrix

Before beta, manually and automatically exercise:

- interactive shells;
- Vim/Neovim;
- tmux and zellij;
- htop/btop;
- less and man pages;
- fzf;
- Git interactive commands;
- REPLs;
- Codex, Claude, and other agent TUIs used by the product;
- Unicode and IME-heavy applications;
- high-volume output and rapid resize.

Test on at least:

- current compact iPhone;
- current large iPhone;
- current iPad;
- iPad with hardware keyboard and pointer;
- 60 Hz and 120 Hz displays;
- simulator for deterministic CI coverage.

---

## 21. Observability and performance validation

Instrumentation is disabled by default and never adds per-cell callbacks.
Debug builds may record:

- bytes received and sent;
- feed batch size and wait time;
- VT update duration;
- snapshot, shaping, and frame-encoding duration;
- shared text-engine mutex wait and hold duration;
- shaping queue depth and per-session fairness under concurrent floods;
- TRF1 size and changed row count;
- FFI call duration and buffer copies;
- frame decode duration;
- atlas upload bytes and evictions;
- Metal command encoding and GPU duration;
- dropped/coalesced frames;
- time to first frame after foreground or reconnect;
- resident memory by terminal and atlas;
- reconnect attempt and result.

Use signposts so Instruments can correlate network input, native feed, frame
decode, and Metal submission.

Performance gates:

1. output floods do not block keyboard event encoding;
2. terminal state remains correct when frames are coalesced;
3. no continuous display-link activity while the terminal is unchanged;
4. backgrounding stops GPU submission;
5. repeated foreground cycles do not leak native handles, buffers, textures,
   tasks, or SSH channels;
6. mounting multiple panes shares appropriate GPU resources rather than
   creating a device per pane;
7. frame and glyph buffers have measured, bounded copy counts.
8. the declared number of concurrent resident sessions stays within the soft
   budget on the minimum supported device under sustained output;
9. memory warnings release reconstructible CPU and GPU state without corrupting
   the active terminal;
10. inbound flow control bounds client memory during an unbounded remote output
    stream without dropping the SSH connection.

---

## 22. Implementation plan

Effort ranges below are planning estimates for one engineer familiar with the
codebase. Renderer, IME, and network edge cases have the highest uncertainty.
Several phases may overlap once the shared core and ABI stabilize.

### Phase 0: parity contract and build proof

**Estimated effort:** 1 week

Deliverables:

- approve semantic, frame, and visual parity definitions;
- choose minimum iOS and Xcode versions;
- choose and verify redistribution rights for bundled fonts;
- build pinned `GhosttyVt.xcframework` for device and simulator;
- create a minimal Swift test target that creates a VT terminal, feeds bytes,
  reads a snapshot, and encodes a key;
- add the first shared VT and input fixtures;
- record actual binary size and link requirements.
- define and test pull-based `TerminalTransport`, a bounded ordered writer, and
  a replay transport;
- build a minimal SSH transport spike on device;
- verify password, public-key, keyboard-interactive, and multi-step
  authentication requirements;
- verify required host-key, cipher, and key-exchange algorithms against the
  launch server matrix;
- verify PTY allocation, resize, half-close, exit, cancellation, and inbound
  channel-window backpressure;
- select SwiftNIO SSH, another SSH stack, or funded missing-capability work;
- measure VT state and scrollback memory across representative sizes and
  session counts;
- set the initial device-tier memory and concurrent-session gates.

Current progress: the VT build/fixture/host-memory proof, host-neutral
transport package, and pinned three-slice libssh2/OpenSSL compile probe are
implemented. A checked-in SwiftUI harness now composes the native dependencies
behind one binary package target, builds unsigned for both arm64 simulator and
device SDKs, runs the VT proof and one/four/eight-session footprint probe, and
provides an SSH command plus explicit host-key confirmation UI. The nonblocking
libssh2 Swift adapter passes the pinned auth
matrix, strict host-key controls, PTY/resize, a byte-exact 32 MiB stalled-reader
fixture below its macOS RSS gate, no delivered-byte movement while demand is
paused, no raw socket consumption, receive-window/socket-wait diagnostics, and
blocked-read cancellation, including explicit chained MFA with its `-19`
return behavior locked under test. A
nonblocking TCP connector and separate SSH handshake deadline are implemented;
the local banner-blackhole fixture proves handshake timeout and cancellation.
The signed VT proof and raw one/four/eight-session footprint matrix pass on an
iPhone 14 Pro running iOS 26.5. The same device passes explicit host-key
confirmation including changed-key replacement and strict reconnect, password
and keyboard-interactive authentication, command execution, and output drain
against disposable fixtures. It also preserves separate stdout/stderr, exit 37,
typed `SIGTERM`, PTY allocation/resize, and byte-exact input half-close. The
measurements and command output are recorded in
`apple/GhostteaKit/Compatibility/ios-device-evidence.md`.
Representative-server transition execution, production authentication UI
promotion, representative DNS verification, compact-tier device execution,
renderer memory categories, the libssh2 security upgrade/revalidation, and
final bundled-font license review remain open. The implementation font set and
OFL-1.1 redistribution notices are now pinned; the standard-tier
active-transport memory gate is complete.
Encrypted OpenSSH Ed25519 keys now pass with the correct passphrase and reject
an incorrect one through both direct fixture and opaque resolver paths.
The opaque case uses libssh2's in-memory API and derives the public key without
configured public-key bytes or a path. The same encrypted-key/passphrase path
passes with device-only Keychain items on a physical iPhone, and deletes them
before command output is read. libssh2 is a candidate, not the selected SSH
path.
The diagnostic harness now accepts a pasted disposable private key and optional
passphrase through opaque Keychain IDs, clears its fields before connecting,
and builds for device and simulator SDKs. Its physical-device private-key run
passes; the production credential UI remains open.

Exit gate:

```text
The pinned libghostty-vt runs on a physical iOS device and simulator without a
full Ghostty fork, and the selected SSH path passes the launch compatibility
and inbound-flow-control matrix.
```

Optional parallel spike:

- run Termini or `libghostty-spm` on a device;
- document useful UIKit/Metal/lifecycle behavior;
- do not add it to production package dependencies.

### Phase 1: extract `ghosttea-core`

**Estimated effort:** 2-3 weeks

**Completed:** 2026-07-17. The dependency-clean `ghosttea-core` crate owns the
ordered `TerminalUpdate`/`TerminalEffect` contract, Ghostty model, logical
snapshots and patches, local and replica shaping/render caches, counters, and
TRF1 producers. Desktop `Session` is now a PTY adapter that executes returned
effects after releasing the model lock. Multi-view authority, per-attachment
input deduplication, and global human/automation input ordering are also
core-owned state machines; PTY queueing, process lifecycle, summary projection,
and frame broadcast remain host policy. A host operation gate serializes each
model mutation, its ordered effect execution, and encoded user input without
holding the model lock during PTY or broadcast work.

The final gate passed the complete Rust workspace and strict Clippy, JavaScript
lint, npm and Cargo package/consumer fixtures, daemon integration smoke test,
pre-extraction TRF1 golden, and the release terminal benchmark. At 0.25 workload
scale the benchmark produced two frames per rendering case, zero sequence gaps,
and a 0.122 ms control-RPC p99. No socket protocol or intentional TRF1 change was
introduced. Phase 2 may begin.

The embedding refactor has landed and passed its package and integration checks.
`native/terminald/fixtures/phase1/ansi-baseline.json` now freezes the
pre-extraction terminal reply, logical state, and exact TRF1 bytes across
whole-buffer, byte-at-a-time, and irregular input chunking. Its glyph sections
are intentionally empty until Phase 2 selects a bundled parity font. The Phase
1 prerequisite is satisfied; keep this golden as a permanent regression gate.

Deliverables:

- create the platform-neutral crate;
- move terminal state, logical snapshots, frame production, render caches,
  counters, and input encoding behind `TerminalModel`;
- express PTY writes as returned effects;
- make rendering demand-driven;
- adapt desktop `Session` to own the model;
- preserve current socket protocols and renderer path;
- retain and extend the byte-identical desktop TRF1 regression fixtures;
- retain automation ordering and view-authority behavior.

Exit gate:

```text
All desktop unit, integration, package, and benchmark checks pass, and the
extraction produces no intentional TRF1 or protocol change.
```

### Phase 2: explicit font resources

**Estimated effort:** 1-2 weeks

**Completed:** 2026-07-17. `ghosttea-text` now supports owned byte-backed font
resources, explicit style faces and ordered fallbacks, validated cell metrics,
and explicit raster scale. System discovery is labeled non-parity. The initial
parity bundle is locked to four JetBrains Mono Nerd Font styles plus Noto Color
Emoji from the pinned Ghostty source, with SHA-256 verification and OFL-1.1
notices. The macOS normalized geometry/bitmap golden passes, and the same crate
cross-compiles for `aarch64-apple-ios` and `aarch64-apple-ios-sim`. A narrow C
probe, unified native XCFramework, and Swift package resource wrapper now run
the fixture against identical font bytes. macOS and arm64 iPhone simulator
runtime output and the physical iPhone 14 Pro output match the desktop golden.
The cross-platform fixture exit gate is satisfied. Final font-license review
remains a release checklist item.

Deliverables:

- add byte-oriented font loading to `text-engine`;
- bundle an approved primary font and required fallback strategy;
- make metrics and raster scale explicit configuration;
- run the same shaping fixtures on macOS and iOS targets;
- document system-font mode as non-parity mode.

Exit gate:

```text
The same font fixture produces the same normalized shaping and glyph bitmap
results across supported Apple targets.
```

### Phase 3: C ABI and Swift core package

**Estimated effort:** 1-2 weeks

**Completed:** 2026-07-17. `ghosttea-ffi` is the versioned production boundary
over `ghosttea-core`. It returns ordered descriptors plus binary/JSON payloads
in one alignment-safe owned arena, copies borrowed font data at runtime
creation, contains panics, and permanently poisons the affected terminal or
shared runtime scope. Its operation surface includes model mutation, encoded
input, selection extraction, and accessibility rows. `GhostteaCore` provides
strong Swift lifetime ownership, immediate diagnostic copying, terminal-actor
serialization, and scoped no-copy payload access while sharing the Phase 2
font resources. The generated Apple artifact has macOS arm64, iOS arm64, and
iOS Simulator arm64 slices with ABI/toolchain/digest metadata.

The exact direct-Rust versus C-ABI fixture passes for replies, logical
snapshots, and TRF1 frames. C layout/malformed-argument tests, panic/poison
tests, strict Clippy, 100-iteration Rust and Swift ownership loops, and a macOS
AddressSanitizer run pass. Swift runtime parity passes on macOS and arm64 iPhone
Simulator; physical-device proof is retained in the Apple compatibility
evidence. Phase 4 may begin without exposing the upstream Ghostty or Rust ABI
to application code.

Deliverables:

- create `ghosttea-ffi` and generated or hand-maintained header;
- implement handle, error, buffer, feed, resize, refresh, and input APIs;
- preserve the core's ordered effects in the FFI update representation;
- implement selection-text and accessibility-row snapshot APIs;
- implement terminal-local and runtime-wide poison behavior;
- add panic containment and malformed-argument tests;
- create device and simulator XCFrameworks;
- create safe `GhostteaCore` Swift wrappers;
- test buffer ownership with sanitizers and repeated lifecycle loops;
- establish ABI and artifact version metadata.

Exit gate:

```text
Swift fixtures produce the same replies, logical snapshots, and TRF1 frames as
direct Rust fixtures with no leaks or ABI sanitizer findings.
```

### Phase 4: minimal Metal terminal

**Estimated effort:** 3-5 weeks

**Started:** 2026-07-17. The first decoder-only vertical slice is implemented
before any Metal allocation. The internal `GhostteaFrame` target mirrors the
desktop decoder's header, section table, and currently emitted payload types,
including strict UTF-8, count, pixel-length, reserved-field, and scrollbar
validation. It uses overflow-safe range arithmetic, bounds collection
reservations by the validated payload size, and retains zero-copy `Data` slices
of the bounded frame. Unknown section kinds remain skippable for forward
compatibility while the protocol version is unchanged.

The public `GhostteaTerminal` product currently exposes a renderer-readiness
inspection facade. Its macOS tests decode real TRF1 bytes returned through the
Phase 3 Swift wrapper, malformed fixtures mirror the desktop decoder suite, and
the same harness emits `GHOSTTEA_TRF1_PASS` in an arm64 iPhone Simulator. Both
iOS SDK destinations compile, and the signed iPhone 14 Pro runtime emits the
same pass marker.

The second slice adds atomic retained renderer state matching the desktop
worker's sequence classifier. It ignores stale frames, requests a full refresh
for gaps, non-full session changes, and missing initial snapshots, accepts full
recovery across layout/session epochs, clears catalogs at session or resync
boundaries, and applies monotonic row revisions. Full/incremental row arrays,
glyph/style catalogs, cursor, scrollbar, and clipboard effects transition only
after the complete frame validates; decode failures retain the last good state
and enter resync. The harness applies a Rust-produced full frame, incremental
frame, and duplicate stale frame on macOS and iPhone Simulator.

The third slice creates the Metal resource owner and bounded glyph atlases. A
single runtime owns its `MTLDevice` and command queue; separate alpha and
premultiplied-RGBA textures use deterministic one-pixel-gutter shelf placement.
Synchronization preflights the entire visible working set, resets only when it
will fit from empty, and rejects oversized or malformed pixel storage before a
partial upload. Production-core glyphs upload once and hit the cache with zero
bytes on the second synchronization. Five Metal tests pass on macOS, both iOS
SDK destinations build, and the arm64 iPhone Simulator executes the real Metal
texture path within the fixed 20 MiB atlas budget. At that checkpoint, render
passes, scheduling, lifecycle, and screenshot conformance remained Phase 4
work.

The fourth slice implements the first actual Metal render pass. Retained
style runs and glyph instances produce ordered buffers for backgrounds,
view-owned selection, alpha glyphs, premultiplied color glyphs, underline and
strikethrough decorations, and cursor. Geometry uses the desktop demo's 7.83 by
19 cell, two-point origin, style resolution, faint opacity, inverse colors, and
premultiplied blend factors. Non-finite or non-positive glyph geometry is
rejected before encoding. The bring-up renderer compiles its Metal source when
the renderer is created, targets an offscreen `rgba8Unorm` texture, reads the
completed pixels, and requires an identical retained frame to produce an
identical hash with no repeated atlas upload. Styled ANSI text and a color emoji
exercise all pipelines on macOS and arm64 iPhone Simulator. At this checkpoint,
runtime shader compilation, drawable presentation, scheduling, lifecycle, and
cross-platform screenshot goldens remained Phase 4 work.

The fifth slice adds the first public iOS presentation surface.
`GhostteaTerminalMetalView` subclasses `MTKView` with continuous drawing paused
and `enableSetNeedsDisplay` enabled. Accepted terminal frames, drawable-size
changes, view-owned selection/focus changes, and cursor blink state
request one draw; stale frames do not. Gaps or malformed input preserve the
last good state and invoke a full-refresh callback. Drawable command buffers
are presented without waiting on the main run loop, while the offscreen proof
continues to wait before reading pixels. Background notifications and memory
warnings discard pipelines and the 20 MiB atlas set but retain logical rows and
catalogs; foreground or explicit resume lazily reconstructs resources from
that retained state without another terminal frame. The simulator harness
proves frame classification and a 20 MiB to zero to 20 MiB suspend/resume
transition, and embeds the surface as a visible SwiftUI preview. Terminal-size
negotiation from safe-area geometry, multi-scene ownership, precompiled shaders,
and screenshot goldens remain.

The sixth slice establishes deterministic view-to-terminal sizing.
`GhostteaTerminalLayout` converts point-space bounds to `UInt16` columns and
rows using the desktop demo's 7.83-by-19 cell and two-point padding, clamps
degenerate and extreme inputs, and does not depend on display scale. The iOS
surface combines live safe-area insets with host-provided content insets and
uses the same effective top/left origin for Metal geometry, preventing PTY size
and rendered placement from diverging. Layout, safe-area, and drawable-size
changes emit a deduplicated grid callback; attaching a callback after layout
immediately reports the current grid. The host controller, not the view, will
sequence that callback into core resize and SSH PTY resize effects. Pure tests
cover exact desktop geometry, degenerate bounds, and representative portrait
and landscape safe areas. The simulator harness observes 49-by-39 portrait and
92-by-19 landscape callbacks. Controller-side resize serialization and a real
device rotation gesture remain before this gate is fully production-integrated.

The seventh slice adds `GhostteaResizeCoordinator`, an actor that owns the
host-side resize transaction. It coalesces geometry bursts to the newest
pending grid, sends SSH PTY resize before mutating the terminal model, advances
the core layout epoch, requests a full TRF1 frame, and suppresses commits from
sizes superseded while I/O was in flight. If core resize fails after PTY resize,
it attempts to restore the last committed PTY dimensions and reports both the
primary and rollback failures. The Metal view exposes a convenience binding;
the controller's commit handler remains responsible for applying the returned
frame. Tests use the production core and replay transport to prove ordering,
full-frame dimensions, burst coalescing, stale-frame suppression, and rollback.
Real SSH rotation and disconnect-during-resize remain integration gates.

The eighth slice moves cursor timing into the iOS surface while preserving the
desktop worker's state machine. A one-shot 600 ms task toggles and reschedules
only while the surface is visible, the terminal is focused, and the current
cursor is both visible and blinking. Cursor changes, explicit input activity,
focus restoration, and visibility restoration reset the cursor to visible;
unchanged frames do not postpone the pending blink. Backgrounding, GPU
suspension, view detachment, and host-reported scene occlusion cancel the task,
and restoration schedules from a visible cursor without enabling continuous
Metal drawing. Pure main-actor tests cover timing, toggles, resets, hidden and
static cursors, focus, and visibility. Multi-scene controllers must still call
the surface visibility API as individual scenes activate and deactivate; the
eleventh slice below provides the ownership and aggregate lifecycle primitive.

The ninth slice removes runtime Metal compilation. A local SwiftPM build-tool
plugin invokes the pinned Xcode Metal compiler, links a target-specific
`GhostteaTerminal.metallib`, and declares the AIR and library files as package
resources. The `.metal` source is excluded from implicit target processing so
there is one compilation path on macOS, iOS Simulator, and iOS device builds.
The renderer requires the packaged library URL and has no source-string
fallback. Tests load the library, require the complete five-function catalog,
and execute the existing deterministic pixel proof. The simulator harness runs
the full TRF1/Metal automation with only the plugin library in the bundle.

The tenth slice establishes the initial screenshot-conformance suite without
claiming impossible raw equality across all GPU families. The reproducible
`phase4-styled-unicode-v1` fixture records an exact reference pixel hash plus a
96-by-64 horizontal/vertical perceptual edge map, mean RGBA channels, and
non-background pixel count. Its checked-in JSON declares maximum edge Hamming,
channel, and content-count deltas. Tests require exact macOS output, prove an
erased terminal fails the tolerant comparison, and expose a recorder executable
for intentional golden updates. The independently compiled iOS Simulator
library currently produces the exact reference hash and zero differences.
Physical-iPhone and desktop-WebGPU comparisons remain before visual parity is
complete.

The eleventh slice establishes iOS v1 scene ownership. The
`GhostteaSceneAttachmentRegistry` actor permits one current presentation token
per terminal session, transfers authority explicitly, rejects stale detaches by
generation, and reports visibility only for currently attached presentations.
`GhostteaSceneLifecycleState` reduces all connected scenes to active, inactive,
or background, so one WindowGroup instance cannot globally suspend an app-owned
session while another remains active. The harness uses that aggregate for its
global SSH/session lifecycle and passes each scene's own visibility directly to
its Metal surface. Three tests cover transfer, stale-detach rejection,
scene-disconnect semantics, and the two-active-scenes background transition.
The complete 56-test package suite, both iOS SDK builds, and iPhone Simulator
TRF1/Metal automation pass. Physical Stage Manager transfer/disconnect gestures
remain release evidence rather than an implementation blocker.

Deliverables:

- strict Swift TRF1 decoder;
- Metal pipelines for backgrounds, alpha glyphs, color glyphs, decorations,
  selection, and cursor;
- retained rows and incremental replacement;
- glyph atlas allocation and reset;
- scale, resize, safe-area, and rotation handling;
- event-driven scheduling;
- foreground/background GPU lifecycle;
- initial screenshot conformance suite.

Exit gate:

```text
Recorded terminal fixtures render interactively on iPhone and iPad with frame
sequencing, resize, cursor, colors, Unicode, and device lifecycle working.
```

### Phase 5: production input surface

**Estimated effort:** 2-4 weeks

**Implementation complete:** 2026-07-17. Device-matrix evidence remains open.
The first slice establishes the hardware-key parity
boundary without putting terminal escape sequences in UIKit.
`GhostteaHardwareKeyEvent` converts Apple USB HID usages to the same DOM-style
physical codes used by the desktop client, preserves the unmodified layout
codepoint, distinguishes down/repeat/up, and strips UIKit's private-use arrow
characters from text input. `GhostteaTerminalInputEncoder` routes terminal keys
through the shared `GhostteaCore.encodeKey` implementation and owns the small
application-binding layer above it: Command word/line editing, clipboard and
workspace shortcuts, plus configurable Option-as-terminal or Option-as-natural
word motion. Bound key-up events are suppressed rather than leaking a second
terminal event.

`GhostteaTerminalMetalView` is now a tap-focusable first responder and forwards
hardware `UIPress` events through a host decision callback. It tracks pressed
HID usages to synthesize repeat actions and calls UIKit's responder chain for
keys the host declines. Resigning first responder synthesizes key-up events for
handled held keys, matching desktop blur behavior. Two tests prove common
HID/DOM mappings, layout identity, non-text special keys, shared Ghostty bytes for letters, Ctrl-C and
arrows, desktop-compatible Option motion, Command-paste routing, key-up
suppression, committed Unicode, and terminal paste encoding. Software keyboard
and `UITextInput` marked-text composition were the next slice.

The second slice makes `GhostteaTerminalMetalView` a native `UITextInput`
surface without presenting terminal scrollback as an editable UIKit document.
Its document contains only transient marked text, UTF-16 selection, and the
geometry UIKit needs for the active composition. Marked text stays local until
unmark/commit, is rendered as a cursor-anchored overlay, and supplies matching
caret and candidate-window rectangles. Composed-character deletion and range
queries keep emoji and combining sequences intact.

Committed text becomes ordered `GhostteaSoftwareInputEvent` values. Plain
Unicode remains byte-exact UTF-8; Return and backward delete go through the
same Ghostty key encoder as hardware keys; paste goes through the same
terminal-mode-aware paste encoder and therefore respects bracketed-paste mode.
CR, LF, and CRLF are normalized into one Return event each. UIKit smart quotes,
smart dashes, smart insertion/deletion, autocorrection, spell checking, and
autocapitalization are disabled at the terminal boundary. The simulator gate
drives the production view directly through `setMarkedText`, `unmarkText`,
`insertText`, and `deleteBackward` and checks the ordered committed events,
marked-state lifetime, caret geometry, and safe input traits. Physical CJK,
combining-mark, emoji, dictation, and third-party-keyboard evidence remains in
the Phase 5 interaction matrix rather than being inferred from simulator APIs.

The third slice implements the configurable accessory row as a horizontally
scrollable native `inputAccessoryView`. Its default keys are exactly
`` Esc Tab Ctrl Alt ← ↓ ↑ → Home End PgUp PgDn | ~ ` ``. Ctrl and Alt are visible
one-shot latches. The next supported software-keyboard character, Return,
backward delete, or accessory key is converted to a normalized hardware-key
event and consumes the latch; starting marked-text composition or losing focus
clears it. Pipe, tilde, and backquote preserve their physical HID key and
intrinsic Shift state. The row contains no terminal bytes: every action still
passes through `GhostteaTerminalInputEncoder`, including the configured
Option-as-terminal versus natural word-motion policy.

The fourth slice establishes the pointer boundary below UIKit gestures. The
retained TRF1 state now preserves the application mouse-tracking flag, and a
typed press/release/motion event converts to the existing
`GhostteaCore.encodeMouse` API. The Metal view normalizes local points into
clamped viewport cells and desktop-compatible screen, rounded cell, and
safe-area/content-padding geometry. Routing matches desktop: an application
with mouse tracking owns unmodified pointer input; otherwise selection stays
local, and an explicit Shift/force-local override wins. An exact SGR packet test
proves the shared Ghostty encoder remains the only source of mouse bytes.
Gesture recognizers, momentum/wheel accumulation, absolute scrollback
selection, and native selection-text extraction remain the next pointer slice.

The fifth slice adds the UIKit interaction layer. Indirect-pointer pan emits
normalized left press/motion/release when the application owns the mouse, while
hover emits tracking motion without a pressed button. Shift and the explicit
force-local mode override application tracking. Direct touch uses a long-press
selection gesture rather than sending accidental remote clicks. Wheel input
ports desktop's 2× precise-device multiplier and retained sub-row remainder;
tracking mode emits at most 12 wheel packets per update, while local mode asks
the host to mutate native scrollback and apply its returned frame.

Selections are view-owned in absolute scrollback coordinates and are clipped
to viewport coordinates only for Metal rendering, so a later scroll frame does
not detach the highlight from its rows. Change and commit callbacks remain
effects rather than view-owned I/O. The harness routes commits to native
`selectionText`, and routes mouse and scroll through the same terminal actor as
keyboard input. Zero-length clicks clear selection. Word/line expansion,
selection-edge autoscroll, secondary-button context menus, and physical pointer
ergonomics remain later Phase 5 work.

The sixth slice closes the remaining selection behaviors already present in
the desktop demo. A local drag held outside the top or bottom edge starts a
cancellable 40 ms, one-row native scroll request. Each returned TRF1 scrollbar
frame advances the absolute selection focus at that edge; completion,
backgrounding, or responder loss cancels the task. A secondary indirect-pointer
click presents a UIKit edit menu with Copy, Select All, and Paste. Copy and
non-empty drag completion remain host effects that use native selection-text
extraction. Select All constructs the full absolute range for rendering and
invokes the native `select_all` extraction path. The diagnostic host alone owns
the resulting clipboard write. Word/line expansion is not claimed here because
the current desktop demo does not implement it either.

The seventh slice completes the planned accessibility implementation. Retained
TRF1 state now consumes the producer's dedicated accessibility-text rows and
publishes a platform-neutral snapshot containing viewport and absolute
scrollback coordinates. The Metal surface exposes one frequently-updating
static-text `UIAccessibilityElement` per visible row instead of asking VoiceOver
to infer text from glyphs or presenting terminal scrollback as an editable
UIKit document. Row frames follow the same safe-area-aware cell geometry as
rendering. Container page-scroll actions return live-grid row deltas to the
host, Escape releases terminal focus, and Copy, Select All, and Paste remain
explicit host-mediated actions. SwiftUI does not flatten the native row tree.

The complete 64-test package suite, both iOS SDK builds, and iPhone 17 Pro
simulator automation pass, including native accessibility text, stable absolute
row identifiers, live-grid paging, and the action catalog. This completes the
Phase 5 code deliverables and shared conformance vectors. The exit gate remains
open until physical VoiceOver navigation, announcement pacing under output,
IME/software keyboards, hardware keyboards, pointer ergonomics, and mouse-aware
TUIs complete the agreed device matrix.

Deliverables:

- `UITextInput` integration and marked-text overlay;
- hardware keyboard normalization;
- configurable Option/Meta behavior;
- accessory key row;
- pointer, mouse tracking, gestures, scrollback, and local-selection override;
- terminal-aware selection and clipboard actions;
- accessibility row model and actions;
- shared input conformance vectors.

Exit gate:

```text
Software keyboard, hardware keyboard, IME, selection, mouse-aware TUIs, and
VoiceOver complete the agreed interaction test matrix.
```

### Phase 6: SSH and reconnectable sessions

**Estimated effort:** 2-3 weeks

**Started:** 2026-07-17. The first slice creates a separate
`GhostteaSession` Swift package above `GhostteaCore` and
`GhostteaTransport`. The actor owns generation-checked connection and read
tasks, consumes the Phase 0 reconnect model, and never silently reconnects.
Route changes and background/explicit teardown finish before the replacement
state is published, while late completions from invalidated generations are
ignored.

The session pulls bounded inbound chunks and awaits each ordered core effect,
so terminal processing and host event delivery propagate demand back to the
transport instead of creating an unbounded inbound stream. Native terminal
replies and encoded user input share one bounded sequenced writer under a host
operation gate. The same gate serializes PTY-before-core resize and its full
TRF1 frame. State snapshots retain clean exit or redacted failure descriptions
and expose idle, waiting, connecting, connected, reconnect-available,
suspended, and failed policy states without exposing libssh2.

Four replay tests prove chunked inbound drain, a native cursor-position reply,
clean exit status, ordered raw/shared-core input, PTY/core resize, route-change
teardown, explicit reconnect, generation advance, and redacted
non-reconnectable operation failure. The full Swift package suite now contains
73 tests. The second slice adds production `GhostteaSSHConfiguration`,
`GhostteaSSHTransport`, and `GhostteaSSHSessionFactory` entry points over the
Phase 0-selected implementation. It resolves password/private-key credentials
from the device-only Keychain at authentication time, prepares an app-private
known-host directory with complete iOS file protection, redacts native failure
messages, and classifies authentication, host-key, credential, and invalid
remote-command failures as requiring user action. Shell, tmux attach-or-create,
and Zellij attach-or-create profiles allocate a PTY and shell-quote the session
name. The package suite and complete harness pass for macOS, arm64 simulator,
and physical-device SDK compilation. Production UI binding, chained
credential-backed public-key MFA, and live TUI/device gates remain later Phase
6 slices.

The third slice binds the production factory into the iOS harness as a real
terminal surface rather than another byte-oriented SSH diagnostic. Connection
state and TRF1 frames flow from `GhostteaSession` into the Metal view;
hardware/software keys, paste, mouse input, scroll, and native selection route
back through the session/core boundary. Aggregate scene suspension and network
path changes are forwarded to the same generation-safe actor. Shell mode is an
automatic end-to-end gate that emits styled fixture output, waits for typed
exit, then verifies the marker through the core's native accessibility rows.
tmux and Zellij profiles expose the same surface as long-lived interactive
sessions. `npm run test:ios:production-session` builds and installs the signed
app, starts the disposable fixture, performs fixture-scoped host-key trust, and
uses the app process exit status as the physical-device result. Package tests
and both iOS SDK builds pass. The automatic runner also passes on the physical
iPhone 14 Pro: the signed app reports the production-session marker after
native accessibility validation and exits zero, after which the runner removes
the fixture. Interactive tmux/Zellij and representative TUI gates remain.

The fourth slice adds `npm run test:ios:production-tmux`, a deterministic
physical-device tmux gate over the same production path. The signed app attaches
or creates a named session with a 100x30 PTY, observes the default tmux pane at
100x29 through native accessibility rows, orders a PTY/core resize to 120x40,
observes the pane at 120x39, injects an acknowledgement through the shared
writer, and requires typed exit zero. Exact contiguous markers avoid treating
the echoed probe command as output. The gate passes on the physical iPhone 14
Pro and cleans up its disposable fixture. Live Zellij and representative
Vim/Neovim, htop/btop, and agent-TUI gates remain.

The fifth slice adds `npm run test:ios:production-vim`, a deterministic
physical-device Vim gate over the production interactive session. It launches
the fixture's configuration-free minimal Vim, validates its seed buffer through
native accessibility rows, reads the remote PTY dimensions from inside Vim,
orders a resize from 100x30 to 120x40, edits the buffer through terminal key
input, and requires typed exit zero. Building this gate exposed and fixed an
interactive full-duplex defect: an idle read had held the connection operation
gate across socket polling and starved outbound input. Reads now serialize only
the libssh2 attempt, release the gate while polling the raw socket, and retry
under serialization. A disposable live regression starts the idle read first
and proves the concurrent write completes; the full SSH matrix and the signed
iPhone Vim gate pass. Live Zellij, htop/btop, and agent-TUI gates remain.

The sixth slice adds `npm run test:ios:production-zellij`, a deterministic
physical-device Zellij gate using checksum-pinned official 0.44.3 no-web
binaries in the disposable fixture. The signed app attaches or creates the
named session with a 100x30 outer PTY, validates Zellij's 98x26 shell pane
through native accessibility rows, orders a PTY/core resize to 120x40, and
requires the pane to reach 118x36. It sends an acknowledgement through the
shared writer and requires typed exit zero. A bounded automation-only startup
delay accounts for the SSH channel becoming connected before Zellij creates
its first pane. The full package and SDK build matrix and the signed iPhone 14
Pro gate pass. Live htop/btop and representative agent-TUI gates remain.

The seventh slice adds `npm run test:ios:production-monitor-tuis`, a combined
physical-device htop and btop gate with exact fixture package pins. htop renders
at 100x30, exposes its help overlay through native accessibility rows, handles
an ordered PTY/core resize to 120x40, dismisses help, and exits through distinct
key events. btop then renders at 120x40, exposes its menu overlay, handles the
reverse resize to 100x30, and exits normally. Shell markers after each TUI
prove the remote PTY reached the requested dimensions, and typed exit zero is
required. The full package and SSH matrices, both iOS SDK builds, and the
signed iPhone 14 Pro gate pass. Representative agent-TUI interaction remains.

The eighth slice adds `npm run test:ios:production-claude`, a deterministic
physical-device agent-TUI gate using the real Claude Code 2.1.214 CLI. The
disposable SSH fixture pins the CLI version and Node base, verifies both the
binary and its loopback-only mock Anthropic endpoint at startup, and supplies a
fixture-only token through Claude Code's documented gateway contract. Demo mode
and nonessential-traffic controls remove onboarding, updates, telemetry, and
credential requirements without replacing the application under test. The
signed app validates Claude Code's versioned main view, submits and receives a
streamed response, interrupts a deliberately held stream with Escape, opens its
shortcuts overlay, orders a PTY/core resize from 100x30 to 120x40, and exits
through `/exit`. Native accessibility rows and the final remote `stty size`
marker prove each rendered state and the resize; typed exit zero is required.
All 73 package tests, both iOS SDK builds, and the signed iPhone 14 Pro gate
pass. This completes the planned representative application set for Phase 6;
release certification across more devices, servers, and application versions
remains a Phase 8 responsibility.

Deliverables:

- the SSH transport selected by the Phase 0 compatibility gate;
- host-key verification and known-host storage;
- Keychain-backed credentials;
- PTY allocation and resize propagation;
- ordered terminal-response writes;
- connection-state UI;
- cancellation, reconnect, and suspension behavior;
- tmux/zellij attach profiles;
- deterministic shell, multiplexer, editor, monitor-TUI, and agent-TUI device
  compatibility gates;
- network transition and background/foreground tests.

Exit gate:

```text
Vim, tmux, htop, shells, and agent TUIs remain correct through resize, network
change, suspension, reconnection, and explicit disconnect scenarios.
```

### Phase 7: workspace parity

**Estimated effort:** 2-4 weeks

**Completed:** 2026-07-18. All stated model, conformance, adaptive SwiftUI,
command, multi-session SSH, protected restoration, palette, and saved-profile
deliverables pass the shared tests, both generic iOS builds, and the signed
iPhone workspace gate. The identity-only persistence contract satisfies the
phase exit gate without restoring secrets or stale live-connection claims.

**Started:** 2026-07-18. The first slice adds a version-1, per-tab pane-tree
document and pure reducers to both `@vibecook/ghosttea-react` and the new
`GhostteaWorkspace` Swift product. The persisted shape contains only node IDs,
opaque session IDs, axes, ratios, active pane, and zoomed pane. It cannot encode
credentials, hosts, commands, cwd/title metadata, or a live connection claim.
Desktop persistence now writes this identity-only shape while retaining a
one-way reader for the previous full-`SessionSummary` format; restoration
resolves opaque IDs only against sessions that are currently present, collapses
stale branches, and repairs stale active/zoom references.

One shared JSON fixture drives both implementations through nested horizontal
and vertical splits, geometry-based directional focus, relative focus, deepest
matching-axis resize, ratio clamping, equalization, zoom focus suppression,
pane collapse, replacement focus, terminated-session output, and the final
close-window result. All 46 React package tests and all 77 Swift package tests
pass. This establishes the per-tab mutation/persistence boundary.

The second slice adds the version-1 outer tab collection to both implementations.
It stores stable tab IDs, a selected tab ID, and the existing per-tab documents;
validates tab and session uniqueness across the whole window; restores only
tabs with live sessions; and defines identical create, select, wraparound,
reorder, close, and pane-action routing. A second shared fixture verifies tab
order, replacement selection, ordered session-close output, and the sole-tab
close-window result. The resulting totals are 50 React package tests and 80
Swift package tests. Adaptive iPad/iPhone presentation, application command
routing, and connection-profile integration remain later Phase 7 slices.

The third slice adds `GhostteaWorkspaceUI` as a separate SwiftUI product over
the portable model. Regular horizontal size classes render the selected tab's
recursive split tree at its model ratios; compact size classes retain that same
tree but mount only the active pane and expose a pane switcher. Zoom mounts one
pane in either mode, and compact zoom presents an explicit exit rather than
allowing hidden focus changes. The view emits reducer actions and receives pane
content through a closure, so it does not own terminal, transport, credential,
or session objects. A pure presentation snapshot makes selected-tab, visible-
pane, focus, compact, and zoom behavior testable without UI introspection.
The complete Swift package now passes 83 tests, and the UI product builds for
generic physical iOS and iOS Simulator destinations. Application command
routing and connection-profile integration remain later Phase 7 slices.

The fourth slice adds stable `ghosttea.workspace.*` command IDs plus matching
TypeScript and Swift shortcut resolution. Swift routes commands either to the
outer reducer or to explicit host requests for session-producing operations,
keeping new-tab and split identity allocation out of the pure model. Shared
vectors verify that application shortcuts are claimed consistently and that
unmatched keys remain available for terminal encoding. The resulting totals
are 51 React tests and 85 Swift tests, with physical-iOS and simulator builds
passing. Wiring this resolver to the production iOS input host,
connection-profile integration, and the command palette remain later Phase 7
slices.

The fifth slice installs that contract in the production iOS harness input
host. A reusable press-state component binds a recognized HID usage from
key-down through key-up, dispatches its workspace command exactly once, and
suppresses repeats; unmatched chords retain the existing UIKit/terminal path.
The live SSH session now creates an identity-only one-tab/one-pane workspace
and mounts its real Metal terminal surface through `GhostteaWorkspaceView`.
Closing the sole pane or tab follows the model's close-window result and
disconnects the session. Session-producing new-tab and split routes remain
explicitly unavailable until the multi-session factory lands rather than
duplicating a live session handle or inventing transport ownership in the UI.
The complete harness builds for generic device and simulator targets.
The full Swift package passes 86 tests, and the signed iPhone 14 Pro production
gate passes its SSH, shared-core, TRF1, native-accessibility, Metal, and typed
exit checks with the live surface mounted through the workspace view.

The sixth slice adds `GhostteaWorkspaceSessionCoordinator`, a transport-neutral
actor that turns the outstanding new-tab and split host requests into a safe
session lifecycle. Its async allocator must return a genuinely independent
opaque session and ID before the model transition commits. Invalid or duplicate
allocations are terminated immediately and leave the document unchanged.
Successful close transitions remove and terminate exactly their ordered
`closedSessionIds`; closing the whole window drains remaining sessions in
workspace order and permanently closes the coordinator. The coordinator
validates that its initial live registry exactly matches the identity-only
document, preventing restoration from manufacturing a live-session claim.
The complete Swift package passes 89 tests and both generic iOS builds.
At that checkpoint, concrete SSH allocation remained the next integration step.

The seventh slice adds `GhostteaSSHWorkspace`, the concrete coordinator
allocator. A single immutable SSH configuration and native runtime may be
shared, but every tab or split receives a unique native terminal handle,
`GhostteaTerminal`, `GhostteaSession`, opaque session ID, routed event stream,
and explicit disconnect path. The iOS host now keeps a session-ID keyed resource
and frame registry, routes hardware/software/pointer/selection input to the
correct pane, propagates path and app lifecycle changes to every live session,
and rejects late events from retired panes. New-tab and split requests are
transactional coordinator operations and are available from both shared
hardware shortcuts and touch controls. The complete Swift package passes 92
tests, and the integrated app builds for both iOS SDK variants. The signed
iPhone 14 Pro gate creates three concurrent SSH sessions, validates distinct
native-terminal output for handles 606, 607, and 608, then passes exact pane,
tab, and window teardown checks.

The eighth slice adds `GhostteaConnectionProfiles`, a versioned SSH connection
recipe and atomic protected JSON store. Profiles contain ordinary connection
metadata and shell/tmux/Zellij attach intent, while password, private-key, and
passphrase cases contain only typed opaque Keychain references. Credential-kind
confusion and cross-connection key/passphrase references are rejected, and a
keyboard-interactive profile requires a fresh runtime responder rather than
persisting challenge answers. `GhostteaWorkspaceRestorationDocument` binds each
persisted session ID to exactly one opaque profile ID; it contains neither
secrets nor connection metadata and does not claim that any session is live.
The restore path allocates a new terminal and SSH transport for each available
profile, retains the stable workspace session ID, assigns a fresh native handle,
then collapses failed allocations through the existing restoration reducer.
The complete Swift package passes 99 tests and both iOS SDK builds. The signed
iPhone 14 Pro gate resolves the fixture through a profile, creates three
profile-bound sessions with fresh handles 606, 607, and 608, verifies a
secret-free three-binding restoration manifest, observes independent terminal
output, and passes exact teardown. Product-level profile selection and loading
the persisted documents during app launch remain later Phase 7 work.

The ninth slice implements the reusable app-launch half of that remaining
lifecycle. `GhostteaWorkspaceRestorationStore` atomically persists the versioned
manifest with complete file protection on iOS. `GhostteaWorkspaceRestorer`
attempts allocations sequentially in workspace order, records and collapses
ordinary per-session failures, and terminates all completed allocations on task
cancellation. The SSH adapter resolves each saved profile into a fresh terminal
and transport, preserves only the stable workspace session ID, and defaults to
demand-paused resources so restoration never silently reconnects. Its result is
the exact live registry required by `GhostteaWorkspaceSessionCoordinator`.
The complete Swift package passes 103 tests and both iOS SDK builds. The signed
iPhone 14 Pro gate writes and reloads both protected documents, recreates all
three stable IDs into paused handles 706, 707, and 708, initializes and closes a
coordinator from that registry, then completes the existing connected
606/607/608 output and teardown proof. Product profile-selection UI and wiring
these stores to the eventual app scene entry point remain later Phase 7 work.

The tenth slice adds the product-facing commands-and-connections palette. Its
portable snapshot model deduplicates stable entry IDs, tokenizes and folds
queries, ranks title matches ahead of subtitle and keyword matches, preserves a
valid selection across filtering, and wraps keyboard navigation. Typed
invocations distinguish existing workspace commands from opaque saved-profile
requests, keeping transport allocation and credentials in the host. The SwiftUI
surface mirrors the desktop remote-session palette with immediate search,
selected-row feedback, touch activation, Up/Down navigation, Return activation,
and Escape or Command-Shift-O dismissal. Command-Shift-O now toggles the sheet,
and a touch button makes it available without a hardware keyboard. The complete
Swift package passes 105 tests and both iOS SDK builds. The signed iPhone 14 Pro
gate requires the disposable saved profile to win a multi-token search before
creating its second live tab, then passes the durable 706/707/708 restoration
and connected 606/607/608 output/teardown gates. A real product scene and profile
editing UI remain later work; the reusable Phase 7 palette boundary is complete.

The eleventh slice adds reusable saved-connection management. A non-secret
`GhostteaSSHConnectionProfileDraft` owns editable metadata, while a separate
one-shot credential submission carries password, private-key/passphrase, or
keyboard-interactive intent. `GhostteaSSHConnectionProfileRepository`
serializes profile and Keychain mutations: replacement secrets receive fresh
opaque IDs, profile-persistence failure rolls new items back, and successful
replacement or deletion reports any old-item cleanup debt for retry. The
`GhostteaConnectionProfilesUI` product supplies list, add, edit, and delete
surfaces; after successful validation its editor clears all transient secret
properties before invoking the host callback. Swift and Security may copy these
buffers, so the boundary reduces lifetime without claiming zeroization. The
command palette exposes a typed Manage Saved Connections route, while the
diagnostic harness intentionally validates and releases submitted secrets
without becoming a user credential store. The complete Swift package passes
110 tests and both iOS SDK builds. Product scene composition can inject this
view and the repository without coupling either to terminal/session ownership.

Deliverables:

- versioned workspace model;
- Swift split-tree mutations;
- TypeScript/Swift conformance vectors;
- iPad tabs and splits;
- compact iPhone pane presentation;
- focus, resize, equalize, zoom, and close commands;
- restoration and connection-profile integration;
- command palette and keyboard shortcuts.

Exit gate:

```text
Desktop and iOS workspace conformance tests agree, and restored workspaces do
not restore secrets or stale live-connection claims.
```

### Phase 8: production iOS application and Truffle continuity

**Estimated effort:** 3-5 weeks

Phase 8 turns the reusable package work into the actual Ghosttea iOS product
and makes cross-device session continuity a release gate. The diagnostic
`GhostteaHarness` remains a fixture runner and is not promoted into the app.

**Started:** 2026-07-18. The first slice adds the `GhostteaTruffle` Swift
product against the real sibling Apple package at locked revision
`071264b02a2ee81bac3fb4255e40842e7af464fe`. It defines durable host/session
references, generation-checked peer resolution, the shared app/service IDs,
and byte-compatible `TSP1` connection-control framing. A typed client completes
the nonce handshake and lists desktop sessions over Truffle's
`MeshConnection`. Six initial tests include an end-to-end loopback connection and
a connection-control fixture consumed by both Swift and Rust; all initial 116 package
tests, the Rust fixture test, and generic simulator/device builds pass. The
desktop compact-stream listener is now also implemented on port 9421 beside
the existing QUIC listener. It fails closed without a Tailscale WhoIs stable
node ID, matches that ID to the current Truffle peer generation, validates the
claimed durable device ID when Truffle has learned it, and serves the same
nonce/session-list contract. The next slice adds the compact stream's explicit
control/state channel tag and the complete desktop attachment loop: attach,
initial snapshot, logical patches, control changes, input, resize, selection,
snapshot resync, and detach all use the existing session authority and epochs.
The Swift client now opens a dedicated demand-driven attachment connection,
decodes the same typed logical state, and exposes control, resize, input, ACK,
selection, resync, and detach operations. Its loopback test proves handshake,
attachment, interleaved state, input, and graceful detach; all 117 Swift tests,
the complete Rust crate tests, workspace checks, and strict Clippy pass. The
following slice exposes `LogicalReplicaModel` as a separately owned and
panic-poisoned C/Swift handle. The demand-driven Truffle replica pump now turns
remote snapshots and patches into local TRF1 with the bundled fonts, ACKs only
successfully applied state, and requests an authoritative snapshot after a
patch discontinuity. Rust proves the snapshot-to-TRF1 ABI and Swift proves the
full loopback path from compact attachment state to a local TRF1 frame; all 118
Swift package tests pass after this slice.

The next checkpoint composes the first real application slice in the separate
`apple/GhostteaApp` target. The app starts the production in-process
TailscaleKit backend, presents interactive login, discovers Ghosttea peers,
lists shared sessions, attaches through the compact stream, renders replica
TRF1 through the Metal surface, and routes keyboard, pointer, scroll,
selection, control claim, resize, detach, and foreground snapshot requests.
The pinned TailscaleKit revision is
`5e89501def80a6579ca5d0f9a02f336be62b8f2e`; its binary and license hashes are
recorded in the release lock and BOM. Generic device and arm64 simulator builds
pass with the honest iOS 18.1 minimum, and the sibling Truffle suite passes all
67 tests. The next product checkpoint adds a separate SSH tab backed by the
protected saved-profile repository and device-only Keychain credentials. It
supports password, private-key, and keyboard-interactive authentication,
explicit host-key trust, route/background lifecycle handling, reconnect, PTY
resize, and the same Metal/input/selection surface used by shared sessions.
Both generic device and arm64 simulator builds pass and the complete 118-test
Swift package suite remains green. The production app now also composes the
existing workspace coordinator and adaptive workspace UI: tabs and splits own
independent native terminals and transports, structural changes atomically save
secret-free profile bindings, and process restoration recreates available panes
without starting network demand. The adaptive command palette opens saved
profiles into the current workspace and invokes the same tab/split/focus/resize
command model used by hardware-keyboard shortcuts. `npm run archive:ios:app`
now produces and validates a store-validated arm64 Release `.xcarchive`
containing the expected application, dSYM, bundle ID, signing identity, and
configured team signature.

The first live cross-device checkpoint passed on 2026-07-18. A signed iPhone
14 Pro discovered the Electron desktop through the production in-process
Truffle runtime, listed its live session, completed the compact handshake, and
attached with read-write authority at the desktop's canonical `101x29` grid.
Input entered through the iPhone produced `ghosttea-shared-ios-ok` in the
concurrently attached desktop terminal. The device run exposed and fixed a
cross-runtime acronym-key mismatch (`requestID`/`sessionID`/`viewID` versus
Rust's `requestId`/`sessionId`/`viewId`); the Swift suite now asserts the exact
desktop JSON shape and passes all 121 tests. The subsequent automated
signed-device gate attaches two iOS clients to one desktop session and proves
A-to-B-to-A control handoff, exact resize, snapshot, selection, detach, and
fresh reconnect. A restart gate proves that a changed desktop `hostInstanceID`
rejects the old session and permits a fresh attachment even when the tailnet
peer generation remains stable. The TailscaleKit inbound-listener `EBADF` was
traced to `SCM_RIGHTS` descriptor renumbering and fixed by the reviewed, hashed
libtailscale patch in the Truffle lock/BOM. The production app now separates
one application-owned mesh runtime from scene-owned attachment, replica,
renderer, grid, control, and stable view-ID state, exposes an iPad New Window
action, and cancels/detaches only the closing scene. The generated manifest
advertises multiple scenes and both Apple builds pass. All 68 sibling Truffle
and 122 Ghosttea Swift tests pass, followed by the signed iPhone interop
regression. A deterministic iPad Pro Simulator gate now opens two actual
`WindowGroup` scenes, verifies shared runtime/distinct view identities, closes
the requested second scene, and observes one survivor. Physical iPad Stage
Manager qualification with two live terminal attachments and the separately
observed, self-recovering LocalAPI watch timeout remain open. App Store
distribution export is deferred to the release-account gate.

Deliverables:

- a separate production SwiftUI iOS application target with no fixture-only
  defaults or diagnostic controls;
- application-owned composition of saved SSH profiles, Keychain credentials,
  workspace restoration, terminal surfaces, lifecycle, and error states;
- dependency on the sibling Truffle Swift package with an exact reviewed
  revision recorded in the release lock;
- `GhostteaTruffle` package product containing the terminal protocol codec,
  durable peer/session references, discovery, attachment, reconnect, and
  replica adapter;
- desktop raw-stream adapter for the same Ghosttea terminal protocol semantics;
- Truffle login, peer browser, shared-session picker, and explicit
  read-only/read-write state in the production UI;
- live desktop/iOS same-session conformance, control-handoff, resize,
  disconnect, foreground resync, and stale-generation tests;
- signed device builds plus a TestFlight-shaped archive of the real app.

Exit gate:

```text
The production iOS app and desktop demo attach concurrently to one
desktop-authoritative session through Truffle. Input from the controlling view,
control handoff, resize, selection, disconnect, and snapshot resync remain
consistent, and the app can also create an independent direct SSH workspace.
```

### Phase 9: release hardening

**Estimated effort:** 2-3 weeks

**Started:** 2026-07-18 under the former Phase 8 numbering. The first slice
adds a deterministic CycloneDX 1.6
inventory for the iOS application's direct/static native inputs and exact
bundled font files. Its verifier derives the expected graph from the Ghostty,
SSH, font, package, license, and notice locks and rejects any unreviewed drift.
The normal repository check runs inventory mode; release mode additionally
fails closed while the SSH lock records `productionApproved: false`. That first
inventory contained eleven components, including the exact Truffle and
TailscaleKit revisions, binary hashes, and all five font hashes. The second
slice expands it to 94 components: all 83 non-development crates selected for
the `aarch64-apple-ios` Rust archive, the exact `Cargo.lock` hash and dependency
graph, and the existing native/bundled inputs. It also locks the Xcode, Swift,
Clang, Rust, Cargo, and LLVM identities. Release archives fail before Xcode
when either the BOM or toolchain drifts, while a dedicated CI workflow validates
the document with the official CycloneDX CLI. The third slice embeds a
byte-identical copy of that BOM and a deterministic human-readable notice in
the production app. The notice maps all 94 components to 93 deduplicated exact
license documents and is available through an About sheet. Offline checks
reject omitted components, local-path leakage, hash or byte drift, and missing
bundle resources; both generic Apple builds and exact post-build bundle
validation pass. The fourth slice adds deterministic archive evidence for the
source revision, reviewed locks, content trees, app identity, signature,
executable UUID, bundled resources, provisioning profile, and exact dSYM UUID
match. The same command optionally validates a safely extracted IPA, requires
archive identity/architecture/UUID/resource parity, and refuses release
eligibility without trusted Apple Distribution signing. A signed development
archive and IPA-shaped structural fixture pass validation while remaining
explicitly blocked. The release-account export, signed provenance publication,
SSH production approval, and other release-hardening gates remain open. The
fifth slice adds independent, hash-locked privacy manifests to the application
and embedded TailscaleKit framework, including final-binary required-reason
symbol auditing. Both app configurations honestly declare non-exempt
cryptography, and draft review notes explain that commands execute only on the
user's SSH host or desktop session. A deterministic App Store gate passes in
input-audit mode and remains release-blocked until the account owner approves
the Tailscale privacy label and in-app privacy-policy URL, Apple's encryption
determination, and working SSH/desktop reviewer access.

Deliverables:

- performance and energy profiling;
- memory-pressure and atlas-eviction behavior;
- whole-application CPU/GPU memory budgets and inactive-session eviction;
- fuzzing for FFI and TRF1 decoder;
- artifact reproducibility and checksum verification;
- license and SBOM packaging;
- App Store privacy, export, and review documentation;
- crash-safe redacted diagnostics;
- beta test across the device and application matrix;
- documented Ghostty upgrade procedure.

Exit gate:

```text
All mandatory parity, lifecycle, security, packaging, and performance gates
pass on release artifacts.
```

### Overall planning range

The complete first production version is approximately 19-32 engineer-weeks
for one engineer, with the largest uncertainty in Metal polish, IME/selection,
and SSH lifecycle behavior. A vertical slice through Phase 4 can be available
substantially earlier and should be the first funding and architecture gate.

---

## 23. Milestones

### Milestone A: native proof

```text
iOS can run the pinned VT core and match semantic fixtures.
```

Includes Phases 0 and the minimum of Phase 3 required for proof.

### Milestone B: shared-core proof

```text
Desktop and iOS use the same model and produce matching TRF1 frames.
```

Includes Phases 1 through 3.

### Milestone C: interactive local replay

```text
An iOS terminal renders recorded sessions and accepts complete native input.
```

Includes Phases 4 and 5.

### Milestone D: usable SSH application

```text
Users can securely connect, work, resize, suspend, reconnect, and recover.
```

Includes Phase 6.

### Milestone E: Ghosttea workspace parity

```text
iPad and iPhone provide the agreed desktop workspace behaviors and persistence.
```

Includes Phase 7.

### Milestone F: production app and cross-device continuity

```text
The signed iOS app and desktop demo can work in the same authoritative
terminal session through Truffle, while direct SSH remains available.
```

Includes Phases 8 and 9.

---

## 24. Risks and mitigations

| Risk                                                           | Impact                            | Mitigation                                                                        |
| -------------------------------------------------------------- | --------------------------------- | --------------------------------------------------------------------------------- |
| `libghostty-vt` API changes                                    | Native build and wrapper breakage | Pin commit; keep custom shim; upgrade only through fixture gate                   |
| Rust core extraction regresses desktop                         | Existing product instability      | Mechanical first move; byte-identical frames; existing integration and benchmarks |
| iOS font behavior differs                                      | Frame and screenshot mismatch     | Bundle identical licensed font bytes; explicit metrics and raster scale           |
| FFI buffer lifetime bugs                                       | Crashes or corruption             | Opaque handles; owned buffers; sanitizers; lifecycle stress tests                 |
| Swift/Rust boundary becomes chatty                             | Latency and energy regression     | One call per input/update; one contiguous frame; no per-cell calls                |
| Metal renderer diverges from WebGPU                            | Visual inconsistency              | Shared TRF1; render-order specification; screenshot suite                         |
| IME behavior is incomplete                                     | Poor international usability      | UIKit-native composition; dedicated CJK/emoji test matrix                         |
| iOS suspension kills SSH                                       | Lost interactive session          | tmux/zellij; explicit states; reconnect; prefer desktop-hosted Truffle sessions   |
| Host-key handling is weakened for convenience                  | Security failure                  | Verification required; fingerprint prompt; known-host management                  |
| GPU atlases exceed mobile memory                               | Termination under pressure        | Bounded atlases; LRU eviction; full refresh; memory-warning tests                 |
| Full-libghostty community APIs look faster                     | Architectural drift               | Keep spike bounded; measure against Ghosttea parity contract                      |
| App Store policy misunderstanding                              | Review delay                      | Remote-execution review note; no downloaded app code; documented background use   |
| Apple Truffle backend lacks the complete live cross-device matrix | Shared-session release blocker | Preserve automated handoff, resize, resync, restart, and listener gates; complete physical iPad multi-scene qualification before release |
| Desktop QUIC and Apple raw-stream APIs do not match            | Duplicate or divergent protocol   | Keep Ghosttea message semantics; add a compact TCP binding with shared vectors    |
| Stale Truffle peer generations are persisted                   | Reconnects target the wrong node  | Persist durable device ID only; resolve a fresh generation for every reconnect    |
| Selected SSH stack lacks required authentication or algorithms | Launch-host incompatibility       | Phase 0 server matrix; fund missing work or select another stack before Phase 6   |
| Inbound output outruns terminal processing                     | Memory growth or disconnect       | Pull-based reads; SSH channel-window backpressure; sustained-flood tests          |
| CPU terminal and scrollback state exceed mobile budget         | Jetsam termination                | Device-tier budgets; cache reclamation; trim shim or whole-session eviction       |
| Native panic leaves partially mutated state                    | Corruption after retry            | Poison terminal or runtime; destroy and recreate; never retry                     |
| Shared text-engine mutex serializes session floods             | Cross-session latency             | Measure wait/hold/fairness; shard or pool shaping only if required                |

---

## 25. Architecture decisions

### ADR-IOS-001: Share terminal state and frame production

**Decision:** Extract a platform-neutral Ghosttea core used by desktop and iOS.

**Reason:** This is the strongest available semantic and rendering parity
boundary and prevents two session implementations from drifting.

### ADR-IOS-002: Use Metal for final iOS pixels

**Decision:** Implement a TRF1 Metal renderer rather than embedding WebGPU in a
web view or using full libghostty.

**Reason:** Native lifecycle, input, performance, and UIKit composition are
required, while TRF1 preserves the desktop rendering contract.

### ADR-IOS-003: Use a C ABI and XCFramework

**Decision:** Expose the Rust core through a manually controlled C ABI packaged
for SwiftPM.

**Reason:** C provides a stable Apple toolchain boundary. High-frequency binary
buffers do not benefit from an object-heavy generated bridge.

This does not prohibit using code generation for safe Swift declarations, but
the exported ABI remains intentionally small and reviewed.

### ADR-IOS-004: Transport is host-owned

**Decision:** The terminal model consumes and produces ordered bytes; it does
not own SSH or network connections.

**Reason:** SSH, remote Ghosttea, replay, and tests can share one terminal
implementation.

### ADR-IOS-005: Bundle fonts for parity mode

**Decision:** Cross-platform parity uses explicit bundled font bytes.

**Reason:** Family names and system font discovery are not deterministic across
macOS and iOS.

### ADR-IOS-006: Treat full libghostty as an experiment

**Decision:** Community full-libghostty packages may inform and accelerate a
spike but do not become production dependencies by default.

**Reason:** They currently require host-I/O/lifecycle work outside the stable
upstream API and do not match Ghosttea desktop's rendering path.

### ADR-IOS-007: Background means suspend and restore

**Decision:** Stop rendering in the background and design connections for loss
and reconnection.

**Reason:** This follows iOS execution and Metal lifecycle constraints and
avoids unreliable hidden keepalive behavior.

### ADR-IOS-008: Truffle is the cross-device session fabric

**Decision:** The production iOS app imports the sibling Apple-native Truffle
package and uses it for mesh identity, login, peer discovery, and authenticated
connections. Ghosttea's existing terminal protocol remains responsible for
session authority and replication.

**Reason:** Truffle already supplies the cross-platform device identity and
networking product. Reusing it lets the desktop demo and iOS app address the
same peer and session without weakening Ghosttea's epoch, ordering, resize, or
snapshot rules.

---

## 26. Open product decisions

These decisions should be made during Phase 0. They do not block writing the
shared core, but they affect UI, security, and release scope.

1. **Resolved:** the first release supports both direct SSH and attachment to a
   Ghosttea desktop/server through Truffle.
2. Is iPhone required at launch, or may the first vertical slice target iPad?
3. **Resolved:** iOS 18.1 is the minimum because the pinned production
   TailscaleKit binary is built for iOS 18.1 or newer.
4. Which font family may be bundled, and is user-supplied font import required?
5. Does “exact parity” require bundled-font frame parity, or only semantic and
   interaction parity?
6. Which terminal image protocols are required for version one?
7. Which SSH authentication methods are required at launch?
8. Is tmux/zellij integration an onboarding recommendation or a first-class
   managed feature?
9. **Resolved:** one session may be visible on both; exactly one view controls
   human input and authoritative resize at a time under the existing epochs.
10. Which desktop workspace shortcuts should map to iPad hardware keyboards,
    and which must yield to system shortcuts?
11. Are terminal transcripts retained, and if so, what encryption, retention,
    and privacy policy applies?
12. Is the Swift package intended only for this app initially, or published as
    a supported third-party SDK?

---

## 27. Definition of done

The iOS terminal architecture is complete when:

1. desktop and iOS use the same `ghosttea-core` terminal model;
2. the pinned VT library and Ghosttea FFI ship as verified device/simulator
   artifacts;
3. shared fixtures prove semantic and frame parity;
4. the Metal renderer passes the visual contract;
5. software keyboard, hardware keyboard, IME, pointer, selection, clipboard,
   and accessibility behaviors pass their matrices;
6. SSH host verification and credential storage meet the security design;
7. resize and terminal-generated replies work through the transport;
8. suspension, network changes, reconnection, and GPU recreation are tested;
9. workspace actions match shared conformance vectors;
10. release artifacts include pins, checksums, licenses, and an SBOM;
11. performance gates pass on representative iPhone and iPad hardware;
12. desktop package, integration, and benchmark checks show no extraction
    regression;
13. a signed production iOS application—not the diagnostic harness—ships the
    terminal, workspace, SSH, restoration, and Truffle flows;
14. desktop and iOS concurrently attach to one authoritative Truffle session,
    hand control across devices, reconnect, and resynchronize without duplicate
    input or divergent terminal revisions.

---

## 28. References

### Repository inputs

- `native/ghostty.lock.json`
- `native/vendor/ghostty/src/build/GhosttyLibVt.zig`
- `native/vendor/ghostty/include/ghostty.h`
- `native/terminald/src/session.rs`
- `native/terminald/src/authority.rs`
- `native/terminald/src/frame.rs`
- `native/terminald/crates/ghostty-adapter/src/lib.rs`
- `native/terminald/crates/ghostty-vt-sys/artifacts.json`
- `native/terminald/crates/text-engine/src/lib.rs`
- `native/terminald/crates/truffle/src/lib.rs`
- `native/terminald/src/tunnel_protocol.rs`
- `packages/terminal-frame/src/index.ts`
- `packages/terminal-react/src/TerminalSurface.tsx`
- `packages/terminal-react/src/workspace/`
- `draft/architecture-design.md`
- `draft/embedding-refactor.md`
- `draft/terminal-tunneling.md`
- `draft/ios-libghostty-research.md`
- sibling `p008/truffle/apple/Package.swift`
- sibling `p008/truffle/docs/rfcs/024-truffle-swift.md`

### Upstream and platform sources

- Ghostty: <https://github.com/ghostty-org/ghostty>
- Ghostling and the custom-renderer VT boundary:
  <https://github.com/ghostty-org/ghostling>
- Ghostty iPad discussion and external-I/O work:
  <https://github.com/ghostty-org/ghostty/discussions/4087>
- libghostty-spm: <https://github.com/Lakr233/libghostty-spm>
- Termini: <https://github.com/arach/Termini>
- Geistty: <https://github.com/daiimus/geistty>
- Rootshell: <https://github.com/kitknox/rootshell>
- SwiftNIO: <https://github.com/apple/swift-nio>
- SwiftNIO SSH: <https://github.com/apple/swift-nio-ssh>
- Citadel: <https://github.com/orlandos-nl/Citadel>
- libssh2 keyboard-interactive API:
  <https://libssh2.org/libssh2_userauth_keyboard_interactive_ex.html>
- libssh2 authentication partial-success work:
  <https://github.com/libssh2/libssh2/pull/1760>
- Apple App Review Guidelines:
  <https://developer.apple.com/app-store/review/guidelines/>
- Apple, preparing Metal applications for the background:
  <https://developer.apple.com/documentation/metal/preparing-your-metal-app-to-run-in-the-background>
- Apple, preparing UIKit applications for the background:
  <https://developer.apple.com/documentation/uikit/preparing-your-ui-to-run-in-the-background>
- Apple, background execution limits:
  <https://developer.apple.com/forums/thread/685525>
- Apple `UIKeyCommand`:
  <https://developer.apple.com/documentation/uikit/uikeycommand>
