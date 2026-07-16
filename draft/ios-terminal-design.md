# Ghosttea iOS terminal architecture and implementation plan

**Status:** Proposed
**Date:** July 16, 2026
**Owners:** Ghosttea maintainers
**Target:** iOS 17 and later for the first production release

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

SSH or remote-session bytes
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
4. Support direct SSH sessions and leave a clean seam for Ghosttea remote
   sessions.
5. Preserve remote shells across ordinary network changes and iOS suspension
   through reconnectable transports and remote session persistence.
6. Support tabs and splits, with adaptive presentation on compact iPhone
   layouts and desktop-like presentation on iPad.
7. Make the terminal reusable by other iOS applications through Swift Package
   Manager.
8. Keep the Ghostty revision, native artifacts, licenses, checksums, and build
   inputs pinned and reproducible.

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
- making the existing Truffle/Tailscale sidecar composition run unchanged
  inside an iOS application;
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
behavior and avoid compiling the terminal model into iOS. It is a useful
future companion mode, but it cannot provide standalone SSH without a Ghosttea
host. The existing remote adapter also sends logical terminal state rather
than TRF1 glyph frames and assumes a host-owned Truffle/Tailscale composition
that cannot be reused unchanged on iOS.

The adopted terminal core plus transport abstraction supports both standalone
SSH and a future companion transport.

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

| Product             | Responsibility                                   |
| ------------------- | ------------------------------------------------ |
| `GhostteaCore`      | Safe Swift ownership of the C handle and buffers |
| `GhostteaTerminal`  | UIKit input surface and Metal renderer           |
| `GhostteaWorkspace` | SwiftUI tabs, splits, commands, and restoration  |
| `GhostteaSSH`       | First-party SSH transport selected by Phase 0    |

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
    func resize(columns: Int, rows: Int) async throws
    func interrupt() async throws
    func disconnect() async
}
```

The pull-based read is intentional. `AsyncThrowingStream` is not the generic
transport contract because its default buffer is unbounded and its bounded
policies discard elements. Transport implementations preserve byte ordering
and propagate read demand into their native flow-control primitive. They own
connection, authentication, host verification, network recovery, and
protocol-level resize messages. They do not parse terminal escape sequences.

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

The first vertical slice may use per-terminal atlases to reduce implementation
risk. Before production, measure whether sharing atlases across terminals
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
      "root": {
        "kind": "split",
        "axis": "horizontal",
        "ratio": 0.5,
        "first": { "kind": "pane", "paneId": "pane-1" },
        "second": { "kind": "pane", "paneId": "pane-2" }
      }
    }
  ]
}
```

Run identical mutation vectors against the TypeScript and Swift
implementations and compare the resulting normalized tree and focused pane.

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
OpenSSL 3.5.6 candidate now builds and imports for all required Apple slices,
including the multi-prompt keyboard-interactive API. It is not selected for
production. The pinned authentication fixture passes password, Ed25519 public
key, two-round keyboard-interactive, and public key followed by
keyboard-interactive. However, the accepted partial key step returns `-19`
rather than a distinct partial-success result, so the adapter needs explicit,
policy-safe method sequencing and negative controls. No stack-specific type may
escape the adapter.

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

### 16.3 Future Ghosttea remote transport

The existing terminal mirroring protocol and authority model are useful, but
the iOS client needs a supported network entry point that does not assume it
can launch the current host-owned Tailscale sidecar.

Design work for that mode must specify:

- gateway ownership and discovery;
- end-to-end authentication and authorization;
- certificate or device identity;
- replay protection;
- logical snapshots versus TRF1 frame transport;
- font and glyph ownership;
- reconnect and resynchronization;
- read-only and read-write capabilities;
- resize authority across desktop and mobile views.

That is a separate protocol project and must not block standalone SSH.

---

## 17. iOS lifecycle and state restoration

The application owns runtimes, terminal controllers, and transports. A
`UIScene` owns presentation attachment, selection, focus, and geometry. Scene
disconnection must not implicitly destroy an application-owned session.

iOS v1 prevents the same session from being presented in two scenes at once;
moving a session transfers its one presentation attachment. A future
multi-presentation release assigns a distinct view ID to each scene and reuses
the core's existing view and resize-authority model.

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

