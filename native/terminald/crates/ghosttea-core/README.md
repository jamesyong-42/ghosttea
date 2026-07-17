# ghosttea-core

Platform-neutral terminal model contracts shared by Ghosttea desktop and Apple
hosts. This crate must not depend on PTYs, child processes, Tokio networking,
Unix sockets, Electron, Truffle, UIKit, or Swift.

The first extraction step owns the ordered terminal-effect contract and logical
snapshot types. Subsequent mechanical steps move the Ghostty terminal model,
render cache, shaping, and TRF1 producer behind this boundary while retaining
the checked-in desktop parity golden.
