# Ghosttea embeddable Electron refactor

Status: extraction implemented; Chopsticks compatibility extensions pending

Implementation note (July 2026): sections 3 through 7 are implemented. The
desktop demo now consumes `@vibecook/ghosttea-electron` and
`@vibecook/ghosttea-react` in managed mode, while the Electron package also
supports an externally owned `ghosttead` connection. Package, integration,
desktop development, unsigned packaged-app, and repeated release benchmark
checks pass. Section 8 remains the next compatibility phase before Chopsticks
can replace its current terminal backend.

This refactor turns the terminal integration currently embedded in
`apps/desktop` into supported packages that another Electron application can
consume. The first consumer after the demo will be the Chopsticks workbench.

The refactor is deliberately staged as an extraction. It must not change the
terminal protocol, native daemon, output transport, render worker, GPU
renderers, or the number of processes and message hops on the default path.

## 1. Goals

- Let an Electron application own one `ghosttead` service and connect one or
  more renderer windows to it.
- Publish the Electron lifecycle and renderer integration that currently exist
  only in the demo application.
- Let a host such as Chopsticks implement terminal creation and programmatic
  input without depending on Ghosttea from its core packages.
- Remove demo-specific globals and application chrome from the reusable
  terminal surface.
- Keep the current desktop demo as the reference integration and behavioral
  conformance application.
- Preserve the current performance architecture exactly during extraction.

## 2. Non-goals

- Rewriting the render worker or WebGPU renderer.
- Changing TRF1 frames or the control protocol during the extraction commits.
- Moving frame processing through Electron main, React, JSON, or base64.
- Bundling Truffle inside an npm library. The consuming application continues
  to own Truffle and the `ghosttead` composition.
- Making Chopsticks core depend directly on Ghosttea.
- Adding platforms beyond the artifact targets Ghosttea currently supports.

## 3. Performance invariants

These are hard architectural constraints, not optimization suggestions.

The output path remains:

```text
PTY
  -> ghosttead / Ghostty parser / text engine
  -> frame Unix socket
  -> Electron utility process
  -> transferable MessagePort ArrayBuffer
  -> renderer runtime
  -> transferable Web Worker ArrayBuffer
  -> WebGPU submit
```

The refactor must preserve all of the following:

1. Electron main never receives or copies frame payloads.
2. React state is never updated for individual frames or terminal cells.
3. Frame payloads are not converted to JSON, strings, or base64.
4. The renderer runtime forwards each frame directly to the existing worker.
5. The worker remains the owner of frame decoding and renderer state.
6. There remains one render worker per runtime, not one worker per React
   component.
7. Mounting a component does not introduce an additional canvas or bitmap
   copy.
8. The default control and input paths keep the same process and MessagePort
   hop counts.
9. No general-purpose event emitter, state store, or middleware runs on the
   frame path.
10. Instrumentation is disabled by default and has no production hot-path
    allocations.

The current bridge performs one `ArrayBuffer` extraction before transferring a
frame. The extraction may be optimized separately, but this refactor must not
add another copy or combine that optimization with package movement.

## 4. Target packages

The existing low-level packages remain:

| Package                       | Responsibility                    |
| ----------------------------- | --------------------------------- |
| `@vibecook/ghosttea-protocol` | Typed control commands and events |
| `@vibecook/ghosttea-frame`    | Binary frame types and decoder    |
| `@vibecook/ghosttea`          | Low-level `ControlClient`         |

Two packages are added.

### 4.1 `@vibecook/ghosttea-electron`

This package owns Electron/Node integration, but not application chrome or
Truffle configuration.

Proposed exports:

```text
@vibecook/ghosttea-electron/main
@vibecook/ghosttea-electron/preload
@vibecook/ghosttea-electron/types
@vibecook/ghosttea-electron/bridge-entry
```

Responsibilities:

- start, stop, and monitor a configured `ghosttead` executable;
- create private socket paths and an authentication token;
- expose the daemon connection descriptor;
- start the existing utility-process bridge;
- attach direct control/frame MessagePorts to a renderer;
- provide a small preload helper that transfers those ports into the isolated
  renderer world;
- recover the transport after an unexpected daemon or bridge exit.

The supervisor must receive host configuration instead of importing Electron
application state internally:

```ts
interface GhostteaDaemonOptions {
  binary: GhostteaBinary;
  runtimeDirectory?: string;
  environment?: NodeJS.ProcessEnv;
  startupTimeoutMs?: number;
}

type GhostteaBinary =
  { kind: "executable"; path: string; args?: string[] } | { kind: "cargo"; manifestPath: string; release: boolean };
```

The demo remains responsible for resolving development Cargo paths, packaged
resource paths, profile directories, and the host-owned Truffle sidecar.

`electron` is a peer dependency. The package does not publish or install an
Electron runtime.

