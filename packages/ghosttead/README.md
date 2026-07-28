# @vibecook/ghosttead

The prebuilt Ghosttea terminal daemon. Installing this package pulls the
binary for the current platform through an `os`/`cpu`-gated optional
dependency, and `ghostteadPath()` names it:

```ts
import { spawn } from "node:child_process";
import { ghostteadPath } from "@vibecook/ghosttead";

const daemon = spawn(ghostteadPath(), { env: daemonEnvironment });
```

The daemon is configured entirely through its environment
(`GHOSTTEA_CONTROL_SOCKET`, `GHOSTTEA_FRAME_SOCKET`, `GHOSTTEA_AUTH_TOKEN`);
the one argument it understands is `--version`. The binary's version is the
package's version — both come from the same release tag.

## Resolution order

1. `GHOSTTEAD_BIN`, when set. This is the same override every consumer of the
   daemon already honors, and pointing it at a locally built
   `target/release/ghosttead` is how development against an unreleased daemon
   works — including on platforms with no prebuild.
2. The platform package for `${process.platform}-${process.arch}`:
   `@vibecook/ghosttead-darwin-arm64` or `@vibecook/ghosttead-win32-x64`.

Prebuilds exist exactly for the targets Ghosttea's release gate builds and
validates. On any other platform `ghostteadPath()` throws an error naming the
supported targets and the `GHOSTTEAD_BIN` way out.

## Bundlers

Resolution walks `node_modules` at runtime. An Electron main process that
bundles its dependencies should keep this package external, or resolve the
path at build time and carry it into the bundle.
