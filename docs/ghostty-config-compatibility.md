# Ghostty configuration compatibility

Ghosttea uses one versioned Rust configuration engine on the daemon, Electron,
and Apple FFI paths. The compatibility target is the repository's pinned
Ghostty 1.3.1 source at commit
`f8041e849b36efbbb9736b6ecf0ccfcb01d94e69`.

The goal is safe migration, not optimistic parsing. Every configured key is
reported as `applied`, `parsed`, or `unsupported`, and malformed or unknown
values remain visible in structured diagnostics.

## Sources and precedence

Ghosttea follows the
[pinned Ghostty 1.3.1 source order](https://github.com/ghostty-org/ghostty/blob/f8041e849b36efbbb9736b6ecf0ccfcb01d94e69/src/config/Config.zig#L4057-L4120):

1. `$XDG_CONFIG_HOME/ghostty/config` (legacy)
2. `$XDG_CONFIG_HOME/ghostty/config.ghostty`
3. On macOS, `~/Library/Application Support/com.mitchellh.ghostty/config` (legacy)
4. On macOS, `~/Library/Application Support/com.mitchellh.ghostty/config.ghostty`
5. An optional Ghosttea-owned `config.ghostty` overlay

If `XDG_CONFIG_HOME` is unset, `~/.config` is used. Missing standard files are
ignored. `config-file` includes are relative to their containing file, are
processed through the same
[breadth-first queue](https://github.com/ghostty-org/ghostty/blob/f8041e849b36efbbb9736b6ecf0ccfcb01d94e69/src/config/Config.zig#L4252-L4338)
as Ghostty, expand `~/`, support both `?optional/path` and
`?"optional path"`, and reject repeated recursive targets. An unquoted empty
`config-file` value clears the pending include queue. Includes from the
standard Ghostty files are fully resolved before the Ghosttea overlay, keeping
that app-owned file as the final layer. Empty values reset a key. Keys are
case-sensitive and comments are valid only on their own line, matching
Ghostty.

The desktop overlay lives in Electron's profile-specific user-data directory.
`open_config` creates and opens that file. Existing Ghostty files are read
automatically before it, so users do not need to copy their configuration just
to try Ghosttea.

## Current behavior

| Area                                             | Daemon / Electron                                                                                                                                    | Swift / Metal                                                                                                                                                        |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Foreground, background, cursor, selection colors | Applied live                                                                                                                                         | Available through the same snapshot; `GhostteaTerminal.apply(config:)` and `GhostteaTerminalMetalView.applyConfiguration(_:)` apply them                             |
| `scrollback-limit`                               | Applied to new sessions; default is Ghostty's 10,000,000 bytes                                                                                       | Available through `GhostteaTerminalConfiguration(config:)`; the core default is 10,000,000 bytes, while the iOS app may deliberately impose its device memory budget |
| `keybind`                                        | Mutations overlay the pinned 93-entry platform table; `clear`, blank reset, `unbind`, supported single-stroke actions, and `unconsumed:` are applied | Preserved in the shared API; the Swift workspace still has a smaller hand-written action router                                                                      |
| `window-padding-x/y`                             | Parsed, not yet used by the fixed desktop cell geometry                                                                                              | Applied by `GhostteaTerminalMetalView.applyConfiguration(_:)`                                                                                                        |
| `font-family`, `font-size`                       | Parsed, but runtime font metrics are still selected at process startup                                                                               | Parsed; callers must select metrics while constructing `GhostteaRuntime`                                                                                             |
| `custom-shader`                                  | `ghosttea:better-crt` is applied by WebGPU; Canvas fallback and arbitrary Ghostty GLSL are unsupported                                               | Diagnosed/preserved; Metal post-processing is not implemented                                                                                                        |

Other recognized keys—including `theme`, `palette`, background opacity,
shell integration, and most window/application behavior—are currently reported
as `unsupported`; importing them never creates a false success signal.

The CRT effect is off by default. Ghosttea's bundled approximation is opt-in
with the Ghostty key and a namespaced value:

```text
custom-shader = ghosttea:better-crt
```

This value is a Ghosttea extension. Normal Ghostty shader paths are preserved
in the snapshot but are not executed: silently treating arbitrary GLSL as the
bundled CRT effect would be incorrect.

Desktop key sequences, key tables, chained actions, and the full
`all:`/`global:`/`performable:` semantics are preserved in the snapshot but are
not applied yet. An unsupported action never replaces a working default
binding. Ghosttea's product-owned `super+shift+o` remote-session shortcut
currently takes precedence if an imported config uses the same trigger.

## APIs

Protocol 1.10 adds:

- `get-config` → a `config` response
- `reload-config` → a `config` response and, when changed, a pushed
  `config-changed` event
- `configRevision` on the hello response as the capability signal

The JSON object is `ghosttea-config` schema version 1 and is represented by
`ConfigSnapshot` in TypeScript and `GhostteaConfigSnapshot` in Swift. Apple
loads it through `ghosttea_config_load_json`, the same Rust implementation used
by `ghosttead`.

Reload immediately updates model colors and desktop presentation. Scrollback
limits apply only to new sessions. Parsed startup-only settings remain visible
so a settings UI can explain that a restart or future implementation is
required.

## Upgrade discipline

`known-keys.txt` is derived from
`bench/ghostty-ux/ground-truth/config-macos-default.txt`. The Ghostty upgrade
gate compares those files and verifies the config engine's pinned commit against
`native/ghostty.lock.json`; a vendor upgrade cannot silently drift the schema.

The canonical syntax and source behavior are documented by
[Ghostty configuration](https://ghostty.org/docs/config), and individual option
semantics by the
[Ghostty option reference](https://ghostty.org/docs/config/reference).
