# @vibecook/ghosttea-protocol

TypeScript definitions and runtime guards for the Ghosttea control protocol.
This package is shared by the Electron bridge and renderer client.

Protocol 1.11 distinguishes the resolved `ConfigSnapshot` from the exact
`ConfigDocument` source. The latter is local and privileged, preserves unknown
Ghostty syntax and comments, and uses raw revision conditional-replacement
responses instead of asking clients to serialize a projection back to disk.
`RendererClientCommand` and `isRendererClientCommandAllowed` form an explicit
allowlist; privileged document commands and future unreviewed command families
are rejected by the Electron renderer bridge.

Ghosttea is developed at <https://github.com/vibecook-dev/ghosttea>.
