# `@vibecook/ghosttea-client`

Electron-free Node control client for a Ghosttea terminal service. It connects
to the authenticated local control socket and exposes typed session lifecycle
and human-input-epoch-guarded automation operations. It never opens the frame
socket, attaches a renderer view, or claims terminal layout authority.

```ts
import { GhostteaAutomationClient } from "@vibecook/ghosttea-client";

const client = new GhostteaAutomationClient({
  controlSocket: "/private/runtime/ghosttea-control.sock",
  authToken: process.env.GHOSTTEA_CLIENT_TOKEN!,
});

const session = await client.createSession({
  executable: "/bin/zsh",
  args: [],
  environment: { mode: "clean", variables: { PATH: "/usr/bin:/bin" } },
  cols: 120,
  rows: 40,
  persistence: "terminate-with-app",
});
const exited = client.waitForExit(session.id);
await client.pasteAndSubmit(session.id, "exit 0");
await exited;
client.dispose();
```

`@vibecook/ghosttea` is the separate browser `MessagePort` client used by
renderers. This package is Node-specific and speaks the local length-prefixed
control-socket protocol directly.
