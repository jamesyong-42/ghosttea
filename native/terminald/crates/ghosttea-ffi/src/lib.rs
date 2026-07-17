#![allow(clippy::not_unsafe_ptr_arg_deref)]

use std::{
    alloc::{Layout, alloc, dealloc},
    cell::RefCell,
    ffi::{CString, c_char},
    mem::{align_of, size_of},
    panic::AssertUnwindSafe,
    ptr, slice, str,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
};

use ghosttea_core::{
    ClipboardRequest, RenderRequest, TerminalEffect, TerminalModel, TerminalModelOptions,
    TerminalRuntime, TerminalUpdate,
};
use ghosttea_text::{FontResource, FontResources, TextEngine, TextMetrics};
use serde_json::json;

pub const GHOSTTEA_ABI_VERSION: u32 = 1;
pub const GHOSTTEA_STATUS_OK: i32 = 0;
pub const GHOSTTEA_STATUS_INVALID_ARGUMENT: i32 = 1;
pub const GHOSTTEA_STATUS_INVALID_STATE: i32 = 2;
pub const GHOSTTEA_STATUS_INTERNAL: i32 = 3;
pub const GHOSTTEA_STATUS_PANIC: i32 = 4;

const MAX_FONT_COUNT: usize = 64;
const MAX_FONT_BYTES: usize = 64 * 1024 * 1024;

thread_local! {
    static LAST_ERROR: RefCell<CString> = RefCell::new(CString::default());
}

fn clear_error() {
    LAST_ERROR.with(|slot| *slot.borrow_mut() = CString::default());
}

