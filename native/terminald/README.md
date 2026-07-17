# ghosttea

Transport-neutral Rust service for Ghosttea terminal sessions. The embedding
application owns process lifecycle and may inject a separate remote transport
adapter through the `TerminalMesh` interface.

The sibling `ghosttea-core` crate owns terminal mutation, logical and replica
state, shaping, render caching, TRF1 production, ordered effects, and interaction
ordering policy. This service executes those effects and remains the desktop
host responsible for PTY processes, session summaries, frame broadcasts,
sockets, persistence, and remote mesh adapters. Its operation gate preserves
the core's effect order across concurrent PTY output, view actions, and input.

See <https://github.com/jamesyong-42/ghosttea> for integration documentation.
