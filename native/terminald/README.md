# ghosttea

Transport-neutral Rust service for Ghosttea terminal sessions. The embedding
application owns process lifecycle and may inject a separate remote transport
adapter through the `TerminalMesh` interface.

Platform-neutral model contracts and logical snapshot types live in the sibling
`ghosttea-core` crate. This service remains the desktop host responsible for PTY
processes, sockets, persistence, and remote mesh adapters.

See <https://github.com/jamesyong-42/ghosttea> for integration documentation.
