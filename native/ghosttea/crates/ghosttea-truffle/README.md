# ghosttea-truffle

Truffle transport adapter for the embedded `ghosttea` terminal service.

The adapter accepts an application-owned
`Arc<Node<TailscaleProvider>>` and exposes Ghosttea terminal discovery,
mirroring, control, and compact Apple-client streams through that shared
Truffle identity. It does not create or stop the Truffle node and does not
package the Truffle sidecar.

```rust,ignore
use std::sync::Arc;

use ghosttea::{TerminalService, TerminalServiceConfig};
use ghosttea_truffle::{TruffleTerminalConfig, TruffleTerminalMesh};

let terminal_mesh = TruffleTerminalMesh::new(
    Arc::clone(&truffle_node),
    TruffleTerminalConfig {
        service_name: "terminal.v1".into(),
        quic_port: 9420,
        compact_port: 9421,
        capability: None,
        allow_tailnet_write: false,
    },
)?;

TerminalService::new(TerminalServiceConfig {
    control_socket,
    frame_socket,
    auth_token,
})
.with_terminal_mesh(terminal_mesh)
.run()
.await?;
```

The embedding application owns the Truffle application ID, state directory,
sidecar lifecycle, port allocation, and authorization policy. Every crate
sharing the live node must resolve the same `truffle-core` version and source
so the `Node` type is identical.

Remote peers are read-only by default. Supply a capability for controlled
write access, or deliberately enable tailnet-wide writes only when every
same-application peer should be trusted.
