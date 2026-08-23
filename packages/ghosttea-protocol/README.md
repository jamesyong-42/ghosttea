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

## TPv3 routed transport contract

The package root also exports the additive routed terminal contract: grant and
ticket guards, tagged control/frames message codecs, RFC 8785 canonical grant
input, close classification, scene-stamp ordering, CRC-32C, and the binary
presentation-envelope codec. Readers tolerate unknown object fields and
capability strings while enforcing known tags, direction allowlists, scalar
constraints, grant shapes, loopback-only ticket endpoints, and envelope
kind-specific invariants.

After building this package, its compatibility helper can check the complete
published VibeField fixture corpus and fails if a new `tp-*.json` vector is not
classified:

```sh
npm run build --workspace @vibecook/ghosttea-protocol
node packages/ghosttea-protocol/scripts/verify-vibefield-vectors.mjs \
  /path/to/vibe-field/packages/contracts/fixtures
```

Ghosttea is developed at <https://github.com/vibecook-dev/ghosttea>.
