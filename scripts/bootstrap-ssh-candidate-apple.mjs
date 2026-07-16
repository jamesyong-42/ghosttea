import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const lock = JSON.parse(readFileSync(join(root, "native/ssh.lock.json"), "utf8"));
const developerDir = process.env.DEVELOPER_DIR ?? "/Applications/Xcode.app/Contents/Developer";
const commandEnvironment = { ...process.env, DEVELOPER_DIR: developerDir };

function capture(command, args, cwd = root) {
  const result = spawnSync(command, args, { cwd, env: commandEnvironment, encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr || `${command} failed`);
  return result.stdout.trim();
}

function run(command, args, cwd = root) {
  const result = spawnSync(command, args, { cwd, env: commandEnvironment, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function ensurePinnedCheckout(name, specification) {
  const destination = join(root, `native/vendor/${name}`);
  if (!existsSync(join(destination, ".git"))) {
    mkdirSync(destination, { recursive: true });
    run("git", ["init"], destination);
    run("git", ["remote", "add", "origin", specification.repository], destination);
  }
  const head = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: destination,
    env: commandEnvironment,
    encoding: "utf8",
  });
  if (head.status !== 0 || head.stdout.trim() !== specification.commit) {
    run("git", ["fetch", "--depth=1", "origin", specification.commit], destination);
    run("git", ["checkout", "--detach", specification.commit], destination);
  }
  if (capture("git", ["rev-parse", "HEAD"], destination) !== specification.commit) {
    throw new Error(`${name} must be at ${specification.commit}`);
  }
  if (capture("git", ["status", "--porcelain"], destination) !== "") {
    throw new Error(`${name} has local changes; refusing a non-reproducible build.`);
  }
}

if (process.platform !== "darwin" || process.arch !== lock.appleBuilder.architecture) {
  throw new Error(`The SSH candidate bootstrap requires macOS ${lock.appleBuilder.architecture}.`);
}

capture("xcodebuild", ["-version"]);
capture("xcrun", ["--sdk", "iphoneos", "--show-sdk-path"]);
capture("xcrun", ["--sdk", "iphonesimulator", "--show-sdk-path"]);
capture("cmake", ["--version"]);
capture("perl", ["-v"]);
mkdirSync(join(root, "native/vendor"), { recursive: true });
ensurePinnedCheckout("openssl", lock.openssl);
ensurePinnedCheckout("libssh2", lock.libssh2);

console.log(`SSH candidate sources ready: OpenSSL ${lock.openssl.tag} and libssh2 ${lock.libssh2.tag}.`);
