# ghosttea-vt-sys

Native artifact and linking contract for Ghosttea's pinned Ghostty VT core.
Applications should depend on the safe `ghosttea-vt` crate instead of using
this crate directly.

Repository builds use `native/build/ghostty/install`. Consumers can provide an
equivalent verified installation with `GHOSTTY_VT_PREFIX`. Otherwise the crate
downloads the target bundle recorded in `artifacts.json` and verifies the
bundle, static library, and public header with SHA-256 before linking.

Supported overrides:

- `GHOSTTY_VT_PREFIX` selects an unpacked installation.
- `GHOSTTEA_GHOSTTY_VT_BUNDLE` selects a local release bundle.
- `GHOSTTEA_GHOSTTY_VT_BASE_URL` redirects downloads to a mirror.
- `GHOSTTEA_GHOSTTY_VT_OFFLINE=1` forbids network fallback.

The current release target is `aarch64-apple-darwin`. Every bundle includes
the upstream Ghostty license, deterministic build metadata, and an SPDX 2.3
SBOM.
