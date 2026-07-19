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

## Embedded service mode

`TerminalService::run()` is the standalone convenience path used by
`ghosttead`: it removes stale socket paths, binds both configured Unix sockets,
and serves them. An application that owns its runtime directory, socket
permissions, and startup ordering can instead create the listeners and pass
them to `serve()`:

```rust,ignore
use ghosttea::{
    TerminalService, TerminalServiceConfig, TerminalServiceListeners,
};
use tokio::net::UnixListener;

let control = UnixListener::bind(&control_path)?;
let frames = UnixListener::bind(&frame_path)?;
set_private_socket_permissions(&control_path)?;
set_private_socket_permissions(&frame_path)?;

let service = TerminalService::new(TerminalServiceConfig {
    // `serve` uses the supplied listeners; these paths remain the fallback
    // endpoints used if the same service is started through `run`.
    control_socket: control_path.clone(),
    frame_socket: frame_path.clone(),
    auth_token: stable_random_token.clone(),
})
.with_private_env_prefixes(["FIELD_"])?
.with_text_engine(application_text_engine)
.with_terminal_mesh(application_terminal_mesh);

service
    .serve(TerminalServiceListeners::new(control, frames))
    .await?;
```

The host owns listener creation, replacement, permissions, and unlinking when
it supplies listeners. Dropping or cancelling the `serve()` future stops
accepting traffic and aborts the terminal mesh task, but it is not a graceful
session-drain API. A host that needs classified shutdown events should
terminate its sessions before cancellation.

The bearer token authenticates both local sockets. Keep the runtime directory
private to the host user and do not place the token in a child environment.
The built-in Ghosttea, legacy terminald, external-connection, and Truffle
variables are removed from inherited PTY environments. Embedding applications
should register every additional private prefix with
`with_private_env_prefixes`; empty prefixes are rejected. Explicit clean-mode
variables and inherited-mode overrides are intentional caller input and may
reintroduce a value.

Electron external mode reads its socket paths and token when the backend is
constructed. Those values must remain valid while that backend is recovering
from an embedded-service restart. Rotating them requires constructing a new
backend and transferring fresh renderer ports.

## Shared Truffle ownership

`TerminalService` accepts a `TerminalMesh` by value and never creates or stops
the application's Truffle node. `TruffleTerminalMesh` retains a clone of the
host-owned `Arc<Node<TailscaleProvider>>`, so the application can share one
identity, peer registry, state directory, and sidecar across terminal and
non-terminal services.

The default terminal adapter claims QUIC port `9420`, compact Apple-client port
`9421`, store `terminal.v1.hosts`, and SyncedStore namespace
`ss:terminal.v1.hosts`. The host owns the Truffle app ID, state directory,
sidecar lifecycle, and collision-free allocation of ports and service names.
Every crate that shares the `Arc<Node>` must resolve the same `truffle-core`
version and source so the Rust type is identical.

Local authentication currently uses one bearer token rather than scoped
credentials. Hosts requiring per-client authorization should put a policy
boundary in front of this service or extend the protocol deliberately; socket
permissions and constant-time token verification do not provide command-level
scopes.

See <https://github.com/jamesyong-42/ghosttea> for the complete repository.
