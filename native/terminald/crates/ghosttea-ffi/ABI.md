# Ghosttea C ABI v1

`include/ghosttea.h` is the stable Apple and C consumer boundary. Rust types are
never exposed. Every versioned input begins with `abi_version` and
`struct_size`; v1 accepts structures at least as large as its known layout and
rejects unknown ABI versions.

## Ownership

- Runtime creation synchronously copies every borrowed font byte view.
- `ghosttea_owned_bytes_t` is released exactly once with
  `ghosttea_owned_bytes_free`.
- `ghosttea_update_t` owns one aligned arena containing its ordered descriptor
  table and all payloads. Only `ghosttea_update_destroy` releases it.
- Effect payload offsets are relative to `update.storage.data`. Binary terminal
  replies and TRF1 frames stay binary; metadata and logical/accessibility data
  use UTF-8 JSON.
- Runtime handles must outlive terminals. Destroying a null handle or empty
  output is a no-op.

## Ordering and threading

Descriptor sequence numbers are contiguous from zero and preserve the exact
`TerminalEffect` order returned by `ghosttea-core`. In particular, a terminal
reply discovered during `feed` precedes later semantic, logical snapshot, and
frame effects. Runtime handles may back multiple terminals concurrently, but a
terminal handle is single-owner and must be externally serialized. The Swift
wrapper enforces this with an actor.

## Errors and poison

`ghosttea_last_error_message` is thread-local and valid until the next FFI call
on the same thread. Swift copies it immediately. Panics never unwind across C:

- terminal-local panics poison that terminal;
- a panic in an operation that may touch shared shaping state poisons both the
  terminal and runtime;
- poisoned handles reject every operation with `INVALID_STATE`;
- only poison inspection, last-error copying, and destruction remain legal.

The implementation conservatively treats every rendered update as shared-state
scope. This may fail more sessions after a panic, but never permits reuse of a
possibly corrupted text engine.

## Compatibility

Adding an effect kind or function is backward compatible when old structure
layouts and semantics remain valid. Changing field meaning, ownership, enum
values, descriptor layout, or payload encoding requires a new ABI version.
Generated Apple artifact metadata records the ABI/package version, source
commit, toolchains, header digest, targets, and per-slice library digests.
