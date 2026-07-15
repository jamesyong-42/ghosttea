# @vibecook/ghosttea

Typed browser client for connecting an Electron renderer to the Ghosttea
terminal service through a transferred control `MessagePort`.

```ts
import { ControlClient } from "@vibecook/ghosttea";

const client = new ControlClient(controlPort);
const response = await client.request({ type: "list-sessions" });
```

Ghosttea is developed at <https://github.com/jamesyong-42/ghosttea>.