fn set_error(message: impl AsRef<str>) {
    let sanitized = message.as_ref().replace('\0', "�");
    LAST_ERROR.with(|slot| {
        *slot.borrow_mut() = CString::new(sanitized).unwrap_or_default();
    });
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct GhostteaBytesView {
    pub data: *const u8,
    pub len: usize,
}

#[repr(C)]
#[derive(Clone, Copy)]
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

    fn from_vec(mut bytes: Vec<u8>) -> Self {
        if bytes.is_empty() {
            return Self::EMPTY;
        }
        let owned = Self {
            data: bytes.as_mut_ptr(),
            len: bytes.len(),
            capacity: bytes.capacity(),
        };
        std::mem::forget(bytes);
        owned
    }
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct GhostteaFont {
    pub data: GhostteaBytesView,
    pub face_index: u32,
    pub role: u32,
}

#[repr(C)]
pub struct GhostteaRuntimeConfig {
    pub abi_version: u32,
    pub struct_size: u32,
    pub fonts: *const GhostteaFont,
    pub font_count: usize,
    pub font_size_px: f32,
    pub cell_width_px: f32,
    pub line_height_px: f32,
    pub baseline_px: f32,
    pub raster_scale: f32,
}

#[repr(C)]
pub struct GhostteaTerminalConfig {
    pub abi_version: u32,
    pub struct_size: u32,
    pub session_handle: u64,
    pub session_epoch: u64,
    pub layout_epoch: u64,
    pub scrollback_bytes: u64,
    pub cols: u16,
    pub rows: u16,
    pub reserved: u32,
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct GhostteaEffect {
    pub sequence: u32,
    pub kind: u32,
    pub payload_offset: u32,
    pub payload_length: u32,
}

#[repr(C)]
pub struct GhostteaUpdate {
    pub storage: GhostteaOwnedBytes,
    pub effects: *const GhostteaEffect,
    pub effect_count: usize,
}

impl GhostteaUpdate {
    const EMPTY: Self = Self {
        storage: GhostteaOwnedBytes::EMPTY,
        effects: ptr::null(),
        effect_count: 0,
    };
}

#[repr(C)]
pub struct GhostteaKeyEvent {
    pub abi_version: u32,
    pub struct_size: u32,
    pub code_utf8: GhostteaBytesView,
    pub text_utf8: GhostteaBytesView,
    pub unshifted_codepoint: u32,
    pub modifiers: u16,
    pub action: u8,
    pub reserved: u8,
}

#[repr(C)]
pub struct GhostteaMouseEvent {
    pub abi_version: u32,
    pub struct_size: u32,
    pub x: f32,
    pub y: f32,
    pub screen_width: u32,
    pub screen_height: u32,
    pub cell_width: u32,
    pub cell_height: u32,
    pub padding_left: u32,
    pub padding_top: u32,
    pub modifiers: u16,
    pub action: u8,
    pub button: u8,
}

struct RuntimeState {
    core: Arc<TerminalRuntime>,
    poisoned: AtomicBool,
}

pub struct GhostteaRuntimeHandle {
    state: Arc<RuntimeState>,
}

pub struct GhostteaTerminalHandle {
    runtime: Arc<RuntimeState>,
    poisoned: AtomicBool,
    model: Mutex<TerminalModel>,
}

enum PanicScope {
    Terminal,
    Runtime,
}

fn invalid(message: impl Into<String>) -> (i32, String) {
    (GHOSTTEA_STATUS_INVALID_ARGUMENT, message.into())
}

fn internal(message: impl Into<String>) -> (i32, String) {
    (GHOSTTEA_STATUS_INTERNAL, message.into())
}

unsafe fn view_bytes<'a>(view: GhostteaBytesView) -> Result<&'a [u8], (i32, String)> {
    if view.len == 0 {
        return Ok(&[]);
    }
    if view.data.is_null() {
        return Err(invalid("nonempty byte view has a null data pointer"));
    }
    // SAFETY: The caller's C contract guarantees `len` readable bytes for this call.
    Ok(unsafe { slice::from_raw_parts(view.data, view.len) })
}

unsafe fn view_utf8<'a>(view: GhostteaBytesView, field: &str) -> Result<&'a str, (i32, String)> {
    // SAFETY: Forwarded from this function's caller.
    str::from_utf8(unsafe { view_bytes(view)? })
        .map_err(|_| invalid(format!("{field} is not valid UTF-8")))
}

fn validate_version(
    version: u32,
    actual_size: u32,
    required_size: usize,
) -> Result<(), (i32, String)> {
    if version != GHOSTTEA_ABI_VERSION {
        return Err(invalid(format!("unsupported ABI version {version}")));
    }
    if usize::try_from(actual_size).unwrap_or(0) < required_size {
        return Err(invalid(
            "versioned structure is smaller than the ABI v1 layout",
        ));
    }
    Ok(())
}

fn render_request(value: u32) -> Result<RenderRequest, (i32, String)> {
    match value {
        0 => Ok(RenderRequest::None),
        1 => Ok(RenderRequest::Damage),
        2 => Ok(RenderRequest::Full),
        _ => Err(invalid("invalid render request")),
    }
}

fn copy_font(font: &GhostteaFont, name: String) -> Result<FontResource, (i32, String)> {
    if font.data.len == 0 || font.data.len > MAX_FONT_BYTES {
        return Err(invalid("font byte length is outside the supported range"));
    }
    // SAFETY: Runtime creation validates and copies every caller-owned view synchronously.
    let bytes = unsafe { view_bytes(font.data)? }.to_vec();
    Ok(FontResource::new(name, bytes).with_face_index(font.face_index as usize))
}

fn create_runtime(config: &GhostteaRuntimeConfig) -> Result<GhostteaRuntimeHandle, (i32, String)> {
    validate_version(
        config.abi_version,
        config.struct_size,
        size_of::<GhostteaRuntimeConfig>(),
    )?;
    if config.font_count == 0 || config.font_count > MAX_FONT_COUNT || config.fonts.is_null() {
        return Err(invalid("runtime requires a bounded nonempty font array"));
    }
    // SAFETY: The C caller supplies `font_count` readable descriptors for this call.
    let fonts = unsafe { slice::from_raw_parts(config.fonts, config.font_count) };
    let mut regular = None;
    let mut bold = None;
    let mut italic = None;
    let mut bold_italic = None;
    let mut fallbacks = Vec::new();
    for (index, font) in fonts.iter().enumerate() {
        let resource = copy_font(font, format!("ghosttea-font-{index}"))?;
        let slot = match font.role {
            0 => &mut regular,
            1 => &mut bold,
            2 => &mut italic,
            3 => &mut bold_italic,
            4 => {
                fallbacks.push(resource);
                continue;
            }
            _ => return Err(invalid("font has an unknown role")),
        };
        if slot.replace(resource).is_some() {
            return Err(invalid("font role may appear only once"));
        }
    }
    let mut resources =
        FontResources::new(regular.ok_or_else(|| invalid("regular font is required"))?);
    resources.bold = bold;
    resources.italic = italic;
    resources.bold_italic = bold_italic;
    resources.fallbacks = fallbacks;
    let metrics = TextMetrics {
        font_size_px: config.font_size_px,
        cell_width_px: config.cell_width_px,
        line_height_px: config.line_height_px,
        baseline_px: config.baseline_px,
    };
    let engine = TextEngine::from_fonts(resources, metrics, config.raster_scale)
        .map_err(|error| internal(error.to_string()))?;
    Ok(GhostteaRuntimeHandle {
        state: Arc::new(RuntimeState {
            core: Arc::new(TerminalRuntime::new(engine)),
            poisoned: AtomicBool::new(false),
        }),
    })
}

fn terminal_operation<T>(
    terminal: *mut GhostteaTerminalHandle,
    scope: PanicScope,
    operation: impl FnOnce(&mut TerminalModel) -> Result<T, String>,
) -> Result<T, i32> {
    if terminal.is_null() {
        set_error("terminal handle is null");
        return Err(GHOSTTEA_STATUS_INVALID_ARGUMENT);
    }
    // SAFETY: The caller supplies a live handle created by this library.
    let handle = unsafe { &*terminal };
    if handle.poisoned.load(Ordering::Acquire) || handle.runtime.poisoned.load(Ordering::Acquire) {
        set_error("terminal or its runtime is poisoned");
        return Err(GHOSTTEA_STATUS_INVALID_STATE);
    }
    let result = std::panic::catch_unwind(AssertUnwindSafe(|| {
        let mut model = handle
            .model
            .lock()
            .map_err(|_| "terminal model lock is poisoned".to_owned())?;
        operation(&mut model)
    }));
    match result {
        Ok(Ok(value)) => Ok(value),
        Ok(Err(message)) => {
            set_error(message);
            Err(GHOSTTEA_STATUS_INTERNAL)
        }
        Err(_) => {
            handle.poisoned.store(true, Ordering::Release);
            if matches!(scope, PanicScope::Runtime) {
                handle.runtime.poisoned.store(true, Ordering::Release);
            }
            set_error("panic caught at Ghosttea C ABI boundary; handle poisoned");
            Err(GHOSTTEA_STATUS_PANIC)
        }
    }
}

fn effect_payload(effect: TerminalEffect) -> Result<(u32, Vec<u8>), String> {
    match effect {
        TerminalEffect::WriteToTransport(bytes) => Ok((1, bytes)),
        TerminalEffect::MetadataChanged(metadata) => Ok((
            2,
            serde_json::to_vec(&json!({
                "cols": metadata.cols,
                "rows": metadata.rows,
                "title": metadata.title,
                "cwd": metadata.cwd,
            }))
            .map_err(|error| error.to_string())?,
        )),
        TerminalEffect::Bell => Ok((3, Vec::new())),
        TerminalEffect::ClipboardRequest(ClipboardRequest::Write(bytes)) => Ok((4, bytes)),
        TerminalEffect::FrameReady(bytes) => Ok((5, bytes)),
        TerminalEffect::LogicalSnapshotReady(snapshot) => Ok((
            6,
            serde_json::to_vec(&snapshot).map_err(|error| error.to_string())?,
        )),
    }
}

fn flatten_update(update: TerminalUpdate) -> Result<GhostteaUpdate, String> {
    if update.is_empty() {
        return Ok(GhostteaUpdate::EMPTY);
    }
    let effects = update
        .into_effects()
        .into_iter()
        .map(effect_payload)
        .collect::<Result<Vec<_>, _>>()?;
    let descriptor_bytes = effects
        .len()
        .checked_mul(size_of::<GhostteaEffect>())
        .ok_or_else(|| "effect descriptor size overflow".to_owned())?;
    let payload_bytes = effects.iter().try_fold(0usize, |total, (_, payload)| {
        total
            .checked_add(payload.len())
            .ok_or_else(|| "effect payload size overflow".to_owned())
    })?;
    let total = descriptor_bytes
        .checked_add(payload_bytes)
        .ok_or_else(|| "effect arena size overflow".to_owned())?;
    if total > u32::MAX as usize {
        return Err("effect arena exceeds the ABI v1 offset range".into());
    }
    let layout = Layout::from_size_align(total, align_of::<GhostteaEffect>())
        .map_err(|_| "invalid effect arena layout".to_owned())?;
    // SAFETY: The layout has nonzero size because the update contains at least one descriptor.
    let arena = unsafe { alloc(layout) };
    if arena.is_null() {
        std::alloc::handle_alloc_error(layout);
    }
    let descriptors = arena.cast::<GhostteaEffect>();
    let mut payload_offset = descriptor_bytes;
    for (index, (kind, payload)) in effects.into_iter().enumerate() {
        let descriptor = GhostteaEffect {
            sequence: u32::try_from(index).map_err(|_| "too many ordered effects".to_owned())?,
            kind,
            payload_offset: payload_offset as u32,
            payload_length: payload.len() as u32,
        };
        // SAFETY: Descriptor and payload ranges are disjoint and were included in `total`.
        unsafe {
            descriptors.add(index).write(descriptor);
            ptr::copy_nonoverlapping(payload.as_ptr(), arena.add(payload_offset), payload.len());
        }
        payload_offset += payload.len();
    }
    Ok(GhostteaUpdate {
        storage: GhostteaOwnedBytes {
            data: arena,
            len: total,
            capacity: total,
        },
        effects: descriptors,
        effect_count: descriptor_bytes / size_of::<GhostteaEffect>(),
    })
}

fn write_update(out: *mut GhostteaUpdate, update: TerminalUpdate) -> i32 {
    match flatten_update(update) {
        Ok(value) => {
            // SAFETY: Callers pass a writable out parameter, validated by the exported function.
            unsafe { out.write(value) };
            GHOSTTEA_STATUS_OK
        }
        Err(message) => {
            set_error(message);
            GHOSTTEA_STATUS_INTERNAL
        }
    }
}

fn write_bytes(out: *mut GhostteaOwnedBytes, bytes: Vec<u8>) -> i32 {
    // SAFETY: Callers pass a writable out parameter, validated by the exported function.
    unsafe { out.write(GhostteaOwnedBytes::from_vec(bytes)) };
    GHOSTTEA_STATUS_OK
}

#[unsafe(no_mangle)]
pub extern "C" fn ghosttea_abi_version() -> u32 {
    GHOSTTEA_ABI_VERSION
}

#[unsafe(no_mangle)]
pub extern "C" fn ghosttea_last_error_message() -> *const c_char {
    LAST_ERROR.with(|slot| slot.borrow().as_ptr())
}

#[unsafe(no_mangle)]
pub extern "C" fn ghosttea_runtime_create(
    config: *const GhostteaRuntimeConfig,
    out_runtime: *mut *mut GhostteaRuntimeHandle,
) -> i32 {
    clear_error();
    if out_runtime.is_null() {
        set_error("runtime config and output pointer are required");
        return GHOSTTEA_STATUS_INVALID_ARGUMENT;
    }
    // SAFETY: The output pointer was validated and is writable by contract.
    unsafe { out_runtime.write(ptr::null_mut()) };
    if config.is_null() {
        set_error("runtime config and output pointer are required");
        return GHOSTTEA_STATUS_INVALID_ARGUMENT;
    }
    let result = std::panic::catch_unwind(AssertUnwindSafe(|| {
        // SAFETY: The config pointer was validated and is readable by contract.
        create_runtime(unsafe { &*config })
    }));
    match result {
        Ok(Ok(runtime)) => {
            // SAFETY: The output pointer remains writable for this call.
            unsafe { out_runtime.write(Box::into_raw(Box::new(runtime))) };
            GHOSTTEA_STATUS_OK
        }
        Ok(Err((status, message))) => {
            set_error(message);
            status
        }
        Err(_) => {
            set_error("panic caught while creating Ghosttea runtime");
            GHOSTTEA_STATUS_PANIC
        }
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn ghosttea_runtime_destroy(runtime: *mut GhostteaRuntimeHandle) {
    if !runtime.is_null() {
        // SAFETY: Only a handle returned by runtime_create may be destroyed once.
        unsafe { drop(Box::from_raw(runtime)) };
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn ghosttea_runtime_is_poisoned(runtime: *const GhostteaRuntimeHandle) -> bool {
    !runtime.is_null()
        // SAFETY: A non-null pointer is a live handle by contract.
        && unsafe { &*runtime }.state.poisoned.load(Ordering::Acquire)
}

#[unsafe(no_mangle)]
pub extern "C" fn ghosttea_terminal_create(
    runtime: *mut GhostteaRuntimeHandle,
    config: *const GhostteaTerminalConfig,
    out_terminal: *mut *mut GhostteaTerminalHandle,
) -> i32 {
    clear_error();
    if out_terminal.is_null() {
        set_error("runtime, terminal config, and output pointer are required");
        return GHOSTTEA_STATUS_INVALID_ARGUMENT;
    }
    // SAFETY: The output pointer is writable by contract.
    unsafe { out_terminal.write(ptr::null_mut()) };
    if runtime.is_null() || config.is_null() {
        set_error("runtime, terminal config, and output pointer are required");
        return GHOSTTEA_STATUS_INVALID_ARGUMENT;
    }
    // SAFETY: Runtime and config are live/readable for this call.
    let runtime = unsafe { &*runtime };
    if runtime.state.poisoned.load(Ordering::Acquire) {
        set_error("runtime is poisoned");
        return GHOSTTEA_STATUS_INVALID_STATE;
    }
    let config = unsafe { &*config };
    if let Err((status, message)) = validate_version(
        config.abi_version,
        config.struct_size,
        size_of::<GhostteaTerminalConfig>(),
    ) {
        set_error(message);
        return status;
    }
    let scrollback_bytes = match usize::try_from(config.scrollback_bytes) {
        Ok(value) => value,
        Err(_) => {
            set_error("scrollback byte limit does not fit this platform");
            return GHOSTTEA_STATUS_INVALID_ARGUMENT;
        }
    };
    let result = std::panic::catch_unwind(AssertUnwindSafe(|| {
        TerminalModel::new(
            runtime.state.core.clone(),
            TerminalModelOptions {
                session_handle: config.session_handle,
                session_epoch: config.session_epoch,
                layout_epoch: config.layout_epoch,
                cols: config.cols,
                rows: config.rows,
                scrollback_bytes,
            },
        )
    }));
    match result {
        Ok(Ok(model)) => {
            let terminal = GhostteaTerminalHandle {
                runtime: runtime.state.clone(),
                poisoned: AtomicBool::new(false),
                model: Mutex::new(model),
            };
            unsafe { out_terminal.write(Box::into_raw(Box::new(terminal))) };
            GHOSTTEA_STATUS_OK
        }
        Ok(Err(error)) => {
            set_error(error.to_string());
            GHOSTTEA_STATUS_INTERNAL
        }
        Err(_) => {
            set_error("panic caught while creating Ghosttea terminal");
            GHOSTTEA_STATUS_PANIC
        }
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn ghosttea_terminal_destroy(terminal: *mut GhostteaTerminalHandle) {
    if !terminal.is_null() {
        // SAFETY: Only a handle returned by terminal_create may be destroyed once.
        unsafe { drop(Box::from_raw(terminal)) };
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn ghosttea_terminal_is_poisoned(terminal: *const GhostteaTerminalHandle) -> bool {
    if terminal.is_null() {
        return false;
    }
    // SAFETY: A non-null pointer is a live handle by contract.
    let terminal = unsafe { &*terminal };
    terminal.poisoned.load(Ordering::Acquire) || terminal.runtime.poisoned.load(Ordering::Acquire)
}

fn update_operation(
    terminal: *mut GhostteaTerminalHandle,
    render: u32,
    out: *mut GhostteaUpdate,
    operation: impl FnOnce(&mut TerminalModel, RenderRequest) -> Result<TerminalUpdate, String>,
) -> i32 {
    clear_error();
    if out.is_null() {
        set_error("update output pointer is required");
        return GHOSTTEA_STATUS_INVALID_ARGUMENT;
    }
    unsafe { out.write(GhostteaUpdate::EMPTY) };
    let render = match render_request(render) {
        Ok(value) => value,
        Err((status, message)) => {
            set_error(message);
            return status;
        }
    };
    let scope = if render == RenderRequest::None {
        PanicScope::Terminal
    } else {
        PanicScope::Runtime
    };
    match terminal_operation(terminal, scope, |model| operation(model, render)) {
        Ok(update) => write_update(out, update),
        Err(status) => status,
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn ghosttea_terminal_feed(
    terminal: *mut GhostteaTerminalHandle,
    bytes: GhostteaBytesView,
    render: u32,
    out: *mut GhostteaUpdate,
) -> i32 {
    clear_error();
    if out.is_null() {
        set_error("update output pointer is required");
        return GHOSTTEA_STATUS_INVALID_ARGUMENT;
    }
    unsafe { out.write(GhostteaUpdate::EMPTY) };
    let bytes = match unsafe { view_bytes(bytes) } {
        Ok(value) => value,
        Err((status, message)) => {
            clear_error();
            set_error(message);
            return status;
        }
    };
    update_operation(terminal, render, out, |model, request| {
        model
            .feed(bytes, request)
            .map_err(|error| error.to_string())
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn ghosttea_terminal_refresh(
    terminal: *mut GhostteaTerminalHandle,
    render: u32,
    out: *mut GhostteaUpdate,
) -> i32 {
    update_operation(terminal, render, out, |model, request| {
        model.refresh(request).map_err(|error| error.to_string())
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn ghosttea_terminal_resize(
    terminal: *mut GhostteaTerminalHandle,
    cols: u16,
    rows: u16,
    layout_epoch: u64,
    render: u32,
    out: *mut GhostteaUpdate,
) -> i32 {
    update_operation(terminal, render, out, |model, request| {
        model
            .resize(cols, rows, layout_epoch, request)
            .map_err(|error| error.to_string())
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn ghosttea_terminal_set_colors(
    terminal: *mut GhostteaTerminalHandle,
    foreground: *const u8,
    background: *const u8,
    cursor: *const u8,
    render: u32,
    out: *mut GhostteaUpdate,
) -> i32 {
    clear_error();
    if out.is_null() {
        set_error("update output pointer is required");
        return GHOSTTEA_STATUS_INVALID_ARGUMENT;
    }
    unsafe { out.write(GhostteaUpdate::EMPTY) };
    if foreground.is_null() || background.is_null() || cursor.is_null() {
        set_error("foreground, background, and cursor colors are required");
        return GHOSTTEA_STATUS_INVALID_ARGUMENT;
    }
    // SAFETY: Each color points to at least three readable bytes by contract.
    let color = |pointer: *const u8| unsafe { [*pointer, *pointer.add(1), *pointer.add(2)] };
    update_operation(terminal, render, out, |model, request| {
        model
            .set_colors(color(foreground), color(background), color(cursor), request)
            .map_err(|error| error.to_string())
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn ghosttea_terminal_scroll(
    terminal: *mut GhostteaTerminalHandle,
    rows: i64,
    render: u32,
    out: *mut GhostteaUpdate,
) -> i32 {
    clear_error();
    if out.is_null() {
        set_error("update output pointer is required");
        return GHOSTTEA_STATUS_INVALID_ARGUMENT;
    }
    unsafe { out.write(GhostteaUpdate::EMPTY) };
    let rows = match isize::try_from(rows) {
        Ok(value) => value,
        Err(_) => {
            clear_error();
            set_error("scroll delta does not fit this platform");
            return GHOSTTEA_STATUS_INVALID_ARGUMENT;
        }
    };
    update_operation(terminal, render, out, |model, request| {
        model
            .scroll(rows, request)
            .map_err(|error| error.to_string())
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn ghosttea_terminal_scroll_to(
    terminal: *mut GhostteaTerminalHandle,
    row: u64,
    render: u32,
    out: *mut GhostteaUpdate,
) -> i32 {
    clear_error();
    if out.is_null() {
        set_error("update output pointer is required");
        return GHOSTTEA_STATUS_INVALID_ARGUMENT;
    }
    unsafe { out.write(GhostteaUpdate::EMPTY) };
    let row = match usize::try_from(row) {
        Ok(value) => value,
        Err(_) => {
            clear_error();
            set_error("scroll row does not fit this platform");
            return GHOSTTEA_STATUS_INVALID_ARGUMENT;
        }
    };
    update_operation(terminal, render, out, |model, request| {
        model
            .scroll_to(row, request)
            .map_err(|error| error.to_string())
    })
}

fn bytes_operation(
    terminal: *mut GhostteaTerminalHandle,
    out: *mut GhostteaOwnedBytes,
    operation: impl FnOnce(&mut TerminalModel) -> Result<Vec<u8>, String>,
) -> i32 {
    clear_error();
    if out.is_null() {
        set_error("byte output pointer is required");
        return GHOSTTEA_STATUS_INVALID_ARGUMENT;
    }
    unsafe { out.write(GhostteaOwnedBytes::EMPTY) };
    match terminal_operation(terminal, PanicScope::Terminal, operation) {
        Ok(bytes) => write_bytes(out, bytes),
        Err(status) => status,
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn ghosttea_terminal_encode_paste(
    terminal: *mut GhostteaTerminalHandle,
    text: GhostteaBytesView,
    out: *mut GhostteaOwnedBytes,
) -> i32 {
    clear_error();
    if out.is_null() {
        set_error("byte output pointer is required");
        return GHOSTTEA_STATUS_INVALID_ARGUMENT;
    }
    unsafe { out.write(GhostteaOwnedBytes::EMPTY) };
    let text = match unsafe { view_utf8(text, "paste text") } {
        Ok(value) => value,
        Err((status, message)) => {
            clear_error();
            set_error(message);
            return status;
        }
    };
    bytes_operation(terminal, out, |model| {
        model.encode_paste(text).map_err(|error| error.to_string())
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn ghosttea_terminal_encode_key(
    terminal: *mut GhostteaTerminalHandle,
    event: *const GhostteaKeyEvent,
    out: *mut GhostteaOwnedBytes,
) -> i32 {
    clear_error();
    if out.is_null() {
        set_error("byte output pointer is required");
        return GHOSTTEA_STATUS_INVALID_ARGUMENT;
    }
    unsafe { out.write(GhostteaOwnedBytes::EMPTY) };
    if event.is_null() {
        set_error("key event is required");
        return GHOSTTEA_STATUS_INVALID_ARGUMENT;
    }
    let event = unsafe { &*event };
    if let Err((status, message)) = validate_version(
        event.abi_version,
        event.struct_size,
        size_of::<GhostteaKeyEvent>(),
    ) {
        clear_error();
        set_error(message);
        return status;
    }
    let code = match unsafe { view_utf8(event.code_utf8, "key code") } {
        Ok(value) => value,
        Err((status, message)) => {
            clear_error();
            set_error(message);
            return status;
        }
    };
    let text = match unsafe { view_utf8(event.text_utf8, "key text") } {
        Ok(value) => value,
        Err((status, message)) => {
            clear_error();
            set_error(message);
            return status;
        }
    };
    bytes_operation(terminal, out, |model| {
        model
            .encode_key(
                code,
                text,
                event.unshifted_codepoint,
                event.modifiers,
                event.action,
            )
            .map_err(|error| error.to_string())
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn ghosttea_terminal_encode_mouse(
    terminal: *mut GhostteaTerminalHandle,
    event: *const GhostteaMouseEvent,
    out: *mut GhostteaOwnedBytes,
) -> i32 {
    clear_error();
    if out.is_null() {
        set_error("byte output pointer is required");
        return GHOSTTEA_STATUS_INVALID_ARGUMENT;
    }
    unsafe { out.write(GhostteaOwnedBytes::EMPTY) };
    if event.is_null() {
        set_error("mouse event is required");
        return GHOSTTEA_STATUS_INVALID_ARGUMENT;
    }
    let event = unsafe { &*event };
    if let Err((status, message)) = validate_version(
        event.abi_version,
        event.struct_size,
        size_of::<GhostteaMouseEvent>(),
    ) {
        clear_error();
        set_error(message);
        return status;
    }
    bytes_operation(terminal, out, |model| {
        model
            .encode_mouse(
                event.action,
                event.button,
                event.modifiers,
                event.x,
                event.y,
                event.screen_width,
                event.screen_height,
                event.cell_width,
                event.cell_height,
                event.padding_left,
                event.padding_top,
            )
            .map_err(|error| error.to_string())
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn ghosttea_terminal_encode_focus(
    terminal: *mut GhostteaTerminalHandle,
    focused: bool,
    out: *mut GhostteaOwnedBytes,
) -> i32 {
    bytes_operation(terminal, out, |model| {
        model
            .encode_focus(focused)
            .map_err(|error| error.to_string())
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn ghosttea_terminal_alternate_scroll(
    terminal: *mut GhostteaTerminalHandle,
    out: *mut bool,
) -> i32 {
    clear_error();
    if out.is_null() {
        set_error("alternate-scroll output pointer is required");
        return GHOSTTEA_STATUS_INVALID_ARGUMENT;
    }
    unsafe { out.write(false) };
    match terminal_operation(terminal, PanicScope::Terminal, |model| {
        Ok(model.alternate_scroll())
    }) {
        Ok(value) => {
            unsafe { out.write(value) };
            GHOSTTEA_STATUS_OK
        }
        Err(status) => status,
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn ghosttea_terminal_selection_text(
    terminal: *mut GhostteaTerminalHandle,
    start_column: u16,
    start_row: u32,
    end_column: u16,
    end_row: u32,
    select_all: bool,
    out: *mut GhostteaOwnedBytes,
) -> i32 {
    bytes_operation(terminal, out, |model| {
        model
            .selection_text((start_column, start_row), (end_column, end_row), select_all)
            .map(String::into_bytes)
            .map_err(|error| error.to_string())
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn ghosttea_terminal_accessibility_rows(
    terminal: *mut GhostteaTerminalHandle,
    start_row: u16,
    row_count: u16,
    out: *mut GhostteaOwnedBytes,
) -> i32 {
    bytes_operation(terminal, out, |model| {
        let rows = model
            .accessibility_rows(start_row, row_count)
            .map_err(|error| error.to_string())?;
        serde_json::to_vec(&rows).map_err(|error| error.to_string())
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn ghosttea_owned_bytes_free(bytes: GhostteaOwnedBytes) {
    if !bytes.data.is_null() {
        // SAFETY: The buffer triple came from `GhostteaOwnedBytes::from_vec` and is freed once.
        unsafe { drop(Vec::from_raw_parts(bytes.data, bytes.len, bytes.capacity)) };
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn ghosttea_update_destroy(update: GhostteaUpdate) {
    if update.storage.data.is_null() {
        return;
    }
    if let Ok(layout) =
        Layout::from_size_align(update.storage.capacity, align_of::<GhostteaEffect>())
    {
        // SAFETY: Update storage was allocated with this exact layout by `flatten_update`.
        unsafe { dealloc(update.storage.data, layout) };
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn abi_layout_matches_header_assumptions() {
        assert_eq!(size_of::<GhostteaEffect>(), 16);
        assert_eq!(align_of::<GhostteaEffect>(), 4);
        assert_eq!(ghosttea_abi_version(), 1);
    }

    #[test]
    fn malformed_runtime_arguments_fail_without_a_handle() {
        let mut output = ptr::dangling_mut::<GhostteaRuntimeHandle>();
        assert_eq!(
            ghosttea_runtime_create(ptr::null(), &mut output),
            GHOSTTEA_STATUS_INVALID_ARGUMENT
        );
        assert!(output.is_null());
        let message = unsafe { std::ffi::CStr::from_ptr(ghosttea_last_error_message()) }
            .to_str()
            .unwrap();
        assert!(message.contains("runtime config"));
    }

    #[test]
    fn ordered_arena_preserves_effect_sequence_and_payload_offsets() {
        let update: TerminalUpdate = [
            TerminalEffect::WriteToTransport(b"reply".to_vec()),
            TerminalEffect::Bell,
            TerminalEffect::FrameReady(b"TRF1".to_vec()),
        ]
        .into_iter()
        .collect();
        let flattened = flatten_update(update).unwrap();
        let effects = unsafe { slice::from_raw_parts(flattened.effects, flattened.effect_count) };
        assert_eq!(
            effects
                .iter()
                .map(|effect| effect.sequence)
                .collect::<Vec<_>>(),
            vec![0, 1, 2]
        );
        assert_eq!(
            effects.iter().map(|effect| effect.kind).collect::<Vec<_>>(),
            vec![1, 3, 5]
        );
        let first = effects[0];
        let payload = unsafe {
            slice::from_raw_parts(
                flattened.storage.data.add(first.payload_offset as usize),
                first.payload_length as usize,
            )
        };
        assert_eq!(payload, b"reply");
        ghosttea_update_destroy(flattened);
    }

    fn test_terminal() -> Box<GhostteaTerminalHandle> {
        let runtime = Arc::new(RuntimeState {
            core: Arc::new(TerminalRuntime::discover().unwrap()),
            poisoned: AtomicBool::new(false),
        });
        let model = TerminalModel::new(
            runtime.core.clone(),
            TerminalModelOptions {
                session_handle: 1,
                session_epoch: 1,
                layout_epoch: 1,
                cols: 80,
                rows: 24,
                scrollback_bytes: 1_000_000,
            },
        )
        .unwrap();
        Box::new(GhostteaTerminalHandle {
            runtime,
            poisoned: AtomicBool::new(false),
            model: Mutex::new(model),
        })
    }

    #[test]
    fn panic_poison_scope_is_explicit_and_post_panic_calls_fail() {
        let mut terminal = test_terminal();
        let pointer = terminal.as_mut() as *mut GhostteaTerminalHandle;
        let status = terminal_operation(pointer, PanicScope::Terminal, |_| -> Result<(), String> {
            panic!("terminal-only test panic")
        })
        .unwrap_err();
        assert_eq!(status, GHOSTTEA_STATUS_PANIC);
        assert!(terminal.poisoned.load(Ordering::Acquire));
        assert!(!terminal.runtime.poisoned.load(Ordering::Acquire));
        assert_eq!(
            terminal_operation(pointer, PanicScope::Terminal, |_| Ok(())).unwrap_err(),
            GHOSTTEA_STATUS_INVALID_STATE
        );

        let mut shared = test_terminal();
        let pointer = shared.as_mut() as *mut GhostteaTerminalHandle;
        assert_eq!(
            terminal_operation(pointer, PanicScope::Runtime, |_| -> Result<(), String> {
                panic!("shared-runtime test panic")
            })
            .unwrap_err(),
            GHOSTTEA_STATUS_PANIC
        );
        assert!(shared.poisoned.load(Ordering::Acquire));
        assert!(shared.runtime.poisoned.load(Ordering::Acquire));
    }

    #[test]
    fn malformed_input_zeroes_owned_outputs() {
        let mut update = GhostteaUpdate {
            storage: GhostteaOwnedBytes {
                data: ptr::dangling_mut(),
                len: 1,
                capacity: 1,
            },
            effects: ptr::dangling(),
            effect_count: 1,
        };
        let invalid = GhostteaBytesView {
            data: ptr::null(),
            len: 1,
        };
        assert_eq!(
            ghosttea_terminal_feed(ptr::null_mut(), invalid, 2, &mut update),
            GHOSTTEA_STATUS_INVALID_ARGUMENT
        );
        assert!(update.storage.data.is_null());
        assert!(update.effects.is_null());
        assert_eq!(update.effect_count, 0);
    }
}
