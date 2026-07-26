# ghosttea-vt

Safe Rust wrapper around the Ghostty `libghostty-vt` terminal core used by
Ghosttea.

Native artifact resolution and linking are delegated to `ghosttea-vt-sys`.
The safe wrapper does not bundle or build Ghostty itself.
