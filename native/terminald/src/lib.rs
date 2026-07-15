//! Reusable terminal service and its optional Truffle transport adapter.
//!
//! The embedding application owns the Truffle node, sidecar, identity, state
//! directory, and shutdown order. Pass the same host-owned `Arc<Node<_>>` to
//! [`TruffleTerminalMesh`] and to any other Rust services that use Truffle.

mod authority;
mod frame;
pub mod mesh;
mod replica;
mod service;
mod session;
pub mod tunnel_protocol;

pub use mesh::{TruffleTerminalConfig, TruffleTerminalMesh};
pub(crate) use service::Registry;
pub use service::{TerminalService, TerminalServiceConfig};
