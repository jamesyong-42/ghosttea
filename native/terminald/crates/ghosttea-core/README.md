# ghosttea-core

Platform-neutral terminal model contracts shared by Ghosttea desktop and Apple
hosts. This crate must not depend on PTYs, child processes, Tokio networking,
Unix sockets, Electron, Truffle, UIKit, or Swift.

The crate owns the ordered terminal-effect contract, logical snapshot types,
Ghostty terminal model, render cache, shaping integration, and TRF1 producer.
Desktop `Session` supplies PTY bytes and executes returned effects; process and
socket policy remain outside this crate.
