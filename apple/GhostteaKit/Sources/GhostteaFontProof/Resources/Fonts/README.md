# Bundled parity fonts

The five fonts pinned by `native/fonts.lock.json` are committed here rather than generated.

`GhostteaFonts` declares this directory as a `.process("Fonts")` resource, and `GhostteaCore`
depends on it — so an empty directory fails SwiftPM at package-graph load, taking down every
product including the pure-Swift ones. Committing them is what lets a clean checkout, and
therefore a SwiftPM URL dependency, build this package without running a materializer first.

They are extracted from the pinned Ghostty tree, not vendored independently. To update them,
change the pin in `native/fonts.lock.json` and re-run:

```sh
npm run bootstrap:ghostty-vt   # if native/vendor/ghostty is absent or off the pin
npm run sync:fonts             # re-extracts and re-verifies, then commit the result
```

`npm run check:bundled-fonts` verifies the committed bytes against the lock's SHA-256 digests,
so drift between these files and the pin fails closed. The accompanying OFL license and notices
come from the same pinned tree.
