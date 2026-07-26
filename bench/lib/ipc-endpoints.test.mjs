import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";

import { MISSING_GRACE_MS, localEndpoints } from "./ipc-endpoints.mjs";

const root = resolve(import.meta.dirname, "../..");

test("names each Windows channel uniquely in the shared pipe namespace", () => {
  const platform = process.platform;
  if (platform !== "win32") return;
  const first = localEndpoints("/ignored");
  const second = localEndpoints("/ignored");
  assert.match(first.controlSocket, /^\\\\\.\\pipe\\ghosttea-/);
  assert.notEqual(first.controlSocket, first.frameSocket);
  assert.notEqual(first.controlSocket, second.controlSocket);
});

test("keeps both Unix channels inside the private runtime directory", () => {
  if (process.platform === "win32") return;
  const { controlSocket, frameSocket } = localEndpoints("/run/ghosttea");
  assert.equal(controlSocket, join("/run/ghosttea", "control.sock"));
  assert.equal(frameSocket, join("/run/ghosttea", "frames.sock"));
});

/**
 * The harnesses repeat `openEndpoint` because they run without a built SDK, so
 * the two copies can drift apart silently. They already did once: a change to
 * how an unpublished endpoint is retried landed only in the published client.
 * This pins the part that differed rather than the whole implementation.
 */
test("retries match the published client", () => {
  const published = readFileSync(join(root, "packages/ghosttea-client/src/endpoints.ts"), "utf8");

  const grace = published.match(/MISSING_GRACE_MS\s*=\s*(\d+)/);
  assert.ok(grace, "the published client no longer declares MISSING_GRACE_MS");
  assert.equal(
    Number(grace[1]),
    MISSING_GRACE_MS,
    "an unpublished endpoint is retried for a different grace here than in the published client",
  );

  for (const code of ["EBUSY", "ENOENT"]) {
    assert.ok(published.includes(`"${code}"`), `the published client no longer handles ${code}`);
  }
});
