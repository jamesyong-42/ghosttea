import { spawn } from "node:child_process";
import { resolve } from "node:path";
import electron from "electron";

const profiles = process.argv.slice(2);
const pattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

if (profiles.length < 2 || profiles.some((profile) => !pattern.test(profile))) {
  console.error("Usage: npm run dev:peers -- <profile> <profile> [profile ...]");
  console.error("Provide at least two profile names using letters, numbers, dots, underscores, or hyphens.");
  process.exitCode = 2;
} else if (new Set(profiles).size !== profiles.length) {
  console.error("Every Ghosttea peer must use a distinct profile name.");
  process.exitCode = 2;
} else {
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const build = spawn(npm, ["run", "build", "--workspace", "ghosttea-demo"], {
    stdio: "inherit",
  });
  const buildCode = await new Promise((resolveExit, reject) => {
    build.once("error", reject);
    build.once("exit", (code, signal) => resolveExit(signal ? 1 : (code ?? 1)));
  }).catch((error) => {
    console.error(`Could not build Ghosttea: ${error.message}`);
    return 1;
  });

  if (buildCode !== 0) {
    process.exitCode = buildCode;
  } else {
    const children = new Set();
    const baseEnvironment = { ...process.env };
    delete baseEnvironment.ELECTRON_RENDERER_URL;
    let shuttingDown = false;

    const stopChildren = (signal = "SIGTERM") => {
      if (shuttingDown) return;
      shuttingDown = true;
      for (const child of children) child.kill(signal);
    };

    for (const profile of profiles) {
      const child = spawn(electron, [resolve("apps/desktop")], {
        env: { ...baseEnvironment, GHOSTTEA_PROFILE: profile },
        stdio: "inherit",
      });
      children.add(child);
      child.once("error", (error) => {
        console.error(`Could not start Ghosttea profile "${profile}": ${error.message}`);
        process.exitCode = 1;
        stopChildren();
      });
      child.once("exit", (code, signal) => {
        children.delete(child);
        if (!signal && code) process.exitCode = code;
      });
    }

    process.once("SIGINT", () => stopChildren("SIGINT"));
    process.once("SIGTERM", () => stopChildren("SIGTERM"));
  }
}
