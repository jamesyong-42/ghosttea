/**
 * node-pty ships macOS/Linux spawn-helper binaries without the executable bit
 * in some npm install layouts, which surfaces as a confusing "posix_spawnp failed".
 */
import { chmodSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);

function fixHelpers(root) {
  const prebuilds = join(root, "prebuilds");
  if (!existsSync(prebuilds)) return 0;
  let fixed = 0;
  for (const platform of readdirSync(prebuilds)) {
    const helper = join(prebuilds, platform, "spawn-helper");
    if (!existsSync(helper)) continue;
    const mode = statSync(helper).mode;
    if ((mode & 0o111) === 0) {
      chmodSync(helper, mode | 0o755);
      fixed += 1;
      console.log(`[fix-node-pty] chmod +x ${helper}`);
    }
  }
  return fixed;
}

let root;
try {
  root = dirname(dirname(require.resolve("node-pty/package.json")));
} catch {
  // Also try resolving from this monorepo root when run as a postinstall.
  root = join(dirname(fileURLToPath(import.meta.url)), "../node_modules/node-pty");
}

if (!existsSync(root)) {
  console.log("[fix-node-pty] node-pty not installed; skip");
  process.exit(0);
}

const fixed = fixHelpers(root);
if (fixed === 0) console.log("[fix-node-pty] spawn-helper already executable (or absent)");