---

## 18. Security and App Store considerations

1. All remote host keys must be verified; a first-use prompt must show a
   fingerprint and persist the decision explicitly.
2. Credentials and private keys use Keychain access controls.
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
implemented. The pinned libssh2 authentication fixture also passes, including
explicit chained MFA with its `-19` return behavior locked under test.
Physical-device VT/network testing, the nonblocking SSH session/flow-control
adapter, bundled-font licensing, and device-tier memory gates remain open.
libssh2 is a candidate, not the selected SSH path.

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

Phase 1 begins only after the in-flight embedding refactor lands, passes its
package and integration checks, and establishes a baseline commit. Do not
interleave the two reorganizations in `session.rs`, `service.rs`, `replica.rs`,
or the renderer packages.

Deliverables:

- create the platform-neutral crate;
- move terminal state, logical snapshots, frame production, render caches,
  counters, and input encoding behind `TerminalModel`;
- express PTY writes as returned effects;
- make rendering demand-driven;
- adapt desktop `Session` to own the model;
- preserve current socket protocols and renderer path;
- add byte-identical desktop TRF1 regression fixtures;
- retain automation ordering and view-authority behavior.

Exit gate:

```text
All desktop unit, integration, package, and benchmark checks pass, and the
extraction produces no intentional TRF1 or protocol change.
```

### Phase 2: explicit font resources

**Estimated effort:** 1-2 weeks

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

Deliverables:

- the SSH transport selected by the Phase 0 compatibility gate;
- host-key verification and known-host storage;
- Keychain-backed credentials;
- PTY allocation and resize propagation;
- ordered terminal-response writes;
- connection-state UI;
- cancellation, reconnect, and suspension behavior;
- tmux/zellij attach profiles;
- network transition and background/foreground tests.

Exit gate:

```text
Vim, tmux, htop, shells, and agent TUIs remain correct through resize, network
change, suspension, reconnection, and explicit disconnect scenarios.
```

### Phase 7: workspace parity

**Estimated effort:** 2-4 weeks

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

### Phase 8: release hardening

**Estimated effort:** 2-3 weeks

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

The complete first production version is approximately 16-27 engineer-weeks
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

Includes Phases 7 and 8.

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
| iOS suspension kills SSH                                       | Lost interactive session          | tmux/zellij; explicit states; reconnect; remote Ghosttea mode later               |
| Host-key handling is weakened for convenience                  | Security failure                  | Verification required; fingerprint prompt; known-host management                  |
| GPU atlases exceed mobile memory                               | Termination under pressure        | Bounded atlases; LRU eviction; full refresh; memory-warning tests                 |
| Full-libghostty community APIs look faster                     | Architectural drift               | Keep spike bounded; measure against Ghosttea parity contract                      |
| App Store policy misunderstanding                              | Review delay                      | Remote-execution review note; no downloaded app code; documented background use   |
| Current Truffle integration cannot run on iOS                  | Companion mode delay              | Treat as separate gateway transport; do not block SSH                             |
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

---

## 26. Open product decisions

These decisions should be made during Phase 0. They do not block writing the
shared core, but they affect UI, security, and release scope.

1. Is the first release standalone SSH only, or must it also attach to a
   Ghosttea desktop/server?
2. Is iPhone required at launch, or may the first vertical slice target iPad?
3. Is iOS 17 an acceptable minimum?
4. Which font family may be bundled, and is user-supplied font import required?
5. Does “exact parity” require bundled-font frame parity, or only semantic and
   interaction parity?
6. Which terminal image protocols are required for version one?
7. Which SSH authentication methods are required at launch?
8. Is tmux/zellij integration an onboarding recommendation or a first-class
   managed feature?
9. Must one session be simultaneously writable from desktop and iOS?
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
    regression.

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
- `packages/terminal-frame/src/index.ts`
- `packages/terminal-react/src/TerminalSurface.tsx`
- `packages/terminal-react/src/workspace/`
- `draft/architecture-design.md`
- `draft/embedding-refactor.md`
- `draft/terminal-tunneling.md`
- `draft/ios-libghostty-research.md`

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