### 4.2 `@vibecook/ghosttea-react`

This package owns the renderer runtime and terminal surface.

Proposed public API:

```ts
interface GhostteaRendererPorts {
  control: MessagePort;
  frames: MessagePort;
}

interface GhostteaRendererPlatform {
  writeClipboard(text: string): void;
  readClipboard(): string;
  getFallbackRenderer(): boolean;
  setFallbackRenderer(enabled: boolean): void;
}

interface BeforeUserInput {
  (input: GhostteaUserInput): void | Promise<void>;
}

interface GhostteaRuntimeOptions {
  ports: Promise<GhostteaRendererPorts> | GhostteaRendererPorts;
  platform: GhostteaRendererPlatform;
  beforeUserInput?: BeforeUserInput;
  workerFactory?: () => Worker;
}

const runtime = createGhostteaRuntime(options);

<GhostteaProvider runtime={runtime}>
  <TerminalSurface
    session={session}
    theme={theme}
    active={active}
    onActivate={activate}
    actionsRef={actionsRef}
  />
</GhostteaProvider>;
```

The package contains:

- the existing renderer runtime;
- frame resynchronization and sequence handling;
- the existing worker entry;
- Canvas2D and WebGPU renderers;
- cell-width and renderer types;
- `TerminalSurface` and its minimal terminal-only CSS;
- a React provider used only to locate the runtime.

`react` and `react-dom` are peer dependencies. The frame path does not travel
through the provider or React context; the runtime continues posting frames
directly to the worker.

Application concerns remain outside this package:

- tabs and split trees;
- global hotkeys;
- fullscreen and window closing;
- native context-menu construction;
- profile selection;
- remote-session palette presentation;
- application themes and chrome.

`TerminalSurface` exposes imperative terminal actions for application menu
integration: focus, copy selection, paste, select all, and clear screen.

## 5. Runtime ownership

The current module-level `terminalRuntime` singleton becomes an explicitly
created runtime supplied through `GhostteaProvider`.

This is an ownership change, not a data-path change:

- a normal window still creates exactly one runtime and one worker;
- every terminal surface in that window shares the runtime;
- frame dispatch remains a direct `MessagePort -> runtime -> Worker` operation;
- disposing the provider closes ports, terminates the worker, and rejects
  pending control and selection requests;
- development Strict Mode cannot create two durable runtimes accidentally.

The runtime accepts its ports rather than listening for a hard-coded global
window message. The preload helper keeps the existing transferred-port
bootstrap for the demo.

## 6. Host input and automation seam

Ghosttea must distinguish human input from application automation without
putting Chopsticks policy into Ghosttea.

### 6.1 Default fast path

When `beforeUserInput` is absent, key, paste, mouse, and focus behavior follows
the current direct control-port path. There is no promise allocation and no
additional IPC hop.

When the hook returns `void`, it runs synchronously and input is sent
immediately afterward.

Only when the hook returns a `Promise` does the runtime queue that view's input
until the promise settles. Output rendering and other sessions are unaffected.

This lets Chopsticks pay an acknowledged Electron IPC round trip only while a
guarded prompt injection is actually pending. Ordinary typing remains on the
direct Ghosttea path.

### 6.2 Programmatic input

The Electron package will expose a main-side control client suitable for host
automation. It attaches a non-rendering application view to a session and
sends text through the normal authenticated Ghosttea protocol. It does not
claim focus/resize control.

Chopsticks can implement its existing `AgentHost` as:

```ts
spawnTerminal(spec) -> ghosttea.createSession(spec)
writeTerminal(id, data) -> ghostteaAutomation.write(id, data)
```

The programmatic path never invokes `beforeUserInput`.

Strict Chopsticks user-priority ordering is implemented by its renderer hook:
while an injection guard is pending, the hook awaits acknowledgment from the
Chopsticks runtime before allowing the human bytes onto the terminal control
port.

## 7. Demo composition after extraction

`apps/desktop` remains private and becomes a real consumer of the packages.

Files that remain application-owned:

```text
main/index.ts
main/profile.ts
preload/index.ts
renderer/App.tsx
renderer/RemoteSessionPalette.tsx
renderer/pane-layout.ts
renderer/hotkeys.ts
renderer/themes.ts
renderer/styles.css        # chrome and layout only
```

Files whose implementation moves into packages:

```text
main/terminal-supervisor.ts          -> ghosttea-electron
utility/terminal-bridge.ts           -> ghosttea-electron
shared transport types               -> ghosttea-electron
renderer/runtime.ts                  -> ghosttea-react
renderer/TerminalSurface.tsx         -> ghosttea-react
renderer/terminal-render.worker.ts   -> ghosttea-react
renderer/frame-*.ts                  -> ghosttea-react
renderer/cell-width.ts               -> ghosttea-react
renderer/renderers/*                 -> ghosttea-react
```

