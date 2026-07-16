import { createGhostteaTerminalRuntime, waitForGhostteaRendererPorts } from "@vibecook/ghosttea-react";

export const terminalRuntime = createGhostteaTerminalRuntime({
  ports: waitForGhostteaRendererPorts(),
  clientBuild: "ghosttea-desktop",
  platform: {
    writeClipboard: (text) => window.desktop.writeClipboard(text),
    forceCanvasFallback: () => sessionStorage.getItem("ghosttea:force-canvas-fallback") === "1",
    setForceCanvasFallback: (enabled) => {
      if (enabled) sessionStorage.setItem("ghosttea:force-canvas-fallback", "1");
      else sessionStorage.removeItem("ghosttea:force-canvas-fallback");
    },
    reload: () => window.location.reload(),
  },
});
