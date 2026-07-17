# ghosttea

Transport-neutral Rust service for Ghosttea terminal sessions. The embedding
application owns process lifecycle and may inject a separate remote transport
adapter through the `TerminalMesh` interface.

The sibling `ghosttea-core` crate owns terminal mutation, logical state, shaping,
render caching, TRF1 production, and ordered effects. This service executes
those effects and remains the desktop host responsible for PTY processes,
sockets, persistence, and remote mesh adapters.

See <https://github.com/jamesyong-42/ghosttea> for integration documentation.