The demo preload can expose its window/menu/clipboard API independently and
call the Ghosttea preload helper for terminal ports.

## 8. Compatibility work after extraction

These changes are required for Chopsticks, but are kept out of the mechanical
package extraction so regressions can be attributed precisely.

### 8.1 Environment policy

Add an explicit session option:

```ts
envPolicy: "inherit" | "replace";
```

`inherit` preserves existing Ghosttea behavior. `replace` calls
`CommandBuilder::env_clear()` before applying the provided environment.
Chopsticks uses `replace` with its curated agent environment.

### 8.2 Process lifecycle

Move full owned-process termination into Ghosttea:

```text
interrupt -> grace period -> terminate group -> grace period -> kill group
```

POSIX uses the owned process group. Windows support should use a Job Object
when the Windows PTY artifact is introduced. Termination is asynchronous and
returns the observed outcome.

### 8.3 Session metadata

Extend session and exit data with:

- PID;
- creation timestamp;
- exit signal when available;
- requested termination source;
- classified termination outcome.

Protocol minor-version compatibility must be maintained while fields are
added.

### 8.4 Automation client

Add the main-side control connection and hidden application-view lifecycle.
This work does not touch frame delivery.

## 9. Implementation sequence

Each numbered item should be its own reviewable commit or small commit series.

1. **Baseline and instrumentation**
   - run the full test/build/package suite;
   - capture repeated release benchmark results outside the source tree;
   - add a renderer-path benchmark before changing that path;
   - record process count, worker count, frame hop count, and memory.
2. **Package scaffolding**
   - add `ghosttea-electron` and `ghosttea-react` manifests and build configs;
   - publish no new behavior;
   - extend the existing temporary tarball-consumer check to cover both new
     packages.
3. **Mechanical renderer extraction**
   - move worker, renderers, frame helpers, and their tests;
   - keep algorithms and message shapes unchanged;
   - make the demo consume the package.
4. **Runtime ownership extraction**
   - inject ports, platform services, and worker factory;
   - introduce the provider and imperative actions;
   - remove demo globals from reusable code;
   - confirm one runtime and worker per window.
5. **Mechanical Electron extraction**
   - move supervisor, bridge, and transport types;
   - inject app paths, binary selection, and environment;
   - keep the utility-process topology unchanged.
6. **External fixture**
   - pack the npm packages;
   - install them into a temporary Electron fixture outside the workspace;
   - build, launch, create a session, type, resize, scroll, and exit.
7. **Behavioral parity gate**
   - run the demo through shell, Claude, Codex, and Grok sessions;
   - exercise splits, focus, selection, mouse mode, resize, reload, and daemon
     recovery.
8. **Performance parity gate**
   - repeat the baseline measurements on the same machine and release binary;
   - do not begin Chopsticks compatibility work until this gate passes.
9. **Compatibility extensions**
   - add environment replacement, lifecycle semantics, metadata, automation,
     and the optional user-input gate one at a time;
   - rerun focused behavior and performance gates after each change.

## 10. Verification gates

### 10.1 Required correctness commands

```sh
npm test
npm run check
npm run build
npm run package:check
npm run test:integration
```

The external fixture must consume packed tarballs, never workspace links.

### 10.2 Required performance checks

Use a release `ghosttead`, fixed grid and workload scale, and at least one
warm-up followed by seven measured runs.

```sh
cargo build --release --package ghosttead
GHOSTTEAD_BIN=./target/release/ghosttead npm run bench:json
```

The refactor passes only when:

- the architectural invariants in section 3 are unchanged;
- median sidecar throughput has no statistically meaningful regression, with
  a hard ceiling of 3%;
- control RTT p50/p99 has no statistically meaningful regression;
- renderer frame throughput, input latency, and resize latency do not regress;
- steady-state renderer CPU and memory do not materially increase;
- exactly one render worker exists per window;
- no long task is introduced on the renderer UI thread during output flood.

Numeric thresholds exist to account for measurement noise; they are not a
budget to spend. Any repeatable regression must be explained and removed even
when it falls below the ceiling.

### 10.3 Review rule

Do not combine package movement with performance optimization or protocol
behavior changes. A pure extraction should be reversible and attributable. If
a parity gate fails, revert the latest stage rather than patching over the
regression across package boundaries.

## 11. Chopsticks boundary

Once Ghosttea passes the extraction and compatibility gates, Chopsticks adds a
separate `@vibecook/chopsticks-ghosttea` adapter. Its core, runtime, provider
adapters, workspace logic, and recording remain terminal-backend-neutral.

The Chopsticks workbench can then remove `node-pty`, Avocado, Restty, xterm,
the PTY host, replay buffering, and its renderer backend adapter after its own
cross-backend conformance tests pass.
