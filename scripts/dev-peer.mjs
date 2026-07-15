import { spawn } from "node:child_process";

const [profile, ...extra] = process.argv.slice(2);
const pattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

if (!profile || extra.length || !pattern.test(profile)) {
  console.error("Usage: npm run dev:peer -- <profile>");
  console.error("Profile names must use 1-64 letters, numbers, dots, underscores, or hyphens.");
  process.exitCode = 2;
} else {
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const child = spawn(npm, ["run", "dev", "--workspace", "ghosttea-demo"], {
    env: { ...process.env, GHOSTTEA_PROFILE: profile },
    stdio: "inherit",
  });
  child.once("error", (error) => {
    console.error(`Could not start Ghosttea profile "${profile}": ${error.message}`);
    process.exitCode = 1;
  });
  child.once("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exitCode = code ?? 1;
  });
}
