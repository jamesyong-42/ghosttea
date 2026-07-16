import { build } from "esbuild";

await build({
  entryPoints: ["src/terminal-render.worker.ts"],
  outfile: "dist/terminal-render.worker.js",
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  sourcemap: true,
  legalComments: "none",
});
