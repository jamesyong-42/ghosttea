//! Final Rust linkage boundary for the Apple XCFramework.
//!
//! A Rust `staticlib` contains the crate and all of its upstream dependencies,
//! including the Rust standard library. Producing independent static libraries
//! for the core and font-fixture ABIs and combining them afterward therefore
//! embeds two Rust runtimes. This crate is intentionally the only `staticlib`;
//! both FFI implementations are upstream `rlib` dependencies so rustc performs
//! dependency and runtime unification before the archive reaches SwiftPM.

// Keep an explicit relocation to each FFI crate in this final linkage unit.
// Consumers reference the exported C symbols directly, but these anchors also
// make the intended composition visible to rustc and robust to future LTO.
#[used]
static CORE_FFI_LINK_ANCHOR: extern "C" fn() -> u32 = ghosttea_ffi::ghosttea_abi_version;

#[used]
static FONT_FIXTURE_FFI_LINK_ANCHOR: extern "C" fn(ghosttea_font_fixture_ffi::GhostteaOwnedBytes) =
    ghosttea_font_fixture_ffi::ghosttea_font_fixture_free;

#[cfg(test)]
mod tests {
    #[test]
    fn links_both_ffi_surfaces() {
        assert_eq!(ghosttea_ffi::ghosttea_abi_version(), 1);
        assert_eq!(ghosttea_font_fixture_ffi::GHOSTTEA_FONT_FIXTURE_OK, 0);
    }
}
