//! Native linking contract for Ghosttea's pinned Ghostty VT core.
//!
//! This crate intentionally exposes no raw bindings. It owns native artifact
//! resolution and linking for the safe `ghosttea-vt` wrapper.

/// Zero-sized marker proving that the native link contract was included.
///
/// Applications should normally use `ghosttea-vt` instead.
pub struct LinkContract;
