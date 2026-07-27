# @vibecook/ghosttea

Typed browser client for connecting an Electron renderer to the Ghosttea
terminal service through a transferred control `MessagePort`.

Node daemons that connect directly to the authenticated local control socket
should use the separate `@vibecook/ghosttea-client` package.

```ts
import { ControlClient } from "@vibecook/ghosttea";

const client = new ControlClient(controlPort);
const response = await client.request({ type: "list-sessions" });
```

Ghosttea is developed at <https://github.com/vibecook-dev/ghosttea>.
