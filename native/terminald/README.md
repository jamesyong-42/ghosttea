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
`ghosttead`: it removes stale endpoints, binds both configured endpoints, and
serves them. An application that owns its runtime directory, endpoint
permissions, and startup ordering can instead create the listeners and pass
them to `serve()`:

```rust,ignore
use ghosttea::{
    ipc, TerminalService, TerminalServiceConfig, TerminalServiceListeners,
};

let control = ipc::Listener::bind(&control_path)?;
let frames = ipc::Listener::bind(&frame_path)?;
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
it supplies listeners. On Unix an endpoint is a socket path and
`ipc::Listener` also accepts a `tokio::net::UnixListener` through `From`, so a
host that binds its own socket can pass it straight in. Dropping or cancelling
the `serve()` future stops accepting traffic and aborts the terminal mesh task,
but it is not a graceful session-drain API. A host that needs classified
shutdown events should terminate its sessions before cancellation.

## Local endpoints by platform

| Platform | Control | Frames |
| --- | --- | --- |
| macOS, Linux | Unix-domain socket | second Unix-domain socket |
| Windows | named pipe | second named pipe |

Windows pipe names share one flat, machine-wide namespace instead of sitting
under a private directory, so each name carries an instance suffix and the
listener refuses to bind a name that already exists. That refusal is what stops
another process from publishing the pipe first and collecting connections meant
for the service.

A named pipe created without an explicit security descriptor gets a permissive
default DACL — read access for Everyone and for Anonymous. The listener instead
builds `D:P(A;;FA;;;<current user SID>)`, a protected DACL granting full access
to the account running the service and nothing to anyone else, and applies it to
every instance it creates. On Unix the runtime directory's permissions provide
the same boundary. `ipc::Listener` asserts the resulting DACL against a live
pipe handle in its tests, because passing a descriptor that never reaches the
object fails silently.

A pipe can only offer one instance at a time, so a client that dials while the
listener is between instances, or while another client is being accepted, gets
`ERROR_PIPE_BUSY`. Windows expects clients to wait and retry; `openEndpoint` in
`@vibecook/ghosttea-client` implements that, and any other client must do the
same. Unix sockets queue in the kernel and never take this path.

The bearer token authenticates both local endpoints. Keep the runtime directory
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
