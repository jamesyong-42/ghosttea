# ghosttea-vt-sys

Native artifact and linking contract for Ghosttea's pinned Ghostty VT core.
Applications should depend on the safe `ghosttea-vt` crate instead of using
this crate directly.

Repository builds use `native/build/ghostty/<target>/install`, so one checkout
can hold several platforms at once. Consumers can provide an equivalent
verified installation with `GHOSTTY_VT_PREFIX`. Otherwise the crate downloads
the target bundle recorded in `artifacts.json` and verifies the bundle, static
library, and public header with SHA-256 before linking.

Supported overrides:

- `GHOSTTY_VT_PREFIX` selects an unpacked installation.
- `GHOSTTEA_GHOSTTY_VT_BUNDLE` selects a local release bundle.
- `GHOSTTEA_GHOSTTY_VT_BASE_URL` redirects downloads to a mirror.
- `GHOSTTEA_GHOSTTY_VT_OFFLINE=1` forbids network fallback.

Every bundle includes the upstream Ghostty license, build metadata, the exact
reviewed source patches under `SOURCE-PATCHES/`, and an SPDX 2.3 SBOM. Artifact
names use a digest of the upstream commit plus the ordered patch identities;
the commit alone is not a complete source identity.

## Release targets

| Target | Built by | Static archive | Reproducible |
| --- | --- | --- | --- |
| `aarch64-apple-darwin` | Zig in the pinned Linux builder image | `lib/libghostty-vt.a` | yes |
| `x86_64-pc-windows-msvc` | Zig on a Windows host | `lib/ghostty-vt-static.lib` | no |

Ghostty installs the Windows static archive under a distinct name because
`lib/ghostty-vt.lib`, the DLL import library, sits beside it.

Windows cannot use the container cross-build: Microsoft's CRT headers and
import libraries are not redistributable, so Zig must find an installed MSVC
and Windows SDK and therefore builds on a matching host. A container build
compiles at fixed in-container paths and reproduces on any host; a native build
embeds the building machine's absolute paths in the archive's member table,
which no postprocessing step can canonicalize.

`reproducible` in `artifacts.json` records that difference and decides how a
bundle is trusted:

- a downloaded or supplied bundle is always verified against its locked
  checksums, because it is untrusted input;
- a repository build is verified only when the target is reproducible. It
  already comes from the pinned Ghostty commit, so its checksum is a
  reproducibility check rather than a trust boundary.

Because a Windows release cannot be reproduced from the manifest, one CI
workflow-dispatch run produces the authoritative candidate bytes. Its result
and `candidateRunId` are reviewed and locked in `artifacts.json`. The tag run
downloads that immutable workflow artifact by run ID, verifies its bundle
checksum, result metadata, embedded source identity, and SBOM, and promotes the
same bytes. It must never rebuild a fresh Windows archive for an existing
locked checksum.
