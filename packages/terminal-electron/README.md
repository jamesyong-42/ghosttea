# `@vibecook/ghosttea-electron`

Electron lifecycle and direct renderer transport for Ghosttea.

Use managed mode when this package should start a configured Rust service. Use
external mode when the Electron application already owns a Rust composition
service and only wants Ghosttea to attach its authenticated control and frame
channels.

Frame payloads travel directly from the utility process to renderer
MessagePorts. They are not routed through Electron main.
