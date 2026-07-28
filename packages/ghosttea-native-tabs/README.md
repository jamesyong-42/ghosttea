# @vibecook/ghosttea-native-tabs

AppKit owns the real order of native window tabs the moment a user drags one,
and Electron does not expose it. This package ships the N-API addon that reads
it, prebuilt as a macOS universal binary — no toolchain, no `node-gyp`, no
Electron-version matrix, because N-API is ABI-stable across Node and Electron.

```ts
import { loadNativeTabs } from "@vibecook/ghosttea-native-tabs";

const native = loadNativeTabs(); // null everywhere but macOS
const order = native?.tabOrder(windows.map((w) => w.getNativeWindowHandle()));
```

`tabOrder` returns the AppKit tab order as an array of indexes into the
handles you passed; validate its shape before trusting it, as any consumer of
a native boundary should.

## Bundled main processes

A bundled Electron main process cannot `require` a `.node` file that stayed
behind in `node_modules`. Copy the addon next to your build output and load it
from there:

```ts
import { addonPath } from "@vibecook/ghosttea-native-tabs";

// at build time
copyFileSync(addonPath()!, join(dist, "native", "ghosttea_native_tabs.node"));
```

Off macOS both `addonPath()` and `loadNativeTabs()` return `null`, which is
the contract: no native tabs, not an error.
