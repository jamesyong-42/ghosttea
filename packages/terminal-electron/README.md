# `@vibecook/ghosttea-electron`

Electron lifecycle and direct renderer transport for Ghosttea.

Use managed mode when this package should start a configured Rust service. Use
external mode when the Electron application already owns a Rust composition
service and only wants Ghosttea to attach its authenticated control and frame
channels.

Frame payloads travel directly from the utility process to renderer
MessagePorts. They are not routed through Electron main.

The backend also owns a control-only `GhostteaAutomationClient` for
application-driven sessions and input. It never opens the frame socket,
attaches a renderer view, or claims focus/resize authority:

```ts
await backend.start();
const session = await backend.automation.createSession({
  executable: "claude",
  args: [],
  environment: { mode: "clean", variables: agentEnvironment },
  cols: 120,
  rows: 40,
  persistence: "terminate-with-app",
});
const result = await backend.automation.pasteAndSubmit(session.id, "Review this repository");
if (!result.accepted) {
  // Human input was accepted after the automation epoch was observed.
}
```

Automation paste and submission are one ordered PTY operation. Human input
invalidates a stale automation epoch rather than being delayed.

Hosts that already own a `TerminalDaemonConnection` can import
`GhostteaAutomationClient` directly from
`@vibecook/ghosttea-electron/automation`. That subpath is Node-only and does
not load Electron main-process modules.
